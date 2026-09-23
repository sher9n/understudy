import crypto from 'node:crypto';
import { db, id, now, round8, usd } from './db/index.js';
import config, { canBill, stripeMode } from './config.js';
import { addActivity } from './traffic.js';
import { enqueue } from './jobs.js';
import { limitsFor } from './workspace.js';
import { notify } from './notify.js';
import { reportCallFailure } from './alerts.js';

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
    /* A call's charge, or a correction to one, also moves the running totals the spending limits read,
       in the same statement: a limit is then checked against one row, where summing a month of ledger
       under the account's lock on every call slowed every call of a busy workspace. */
    const t = now();
    const r = kind === 'call'
      ? await x.prepare(
        `UPDATE billing_accounts SET balance_usd = ROUND((balance_usd + ?)::numeric, 8)::double precision,
                call_day_usd = ROUND((CASE WHEN call_day_start = ?::bigint THEN call_day_usd - ?::double precision
                                           WHEN call_day_start > ?::bigint THEN call_day_usd ELSE -(?::double precision) END)::numeric, 8)::double precision,
                call_day_start = GREATEST(COALESCE(call_day_start, 0), ?::bigint),
                call_month_usd = ROUND((CASE WHEN call_month_start = ?::bigint THEN call_month_usd - ?::double precision
                                             WHEN call_month_start > ?::bigint THEN call_month_usd ELSE -(?::double precision) END)::numeric, 8)::double precision,
                call_month_start = GREATEST(COALESCE(call_month_start, 0), ?::bigint),
                updated_at = ? WHERE workspace_id = ? RETURNING balance_usd`)
        .run(amountUsd, istDayStart(t), amountUsd, istDayStart(t), amountUsd, istDayStart(t),
          istMonthStart(t), amountUsd, istMonthStart(t), amountUsd, istMonthStart(t), t, workspaceId)
      : await x.prepare(
        `UPDATE billing_accounts SET balance_usd = ROUND((balance_usd + ?)::numeric, 8)::double precision,
                updated_at = ? WHERE workspace_id = ? RETURNING balance_usd`).run(amountUsd, t, workspaceId);
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
  /* The workspace's limits are read before the transaction opens. Read inside it, through the shared
     pool, a cold cache made the call holding the account's lock wait for a second connection, while
     every other call of that workspace waited on the lock with a connection of its own: ten calls at
     once could use the whole pool up and stall every request on the server. */
  const lim = purpose === 'call' ? await limitsFor(workspaceId) : null;
  return await db.tx(async (tx) => {
    await account(workspaceId, tx);
    // the row lock is what makes two holds arriving together take turns
    await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(workspaceId);
    const a = await available(workspaceId, tx);
    let take = null;
    if (a.free >= want && a.free > 0) take = want;
    else if (a.inFlight === 0 && a.free > 0) take = a.free;
    if (take === null) return { ok: false, free: a.free, inFlight: a.inFlight, want };
    /* A workspace's own ceilings on what its calls may cost count what calls in flight have set
       aside, read under the same lock. Checked only against what had already been charged, a burst
       of calls all fitted under a limit none of them had been charged against yet: forty calls at
       once spent eight times a daily limit of five cents. As with the balance, the last call of a
       period may run alone past what is left, so a limit is overrun by at most one call. */
    if (purpose === 'call') {
      const over = await overLimit(workspaceId, tx, want, a, lim);
      if (over) return { ok: false, ...over, free: a.free, inFlight: a.inFlight, want };
    }
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

/* What a call could cost before it is sent, as a bound and not a guess.

   A hold is only a promise about money if the call cannot spend more than it. It used to count an
   answer with no cap as two thousand tokens and any cap as at most thirty-two thousand, while the
   request went to the provider unchanged: twenty calls at once on fifty cents of credit each wrote
   far longer answers and left the balance three dollars below zero, paid for by us.

   So what a call is held for is the most it can cost, and the request carries what makes that true:
   - Its answer is the cap it asks for, times the answers it asks for (n). With no cap, the longest
     answer every provider it can reach publishes, when all of them do (the providers that keep
     nothing are listed one by one); otherwise the call is sent capped at the model's own longest
     answer, or at what its window has room for after the prompt, so the bound is still true.
   - Its prices are the dearest it can be charged: the dearest provider that keeps nothing where those
     are known, else the list price with a margin, and in both cases every published exception that can
     apply (a tier the prompt is long enough to reach, a dearer hour), the dearer price of pictures or
     sound written when the call asks for them, a cache write where that is dearer than a plain read,
     and a fee per request. The request tells OpenRouter never to use a provider dearer than that
     (provider.max_price, see buildUpstream), which is what makes the margin a bound.
   - What it carries beyond text is counted: a picture by address as HOLD_IMAGE_TOKENS of prompt, a PDF
     sent inline by its pages (each read as up to three thousand tokens, and at up to a quarter of a cent
     by a reader that charges per page), web search at HOLD_WEB_SEARCH_USD.
   A prompt is counted at three characters a token, which overcounts ordinary text. Only ever used to
   set money aside. */

const PDF_PAGE_TOKENS = 3000;
const PDF_PAGE_USD = 0.0025;
const pdfMemo = new Map();

/* How many pages a PDF sent inline has, read with a real parser: a page can be a couple of hundred
   bytes, so no count of bytes is a bound. One that cannot be read is counted at a page per hundred
   bytes, which no real PDF comes near. */
async function pdfPages(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  const key = crypto.createHash('sha1').update(b64).digest('hex');
  if (pdfMemo.has(key)) return pdfMemo.get(key);
  const bytes = Buffer.from(b64, 'base64');
  let pages;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    pages = Math.max(1, doc.getPageCount());
  } catch {
    pages = Math.max(1, Math.ceil(bytes.length / 100));
  }
  pdfMemo.set(key, pages);
  if (pdfMemo.size > 200) pdfMemo.delete(pdfMemo.keys().next().value);
  return pages;
}

export async function callShape(body) {
  const text = JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.tools ?? []);
  const pin = Math.ceil(text.length / 3);
  const raw = Number(body?.max_completion_tokens ?? body?.max_tokens);
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  const n = Math.max(1, Math.min(128, Math.floor(Number(body?.n) || 1)));
  let images = 0;
  let pages = 0;
  let otherFileChars = 0;
  let longCache = false;
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    for (const p of Array.isArray(m?.content) ? m.content : []) {
      if (p?.type === 'image_url') {
        const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
        if (typeof u === 'string' && !u.startsWith('data:')) images += 1;
      }
      const data = p?.type === 'file' ? p.file?.file_data : null;
      if (typeof data === 'string' && data.startsWith('data:')) {
        if (/^data:application\/pdf/i.test(data)) pages += await pdfPages(data);
        else otherFileChars += data.length;
      }
      if (p?.cache_control?.ttl === '1h') longCache = true;
    }
  }
  const on = (p) => p && p.enabled !== false;
  const web = (Array.isArray(body?.plugins) && body.plugins.some((p) => on(p) && p.id === 'web'))
    || !!body?.web_search_options || /:online$/i.test(String(body?.model || ''));
  const wants = Array.isArray(body?.modalities) ? body.modalities.map((x) => String(x).toLowerCase()) : [];
  return {
    pin, cap, n, longCache,
    outputs: wants.filter((x) => x === 'image' || x === 'audio'),
    extraIn: images * config.HOLD_IMAGE_TOKENS + pages * PDF_PAGE_TOKENS,
    extraUsd: (web ? config.HOLD_WEB_SEARCH_USD : 0) + pages * PDF_PAGE_USD + otherFileChars * 1.5e-6,
  };
}

