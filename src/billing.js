import { db, id, now, round8, usd } from './db/index.js';
import config, { canBill } from './config.js';
import { addActivity } from './traffic.js';
import { enqueue } from './jobs.js';

export function account(workspaceId) {
  let row = db.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').get(workspaceId);
  if (!row) {
    db.prepare('INSERT INTO billing_accounts (workspace_id, balance_usd, updated_at) VALUES (?, 0, ?)')
      .run(workspaceId, now());
    row = db.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').get(workspaceId);
  }
  return row;
}

/** Every movement of money is a ledger row, and the balance is never written without one. */
export function move(workspaceId, { kind, amountUsd, note = null, ref = null }) {
  return db.transaction(() => {
    const acct = account(workspaceId);
    const after = round8(acct.balance_usd + amountUsd);
    if (ref && db.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(ref)) {
      return { ok: true, duplicate: true, balance: acct.balance_usd };
    }
    db.prepare('UPDATE billing_accounts SET balance_usd = ?, updated_at = ? WHERE workspace_id = ?')
      .run(after, now(), workspaceId);
    db.prepare(`INSERT INTO ledger (id, workspace_id, kind, amount_usd, balance_after, note, ref, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('led'), workspaceId, kind, round8(amountUsd), after, note, ref, now());
    return { ok: true, balance: after };
  })();
}

/** The first routed call has to work before any card exists, so a small credit is granted once. */
export function grantStarterCredit(workspaceId) {
  const already = db.prepare(`SELECT 1 FROM ledger WHERE workspace_id = ? AND kind = 'starter'`).get(workspaceId);
  if (already || config.STARTER_CREDIT_USD <= 0) return false;
  move(workspaceId, {
    kind: 'starter', amountUsd: config.STARTER_CREDIT_USD,
    note: `${usd(config.STARTER_CREDIT_USD).toFixed(2)} of credit so your first calls work straight away`,
    ref: `starter:${workspaceId}`,
  });
  return true;
}

/** Can this workspace make a routed call right now? */
export function gateRouting(workspaceId) {
  const ws = db.prepare('SELECT mode FROM workspaces WHERE id = ?').get(workspaceId);
  if (ws?.mode === 'observe') {
    return { ok: false, code: 'observe_only', message: 'This workspace sends copies rather than routing.' };
  }
  const acct = account(workspaceId);
  if (acct.balance_usd > 0) return { ok: true, balance: acct.balance_usd };
  return {
    ok: false, code: 'no_balance',
    message: 'Your balance is empty. Add credit in Settings and calls resume immediately.',
  };
}

/** Can we spend the customer's money on measuring right now? */
export function gateEval(workspaceId, { estimatedUsd = 0 } = {}) {
  const ws = db.prepare('SELECT mode FROM workspaces WHERE id = ?').get(workspaceId);
  const acct = account(workspaceId);
  if (ws?.mode === 'observe') {
    const left = round8(config.EVAL_ALLOWANCE_USD - acct.eval_used_usd);
    if (left < estimatedUsd) {
      return {
        ok: false, code: 'allowance_spent',
        message: `This month's ${usd(config.EVAL_ALLOWANCE_USD).toFixed(2)} of measurement is used up. It resets next month.`,
      };
    }
    return { ok: true };
  }
  if (acct.balance_usd < estimatedUsd) {
    return {
      ok: false, code: 'no_balance',
      message: 'Measuring needs a little balance. Add credit in Settings and it starts again on its own.',
    };
  }
  return { ok: true };
}

/** What a routed call costs the customer: what the provider charged, plus the fee. */
export const withFee = (costUsd) => round8(costUsd * (1 + config.ROUTING_FEE_PCT / 100));

export function chargeCall(workspaceId, costUsd, note) {
  const amount = withFee(costUsd);
  move(workspaceId, { kind: 'call', amountUsd: -amount, note });
  maybeTopUp(workspaceId);
  return amount;
}

/** Measurement is charged the same way the customer's own traffic is. */
export function chargeEval(workspaceId, costUsd, note) {
  const amount = withFee(costUsd);
  db.transaction(() => {
    move(workspaceId, { kind: 'eval', amountUsd: -amount, note });
    db.prepare('UPDATE billing_accounts SET eval_used_usd = eval_used_usd + ? WHERE workspace_id = ?')
      .run(amount, workspaceId);
  })();
  return amount;
}

export function ledger(workspaceId, limit = 20) {
  return db.prepare(
    `SELECT kind, amount_usd, balance_after, note, created_at FROM ledger
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit);
}

/* Auto top up ------------------------------------------------------------------
   A saved card is charged off session when the balance runs low. A failure turns
   the whole thing off and says so, rather than retrying into a wall. */

let stripeClient = null;
export async function stripe() {
  if (!canBill()) return null;
  if (!stripeClient) {
    const { default: Stripe } = await import('stripe');
    stripeClient = new Stripe(config.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

export function maybeTopUp(workspaceId) {
  const acct = account(workspaceId);
  if (!acct.auto_topup || !acct.payment_method || !canBill()) return false;
  if (acct.balance_usd >= config.TOPUP_THRESHOLD_USD) return false;
  enqueue('topup', { workspaceId }, { unique: true });
  return true;
}

export async function runTopUp(workspaceId) {
  const s = await stripe();
  const acct = account(workspaceId);
  if (!s || !acct.payment_method || !acct.stripe_customer) return { ok: false, code: 'no_card' };
  try {
    const pi = await s.paymentIntents.create({
      amount: Math.round(config.TOPUP_AMOUNT_USD * 100),
      currency: 'usd',
      customer: acct.stripe_customer,
      payment_method: acct.payment_method,
      off_session: true,
      confirm: true,
    });
    // the credit itself is written by the webhook, keyed on the intent, so it lands once
    return { ok: true, intent: pi.id };
  } catch (err) {
    const code = err?.code || err?.raw?.decline_code || 'card_declined';
    db.prepare(`UPDATE billing_accounts SET auto_topup = 0, topup_failed_note = ?, updated_at = ?
                 WHERE workspace_id = ?`).run(code, now(), workspaceId);
    addActivity(workspaceId, {
      kind: 'bill', title: 'A top up was declined',
      detail: 'Automatic top up is off until a card is added. Update it in Settings and calls resume.',
    });
    return { ok: false, code };
  }
}
