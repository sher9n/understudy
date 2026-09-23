import { db, id, now, round8, usd } from './db/index.js';
import config, { canBill, stripeMode } from './config.js';
import { addActivity } from './traffic.js';
import { enqueue } from './jobs.js';
import { limitsFor } from './workspace.js';
import { notify } from './notify.js';

const DAY = 86400000;

/* `x` is whatever should run the query: the pool by default, or an open transaction when
   the caller already has one. Without it a helper called inside a transaction would quietly
   run on a second connection, outside it, and a rollback would not take it back. */
export async function account(workspaceId, x = db) {
  let row = await x.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').get(workspaceId);
  if (!row) {
    await x.prepare(`INSERT INTO billing_accounts (workspace_id, balance_usd, auto_topup, updated_at)
                     VALUES (?, 0, 0, ?) ON CONFLICT (workspace_id) DO NOTHING`).run(workspaceId, now());
    row = await x.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').get(workspaceId);
  }
  return row;
}

/** Every movement of money is a ledger row, and the balance is never written without one. */
export async function move(workspaceId, { kind, amountUsd, note = null, ref = null }, outer = null) {
  const body = async (x) => {
    const acct = await account(workspaceId, x);
    if (ref && await x.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(ref)) {
      return { ok: true, duplicate: true, balance: acct.balance_usd };
    }
    /* The balance moves in one statement, from whatever it is at that moment. It used to be read,
       added to here and written back, which loses money whenever two moves overlap, and they
       do: measurements run side by side and every live call is charged as it finishes. Twenty
       $1 charges landing together moved a balance by $6. The statement also locks the row until
       this transaction ends, so the ledger row below records the balance this move produced. */
    const r = await x.prepare(
      `UPDATE billing_accounts SET balance_usd = ROUND((balance_usd + ?)::numeric, 8)::double precision,
              updated_at = ? WHERE workspace_id = ? RETURNING balance_usd`).run(amountUsd, now(), workspaceId);
    const after = r.rows[0].balance_usd;
    await x.prepare(`INSERT INTO ledger (id, workspace_id, kind, amount_usd, balance_after, note, ref, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('led'), workspaceId, kind, round8(amountUsd), after, note, ref, now());
    return { ok: true, balance: after };
  };
  // join the caller's transaction when there is one, otherwise open our own
  if (outer) return body(outer);
  try {
    return await db.tx(body);
  } catch (err) {
    /* Two moves with the same reference arriving at once both pass the check above, and the
       second is refused by the ledger's unique reference, which rolls its balance change back
       with it. That is a duplicate, the same answer the check gives, not a failure. */
    if (ref && err?.code === '23505') {
      return { ok: true, duplicate: true, balance: (await account(workspaceId)).balance_usd };
    }
    throw err;
  }
}

/** The first routed call has to work before any card exists, so a small credit is granted once. */
export async function grantStarterCredit(workspaceId) {
  if (config.STARTER_CREDIT_USD <= 0) return false;
  const already = await db.prepare(`SELECT 1 FROM ledger WHERE workspace_id = ? AND kind = 'starter'`).get(workspaceId);
  if (already) return false;
  await move(workspaceId, {
    kind: 'starter', amountUsd: config.STARTER_CREDIT_USD,
    note: `${usd(config.STARTER_CREDIT_USD).toFixed(2)} of credit so your first calls work straight away`,
    ref: `starter:${workspaceId}`,
  });
  return true;
}

/* Money set aside for work in flight ------------------------------------------------

   A call is paid for after it is answered, because only then is its cost known. Checked and paid
   as two separate steps, every call arriving at the same moment saw the same balance and all of
   them went through: a wallet holding five cents answered sixty calls at once and ended twenty
   cents below zero, and with expensive models there was no limit at all.

   So a call first sets aside what it could cost, in one step that also checks there is room, and
   gives back what it did not use once it is answered. Calls arriving together each take their own
   share of what is free, and the ones that do not fit are refused before anything is sent.

   When nothing else is in flight and less is free than a call could cost, the call may take what
   is left: somebody spending their balance down one call at a time is never stopped a call early,
   and at most one call's overrun can land below zero, never sixty. A hold its process never came
   back for lapses on its own, so a crash cannot freeze anybody's balance. */

const HOLD_TTL_MS = () => Math.max(5, config.HOLD_TTL_MIN) * 60000;

/** What can be spent right now: the balance, less what calls in flight have set aside. */
export async function available(workspaceId, x = db) {
  const acct = await account(workspaceId, x);
  const held = await x.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS s, COUNT(*) AS n FROM balance_holds
      WHERE workspace_id = ? AND expires_at > ?`).get(workspaceId, now());
  return { balance: acct.balance_usd, held: Number(held.s), inFlight: Number(held.n),
    free: round8(acct.balance_usd - Number(held.s)) };
}

/** Set aside up to `amountUsd` for one piece of work. Answers { ok, holdId, amount } or { ok: false, free }. */
export async function hold(workspaceId, amountUsd, purpose) {
  const want = round8(Math.max(0, Number(amountUsd) || 0));
  return await db.tx(async (tx) => {
    await account(workspaceId, tx);
    // the row lock is what makes two holds arriving together take turns
    await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(workspaceId);
    const a = await available(workspaceId, tx);
    let take = null;
    if (a.free >= want && a.free > 0) take = want;
    else if (a.inFlight === 0 && a.free > 0) take = a.free;
    if (take === null) return { ok: false, free: a.free, inFlight: a.inFlight };
    const holdId = id('hold');
    await tx.prepare(`INSERT INTO balance_holds (id, workspace_id, amount_usd, purpose, created_at, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?)`).run(holdId, workspaceId, round8(take), purpose, now(), now() + HOLD_TTL_MS());
    return { ok: true, holdId, amount: round8(take) };
  });
}

/** Give a hold back without charging anything, when the work did not happen. */
export async function release(holdId) {
  if (!holdId) return;
  await db.prepare('DELETE FROM balance_holds WHERE id = ?').run(holdId);
}

/** Holds long past their time, from processes that never came back for them. */
export async function sweepHolds() {
  return (await db.prepare('DELETE FROM balance_holds WHERE expires_at < ?').run(now() - DAY)).changes;
}

/* What a call could cost before it is sent: its prompt as sent, and the longest answer it allows. A
   prompt is counted at three characters a token, which overcounts ordinary text a little, and an
   answer with no cap is counted at a generous default. Only ever used to set money aside. */
export function worstCaseTokens(body) {
  const text = JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.tools ?? []);
  const pin = Math.ceil(text.length / 3);
  const cap = Number(body?.max_completion_tokens ?? body?.max_tokens);
  const pout = Number.isFinite(cap) && cap > 0 ? Math.min(cap, config.HOLD_MAX_OUTPUT_TOKENS)
    : config.HOLD_DEFAULT_OUTPUT_TOKENS;
  return { pin, pout };
}