/* A model's own id without the variant OpenRouter reads after a colon (":nitro", ":online"): the
   catalogue lists the model once, and a variant is priced as the model. */
export const baseModelId = (modelId) => String(modelId || '').replace(/:[a-z0-9._-]+$/i, '');

const priceOf = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/* The dearest one listing can charge for this call. A long-prompt tier counts when the prompt could
   reach it (the prompt is overcounted, so a prompt near the threshold does); an hour's price always
   counts, since the call can be billed at whatever hour it ends. */
function dearestOf(row, { pin, outputs, longCache }) {
  let pricing = {};
  try { pricing = JSON.parse(row.pricing_json || '{}') || {}; } catch { pricing = {}; }
  let overrides = [];
  try { overrides = JSON.parse(row.overrides_json || '[]') || []; } catch { overrides = []; }
  let prompt = priceOf(row.price_in);
  let completion = priceOf(row.price_out);
  for (const o of Array.isArray(overrides) ? overrides : []) {
    const reachable = o?.min_prompt_tokens == null || pin >= Number(o.min_prompt_tokens);
    if (!reachable) continue;
    prompt = Math.max(prompt, priceOf(o.prompt));
    completion = Math.max(completion, priceOf(o.completion));
  }
  // writing to a cache costs more than a plain read: what the listing says, or a quarter more (twice for an hour)
  const write = Math.max(priceOf(pricing.input_cache_write), prompt * (longCache ? 2 : 1.25));
  let out = completion;
  if (outputs.includes('image')) out = Math.max(out, priceOf(pricing.image_output), priceOf(pricing.image_token));
  if (outputs.includes('audio')) out = Math.max(out, priceOf(pricing.audio_output), priceOf(pricing.audio));
  return { prompt, write, out, request: priceOf(pricing.request) };
}

/** The most one call can cost on one model, or null when the model is not in the catalogue. */
export async function callBound(modelId, shape, { zdr = true } = {}) {
  const { pin, cap, n = 1, extraIn = 0, extraUsd = 0, longCache = false, outputs = [] } = shape;
  const wanted = String(modelId || '');
  const base = baseModelId(wanted);
  // the listing under the exact name first (a model sold only as a variant), else the model it varies
  const m = await db.prepare(
    `SELECT model_id, price_in, price_out, context_len, max_output, overrides_json, pricing_json FROM models_catalog
      WHERE model_id = ANY(?::text[]) ORDER BY (model_id = ?) DESC LIMIT 1`).get([wanted, base], wanted);
  if (!m) return null;
  const opts = { pin, outputs, longCache };
  let d = dearestOf(m, opts);
  let margin = config.HOLD_PRICE_MULTIPLE;
  let window = Number(m.context_len) > 0 ? Number(m.context_len) : null;
  /* With zero retention required, every provider the call can reach is listed with its own prices and
     limits: the dearest of them is the bound (no margin), and the longest answer is theirs when every
     one publishes one. Otherwise the call can reach providers we know nothing about: the list price
     with a margin, which the request's price ceiling then enforces, and a cap sent with the request. */
  let everyLimit = null;
  if (zdr) {
    const rows = await db.prepare(
      `SELECT price_in, price_out, max_output, context_len, overrides_json, pricing_json FROM model_endpoints
        WHERE model_id = ?`).all(m.model_id);
    if (rows.length) {
      margin = 1;
      let every = true;
      let longest = 0;
      for (const r of rows) {
        const e = dearestOf(r, opts);
        d = { prompt: Math.max(d.prompt, e.prompt), write: Math.max(d.write, e.write), out: Math.max(d.out, e.out), request: Math.max(d.request, e.request) };
        if (Number(r.max_output) > 0) longest = Math.max(longest, Number(r.max_output)); else every = false;
        if (Number(r.context_len) > 0) window = Math.max(window || 0, Number(r.context_len));
      }
      if (every && longest > 0) everyLimit = longest;
    }
  }
  /* The longest answer: a cap the request names is kept as it is. Otherwise, where every provider
     publishes its longest answer, that holds by itself (known). Else the call must be sent capped:
     at the model's own longest answer, or at what its window has room for after the prompt. */
  let each;
  let known = true;
  if (cap !== null) {
    each = cap;
  } else if (everyLimit !== null) {
    each = everyLimit;
  } else {
    known = false;
    const room = window ? Math.max(16, window - pin) : null;
    const own = Number(m.max_output) > 0 ? Number(m.max_output) : null;
    each = Math.min(own ?? room ?? config.HOLD_MAX_OUTPUT_TOKENS, room ?? Infinity);
  }
  const usd = ((pin + extraIn) * d.write + each * n * d.out) * margin + d.request * margin * n + extraUsd;
  // the most a provider may charge on this call, per token, as OpenRouter is told (provider.max_price)
  const caps = { prompt: d.write * margin, completion: d.out * margin, request: d.request * margin };
  return { usd, each, known, caps };
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

/* What this workspace's calls have cost through us today and this month, days and months told in IST:
   the running totals every call charge moves (see move), read from one row. */
const IST = 5.5 * 3600000;
const istDayStart = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const istMonthStart = (t) => { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST; };
export async function spentOnCalls(workspaceId, x = db) {
  const t = now();
  const day = istDayStart(t);
  const month = istMonthStart(t);
  const r = await x.prepare(
    'SELECT call_day_start, call_day_usd, call_month_start, call_month_usd FROM billing_accounts WHERE workspace_id = ?').get(workspaceId);
  return {
    dayStart: day, monthStart: month,
    day: r && Number(r.call_day_start) === day ? round8(Number(r.call_day_usd || 0)) : 0,
    month: r && Number(r.call_month_start) === month ? round8(Number(r.call_month_usd || 0)) : 0,
  };
}
/* The running totals, read again from the ledger, for every workspace that has a limit: a process that
   predates them (the old one, during a deploy) charged without moving them. Run hourly and a few minutes
   after boot. Each row is set under its own lock, so a charge landing meanwhile is not lost. */
export async function reconcileLimitTotals() {
  const t = now();
  const day = istDayStart(t);
  const month = istMonthStart(t);
  const rows = await db.prepare(
    `SELECT workspace_id FROM billing_accounts a JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.daily_limit_usd IS NOT NULL OR w.monthly_limit_usd IS NOT NULL`).all();
  let fixed = 0;
  for (const { workspace_id: ws } of rows) {
    await db.tx(async (tx) => {
      await tx.prepare('SELECT 1 FROM billing_accounts WHERE workspace_id = ? FOR UPDATE').get(ws);
      const r = await tx.prepare(
        `SELECT COALESCE(-SUM(amount_usd) FILTER (WHERE created_at >= ?), 0) AS day, COALESCE(-SUM(amount_usd), 0) AS month
           FROM ledger WHERE workspace_id = ? AND kind = 'call' AND created_at >= ?`).get(day, ws, Math.min(day, month));
      fixed += (await tx.prepare(
        `UPDATE billing_accounts SET call_day_start = ?, call_day_usd = ?, call_month_start = ?, call_month_usd = ?
          WHERE workspace_id = ?`).run(day, round8(Number(r?.day || 0)), month, round8(Number(r?.month || 0)), ws)).changes;
    });
  }
  return fixed;
}

/* Whether one more call would take the workspace past its own daily or monthly limit, counting what
   has been charged and what calls in flight have set aside, read inside the hold's lock. */
async function overLimit(workspaceId, x, want, a, lim) {
  if (!lim || (lim.dailyLimit === null && lim.monthlyLimit === null)) return null;
  const spent = await spentOnCalls(workspaceId, x);
  const h = await x.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM balance_holds
      WHERE workspace_id = ? AND purpose = 'call' AND expires_at > ?`).get(workspaceId, now());
  const held = Number(h?.s || 0);
  const periods = [
    ['day', lim.dailyLimit, spent.day, spent.dayStart],
    ['month', lim.monthlyLimit, spent.month, spent.monthStart],
  ];
  for (const [period, limit, used, start] of periods) {
    if (limit === null) continue;
    const committed = used + held;
    if (committed + want <= limit) continue;
    // nothing else in flight and something left: the last call of the period runs alone
    if (a.inFlight === 0 && committed < limit) continue;
    const reached = used >= limit;
    if (reached) tellLimit(workspaceId, period, start, limit);
    const when = period === 'day' ? 'at midnight IST' : 'on the 1st (IST)';
    const which = period === 'day' ? 'daily' : 'monthly';
    let message;
    if (reached) {
      message = `Your ${which} limit of $${limit.toFixed(2)} is reached. Calls resume ${when}, or raise the limit in Settings.`;
    } else if (used + want > limit) {
      // this call alone is more than is left, whatever else is in flight
      message = `This call could cost up to $${want.toFixed(2)}, more than the $${Math.max(0, limit - used).toFixed(2)} left of your ${which} `
        + `limit, so it can only run when no other call is in flight. Setting max_tokens on it sets aside less, or raise the limit in Settings.`;
    } else {
      message = `Calls in flight have set aside what is left of your ${which} limit of $${limit.toFixed(2)}. `
        + 'Try again in a moment, send fewer calls at once, or raise the limit in Settings.';
    }
    return { code: period === 'day' ? 'daily_limit' : 'monthly_limit', limit, spent: used, message };
  }
  return null;
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

/* A page of the ledger, newest first. Paged by time and then id, so two movements made in the same
   millisecond, which a charge and the hold it gives back can be, are never split across a page and lost. */
export async function ledger(workspaceId, limit = 20, { before = null, beforeId = null } = {}) {
  if (before && beforeId) {
    return await db.prepare(
      `SELECT id, kind, amount_usd, balance_after, note, created_at FROM ledger
        WHERE workspace_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(workspaceId, before, before, beforeId, limit);
  }
  return await db.prepare(
    `SELECT id, kind, amount_usd, balance_after, note, created_at FROM ledger
      WHERE workspace_id = ? ${before ? 'AND created_at < ?' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...(before ? [workspaceId, before, limit] : [workspaceId, limit]));
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

/* Whose problem a Stripe error is. The card's (declined, expired, the bank wants the customer there,
   the saved card has gone): automatic top up goes off and the owner is told. Passing (Stripe down or
   busy, the network, two tries at once): tried again later. Ours (our key, our permissions, a request we
   built wrong): never the customer's card, so we are alerted and the customer is left alone. */
export function stripeErrorKind(err) {
  const type = err?.type || err?.rawType || '';
  const code = err?.code || err?.raw?.code || '';
  /* A decline Stripe says to try again (the issuer was out of reach, a processing error, try again
     later) is passing, not the card's fault. */
  const decline = err?.raw?.decline_code || err?.decline_code || '';
  if (['processing_error', 'try_again_later', 'issuer_not_available', 'reenter_transaction', 'approve_with_id'].includes(decline)
    || code === 'processing_error') return 'retry';
  if (type === 'StripeCardError' || code === 'authentication_required' || decline) return 'card';
  if (['card_declined', 'expired_card', 'payment_intent_authentication_failure', 'payment_method_unexpected_state',
    'payment_method_not_available'].includes(code)) return 'card';
  if (code === 'resource_missing' && /payment_method/.test(String(err?.param || err?.raw?.param || ''))) return 'card';
  if (['StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError', 'StripeIdempotencyError'].includes(type)
    || ['idempotency_key_in_use', 'lock_timeout', 'rate_limit'].includes(code)
    || Number(err?.statusCode) === 429 || Number(err?.statusCode) >= 500) return 'retry';
  return 'ours';
}

/* The last try of a top up job failed for a reason that is not the card. Automatic top up is paused, so
   the low balance email is no longer held back behind it, and its owner is told once for this low balance
   (keyed on the last credit), however many jobs later give up the same way. We are told as well. */
export async function giveUpTopUp(workspaceId, err) {
  reportCallFailure({ kind: 'automatic top up', model: 'stripe', status: Number(err?.statusCode) || 0,
    message: `gave up after 5 tries: ${err?.message || err}`, workspaceId });
  const paused = (await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = 'unreachable', updated_at = ?
      WHERE workspace_id = ? AND auto_topup = 1 RETURNING workspace_id`).run(now(), workspaceId)).rows.length > 0;
  if (!paused) return false;
  const last = (await db.prepare(
    `SELECT id FROM ledger WHERE workspace_id = ? AND kind = 'credit' ORDER BY created_at DESC LIMIT 1`).get(workspaceId))?.id ?? 'none';
  await addActivity(workspaceId, {
    kind: 'bill', title: 'Automatic top up paused',
    detail: 'We could not reach the card processor after trying five times. Switch it back on in Settings to try again.',
  });
  await notify(workspaceId, 'money', `topup-gaveup:${workspaceId}:${last}`, {
    title: 'Automatic top up is paused',
    lines: [
      'We could not reach the card processor to top up your balance, after trying five times, so automatic top up is paused.',
      'Calls through Understudy stop when the balance runs out. Add credit, or switch automatic top up back on, in Settings.',
    ],
    path: '/settings', linkText: 'Open Settings',
  }).catch(() => {});
  return true;
}