/** Can this workspace make a routed call right now? A quick check before the hold is taken. */
export async function gateRouting(workspaceId) {
  const a = await available(workspaceId);
  if (!(a.free > 0)) {
    return {
      ok: false, code: 'no_balance',
      message: a.balance > 0
        ? 'Your balance is set aside for calls still in flight. Add credit, or try again in a moment.'
        : 'Your balance is empty. Add credit in Settings and calls resume immediately.',
    };
  }
  /* The workspace's own ceilings on what its calls may cost through us, days and months told in IST.
     A limit reached refuses calls rather than spending past it, and says when they resume. */
  const lim = await limitsFor(workspaceId);
  if (lim.dailyLimit !== null || lim.monthlyLimit !== null) {
    const spent = await spentOnCalls(workspaceId);
    if (lim.dailyLimit !== null && spent.day >= lim.dailyLimit) {
      tellLimit(workspaceId, 'day', spent.dayStart, lim.dailyLimit);
      return { ok: false, code: 'daily_limit', limit: lim.dailyLimit, spent: spent.day,
        message: `Your daily limit of $${lim.dailyLimit.toFixed(2)} is reached. Calls resume at midnight IST, or raise the limit in Settings.` };
    }
    if (lim.monthlyLimit !== null && spent.month >= lim.monthlyLimit) {
      tellLimit(workspaceId, 'month', spent.monthStart, lim.monthlyLimit);
      return { ok: false, code: 'monthly_limit', limit: lim.monthlyLimit, spent: spent.month,
        message: `Your monthly limit of $${lim.monthlyLimit.toFixed(2)} is reached. Calls resume on the 1st (IST), or raise the limit in Settings.` };
    }
  }
  return { ok: true, balance: a.balance };
}

/* What this workspace's calls have cost through us today and this month, days and months told in IST.
   Read from the ledger at most every fifteen seconds, and kept up to date between readings by every
   charge made here, so a burst of calls cannot run far past a limit while the reading waits. */