export async function runTopUp(workspaceId, { attempt = 0 } = {}) {
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
  const last = await db.prepare(
    `SELECT id, created_at FROM ledger WHERE workspace_id = ? AND kind = 'credit' ORDER BY created_at DESC LIMIT 1`)
    .get(workspaceId);
  const lastCredit = last?.id ?? 'none';
  /* A try that failed on Stripe's side may still have charged the card, and a second low balance can
     book a second job before the first payment lands. Stripe keeps the answer it gave a key, even an
     error, for a day, so each try has a key of its own; and before every payment, the first try of a job
     included, Stripe is asked whether a top up since the last credit is already under way, so a card is
     never charged twice for one low balance. */
  {
    const since = Math.floor((Number(last?.created_at) || now() - DAY) / 1000);
    const recent = await s.paymentIntents.list({ customer: acct.stripe_customer, created: { gte: since }, limit: 20 });
    const going = (recent?.data || []).find((p) => p?.metadata?.topup === '1' && p?.metadata?.workspace_id === workspaceId
      && ['succeeded', 'processing', 'requires_capture'].includes(p.status));
    if (going) return { ok: true, intent: going.id, already: true };
  }
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
    }, { idempotencyKey: `topup:${workspaceId}:${lastCredit}:${Math.round(amount * 100)}:${attempt}` });
    // the credit itself is written by the webhook, keyed on the intent, so it lands once
    return { ok: true, intent: pi.id };
  } catch (err) {
    /* Only a problem with the card itself switches automatic top up off (see stripeErrorKind). A passing
       one is thrown, and the job tries again. One of ours is thrown too, after telling us: the
       customer's card is not at fault, and saying it was would be both wrong and alarming. */
    const kind = stripeErrorKind(err);
    if (kind === 'ours') {
      reportCallFailure({ kind: 'automatic top up', model: 'stripe', status: Number(err?.statusCode) || 0,
        message: `${err?.type || 'error'}: ${err?.message || err}`, workspaceId });
    }
    if (kind !== 'card') throw err;
    const code = err?.raw?.decline_code || err?.code || 'card_declined';
    // the payment Stripe made and refused, when it made one: the webhook's word about it is then the same message
    const intentId = err?.raw?.payment_intent?.id || err?.payment_intent?.id || null;
    /* Stripe distinguishes "the bank wants the customer present" from "this card is no
       good". The recovery is the same screen either way, but the sentence is not, and
       telling somebody their card failed when their bank simply wanted them to confirm is
       both wrong and alarming. */
    const why = code === 'authentication_required'
      ? 'Your bank asked for you to confirm this one in person. Adding credit again takes care of it, and calls resume.'
      : 'Automatic top up is off until a card is added. Update it in Settings and calls resume.';
    const wasOn = (await db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                 WHERE workspace_id = ? AND auto_topup = 1 RETURNING workspace_id`).run(code, now(), workspaceId)).rows.length > 0;
    // said once: the webhook about the same refused payment finds top up already off and says nothing more
    if (!wasOn) return { ok: false, code };
    await addActivity(workspaceId, {
      kind: 'bill',
      title: code === 'authentication_required' ? 'A top up needs your confirmation' : 'A top up was declined',
      detail: why,
    });
    /* Told by email too. The low balance email is skipped while automatic top up is on, so without
       this nobody heard anything until calls stopped. */
    await notify(workspaceId, 'money', `topup-failed:${intentId || `${workspaceId}:${lastCredit}`}`, {
      title: code === 'authentication_required' ? 'An automatic top up needs your confirmation' : 'An automatic top up did not go through',
      lines: [why, 'Calls through Understudy stop when the balance runs out.'],
      path: '/settings', linkText: 'Open Settings',
    }).catch(() => {});
    return { ok: false, code };
  }
}