const IST = 5.5 * 3600000;
const istDayStart = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const istMonthStart = (t) => { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST; };
const spendMemo = new Map();
export async function spentOnCalls(workspaceId) {
  const t = now();
  const day = istDayStart(t);
  const month = istMonthStart(t);
  const hit = spendMemo.get(workspaceId);
  if (hit && Date.now() - hit.at < 15000 && hit.dayStart === day && hit.monthStart === month) return hit;
  const r = await db.prepare(
    `SELECT COALESCE(-SUM(amount_usd) FILTER (WHERE created_at >= ?), 0) AS day,
            COALESCE(-SUM(amount_usd), 0) AS month
       FROM ledger WHERE workspace_id = ? AND kind = 'call' AND created_at >= ?`).get(day, workspaceId, Math.min(day, month));
  const v = { at: Date.now(), dayStart: day, monthStart: month, day: round8(Number(r?.day || 0)), month: round8(Number(r?.month || 0)) };
  spendMemo.set(workspaceId, v);
  if (spendMemo.size > 5000) spendMemo.clear();
  return v;
}
/* A limit reached is told once a period, by email as well as on every refused call, and never waits
   on the email: the refusal answers at once. */
const told = new Set();
function tellLimit(workspaceId, period, start, limit) {
  const key = `${workspaceId}:${period}:${start}`;
  if (told.has(key)) return;
  told.add(key);
  if (told.size > 10000) told.clear();
  notify(workspaceId, 'money', `limit:${period}:${start}`, {
    title: `Your ${period === 'day' ? 'daily' : 'monthly'} limit of $${limit.toFixed(2)} is reached`,
    lines: [
      `Calls through Understudy are refused until ${period === 'day' ? 'midnight IST' : 'the 1st of next month (IST)'}, so nothing is spent past the limit you set.`,
      'Raise or remove the limit in Settings and calls resume at once.',
    ],
    path: '/settings', linkText: 'Open Settings',
  }).catch(() => {});
}

const noteSpend = (workspaceId, amount) => {
  const hit = spendMemo.get(workspaceId);
  if (hit) { hit.day = round8(hit.day + amount); hit.month = round8(hit.month + amount); }
};

/* The monthly plan's measuring allowance ---------------------------------------------

   The plan includes a sum of measurement each month. It used to be counted but never reset, so
   after the first $10 over an account's whole life measuring stopped for good; and it could not be
   used at all, because every measurement also needed a balance. Now it runs in 30 day periods from
   the day the plan started, is spent before the balance, and only what it does not cover comes out
   of the balance. */

const PERIOD = 30 * DAY;

/** How much of this period's allowance is left, rolling the period forward when one has passed. */
export async function allowanceLeft(workspaceId, x = db) {
  const acct = await account(workspaceId, x);
  if (acct.plan_status !== 'active') return 0;
  let start = acct.allowance_period_start;
  if (!start) {
    start = now();
    await x.prepare('UPDATE billing_accounts SET allowance_period_start = ?, eval_used_usd = 0 WHERE workspace_id = ?')
      .run(start, workspaceId);
    return round8(config.EVAL_ALLOWANCE_USD);
  }
  if (now() - start >= PERIOD) {
    const periods = Math.floor((now() - start) / PERIOD);
    await x.prepare(`UPDATE billing_accounts SET allowance_period_start = ?, eval_used_usd = 0
                      WHERE workspace_id = ? AND allowance_period_start = ?`)
      .run(start + periods * PERIOD, workspaceId, start);
    return round8(config.EVAL_ALLOWANCE_USD);
  }
  return round8(Math.max(0, config.EVAL_ALLOWANCE_USD - Number(acct.eval_used_usd || 0)));
}

/** Can we spend the customer's money on measuring right now? Allowance first, then the balance. */
export async function gateEval(workspaceId, { estimatedUsd = 0 } = {}) {
  const left = await allowanceLeft(workspaceId);
  const a = await available(workspaceId);
  if (left + Math.max(0, a.free) >= estimatedUsd) return { ok: true, allowance: left, free: a.free };
  return {
    ok: false, code: 'no_balance',
    message: left > 0
      ? `This would cost about $${usd(estimatedUsd).toFixed(2)}: $${left.toFixed(2)} of this month's allowance is left, `
        + 'and your balance covers the rest only with a little more credit. Add credit in Settings and it starts again on its own.'
      : 'Measuring needs a little balance. Add credit in Settings and it starts again on its own.',
  };
}

/* What this workspace spent on optimizing over the last thirty days, with our fee: measurements,
   background answers and answers read in the background, the three things charged as optimizing. */
export async function optimizeSpent(workspaceId, days = 30) {
  const since = now() - days * 86400000;
  const r = await db.prepare(
    `SELECT (SELECT COALESCE(SUM(spend_usd), 0) FROM eval_runs WHERE workspace_id = ? AND created_at >= ?)
          + (SELECT COALESCE(SUM(cost_usd), 0) FROM shadow_runs WHERE workspace_id = ? AND created_at >= ?)
          + (SELECT COALESCE(SUM(cost_usd), 0) FROM graded_calls WHERE workspace_id = ? AND created_at >= ?) AS spent`)
    .get(workspaceId, since, workspaceId, since, workspaceId, since);
  return round8(Number(r?.spent || 0) * (1 + config.ROUTING_FEE_PCT / 100));
}

/** What is left of the workspace's own optimization budget, or null when it has not set one. */
export async function optimizeLeft(workspaceId) {
  const ws = await db.prepare('SELECT optimize_budget_usd FROM workspaces WHERE id = ?').get(workspaceId);
  if (ws?.optimize_budget_usd === null || ws?.optimize_budget_usd === undefined) return null;
  return round8(Math.max(0, Number(ws.optimize_budget_usd) - await optimizeSpent(workspaceId)));
}

/** What a routed call costs the customer: what the provider charged, plus the fee. */
export const withFee = (costUsd) => round8(costUsd * (1 + config.ROUTING_FEE_PCT / 100));

/** Charge a routed call, giving back what its hold set aside in the same step. */
export async function chargeCall(workspaceId, costUsd, note, { holdId = null } = {}) {
  const amount = withFee(costUsd);
  let after = null;
  await db.tx(async (tx) => {
    if (holdId) await tx.prepare('DELETE FROM balance_holds WHERE id = ?').run(holdId);
    if (amount > 0) after = (await move(workspaceId, { kind: 'call', amountUsd: -amount, note }, tx))?.balance ?? null;
  });
  /* The call that takes the balance below the top up threshold, where nothing will top it up, is
     told by email, once a day: when it runs out, every routed call stops. */
  if (after !== null && after < config.TOPUP_THRESHOLD_USD && after + amount >= config.TOPUP_THRESHOLD_USD) {
    const acct = await account(workspaceId);
    if (!acct.auto_topup || !acct.payment_method) {
      const day = Math.floor(now() / DAY);
      notify(workspaceId, 'money', `low:${day}`, {
        title: `Your Understudy balance is down to $${Math.max(0, after).toFixed(2)}`,
        lines: [
          'When it reaches zero, calls through Understudy are refused until credit is added.',
          'Add credit, or switch on automatic top ups, in Settings.',
        ],
        path: '/settings', linkText: 'Add credit',
      }).catch(() => {});
    }
  }
  if (amount > 0) noteSpend(workspaceId, amount);
  await maybeTopUp(workspaceId);
  return amount;
}

/** Measurement is charged the same way the customer's own traffic is: from the allowance first. */
export async function chargeEval(workspaceId, costUsd, note) {
  const amount = withFee(costUsd);
  if (!(amount > 0)) return 0;
  await db.tx(async (tx) => {
    await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(workspaceId);
    const left = await allowanceLeft(workspaceId, tx);
    const fromAllowance = round8(Math.min(amount, left));
    const fromBalance = round8(amount - fromAllowance);
    if (fromAllowance > 0) {
      await tx.prepare('UPDATE billing_accounts SET eval_used_usd = eval_used_usd + ? WHERE workspace_id = ?')
        .run(fromAllowance, workspaceId);
    }
    if (fromBalance > 0) {
      await move(workspaceId, {
        kind: 'eval', amountUsd: -fromBalance,
        note: fromAllowance > 0 ? `${note} ($${fromAllowance.toFixed(4)} from this month's allowance)` : note,
      }, tx);
    }
  });
  return amount;
}

export async function ledger(workspaceId, limit = 20, { before = null } = {}) {
  return await db.prepare(
    `SELECT id, kind, amount_usd, balance_after, note, created_at FROM ledger
      WHERE workspace_id = ? ${before ? 'AND created_at < ?' : ''}
      ORDER BY created_at DESC LIMIT ?`).all(...(before ? [workspaceId, before, limit] : [workspaceId, limit]));
}

/* Auto top up ------------------------------------------------------------------
   A saved card is charged off session when the balance runs low, only once the customer has
   switched it on. A failure turns the whole thing off and says so, rather than retrying into a wall. */

let stripeClient = null;
/* A client whenever there is a key at all, test or live: the webhook needs it to check a signature
   even when the payments it describes are not allowed to become balance. Whether a payment may be
   TAKEN is canBill's question, asked where money moves. */
export async function stripe() {
  if (stripeMode() === 'off') return null;
  if (!stripeClient) {
    const { default: Stripe } = await import('stripe');
    /* Pinned on purpose. Without this the SDK uses whatever was current when the PACKAGE was
       released, so a routine dependency bump would silently move us to a different API and
       change how money behaves. Moving this is a decision, made by editing this line. */
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: config.STRIPE_API_VERSION });
  }
  return stripeClient;
}

/** How much one automatic top up adds for this workspace. */
export const topUpAmountOf = (acct) => {
  const own = Number(acct?.topup_amount_usd);
  return Number.isFinite(own) && own > 0 ? own : config.TOPUP_AMOUNT_USD;
};

export async function maybeTopUp(workspaceId) {
  const acct = await account(workspaceId);
  if (!acct.auto_topup || !acct.payment_method || !canBill()) return false;
  if (acct.balance_usd >= config.TOPUP_THRESHOLD_USD) return false;
  // ahead of anything already waiting: a balance about to run dry stops every routed call
  await enqueue('topup', { workspaceId }, { unique: true, runAfter: now() - 3600000 });
  return true;
}

export async function runTopUp(workspaceId) {
  const s = await stripe();
  const acct = await account(workspaceId);
  if (!s || !canBill() || !acct.payment_method || !acct.stripe_customer || !acct.auto_topup) return { ok: false, code: 'no_card' };
  if (acct.balance_usd >= config.TOPUP_THRESHOLD_USD) return { ok: true, skipped: 'balance is fine' };
  /* A ceiling on automatic top ups a day, so a workload whose calls outrun any amount cannot keep
     charging a card in a loop. It says so, once, and the customer decides. */
  const today = Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM ledger WHERE workspace_id = ? AND kind = 'credit' AND note = 'Automatic top up'
        AND created_at > ?`).get(workspaceId, now() - DAY))?.n ?? 0);
  if (today >= config.TOPUP_MAX_PER_DAY) {
    const said = await db.prepare(`SELECT 1 FROM activity WHERE workspace_id = ? AND title = 'Automatic top ups paused for today'
                                     AND created_at > ?`).get(workspaceId, now() - DAY);
    if (!said) {
      await addActivity(workspaceId, {
        kind: 'bill', title: 'Automatic top ups paused for today',
        detail: `${config.TOPUP_MAX_PER_DAY} automatic top ups ran in the last day, which is the most we make without you. `
          + 'Add credit in Settings, or raise the top up amount there.',
      });
    }
    return { ok: false, code: 'daily_cap' };
  }
  const amount = topUpAmountOf(acct);
  /* The key is the last credit that landed. A retry of this job, or a second low balance before
     the first top up has been credited, replays the same charge instead of making a new one; once it
     has been credited the next one is new. The old key was the clock hour, which made a second top
     up within the hour replay the first one and add nothing, so a busy workload simply ran dry. */
  const lastCredit = (await db.prepare(
    `SELECT id FROM ledger WHERE workspace_id = ? AND kind = 'credit' ORDER BY created_at DESC LIMIT 1`)
    .get(workspaceId))?.id ?? 'none';
  try {
    const pi = await s.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      customer: acct.stripe_customer,
      payment_method: acct.payment_method,
      off_session: true,
      confirm: true,
      /* The webhook credits on this. Without it an automatic top up is charged to the card
         and never appears as balance, which is the worst possible half of the two. */
      metadata: { topup: '1', workspace_id: workspaceId },
    }, { idempotencyKey: `topup:${workspaceId}:${lastCredit}:${Math.round(amount * 100)}` });
    // the credit itself is written by the webhook, keyed on the intent, so it lands once
    return { ok: true, intent: pi.id };
  } catch (err) {
    const code = err?.code || err?.raw?.decline_code || 'card_declined';
    /* Stripe distinguishes "the bank wants the customer present" from "this card is no
       good". The recovery is the same screen either way, but the sentence is not, and
       telling somebody their card failed when their bank simply wanted them to confirm is
       both wrong and alarming. */
    const why = code === 'authentication_required'
      ? 'Your bank asked for you to confirm this one in person. Adding credit again takes care of it, and calls resume.'
      : 'Automatic top up is off until a card is added. Update it in Settings and calls resume.';
    await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                 WHERE workspace_id = ?`).run(code, now(), workspaceId);
    await addActivity(workspaceId, {
      kind: 'bill',
      title: code === 'authentication_required' ? 'A top up needs your confirmation' : 'A top up was declined',
      detail: why,
    });
    return { ok: false, code };
  }
}
