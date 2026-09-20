/* Put an account back to never having connected.
 *
 * Everything it has ever been sent goes: calls, workloads, the shapes they were grouped by,
 * measurements, activity and the ledger. The account, its password and its keys stay, so it
 * signs in exactly as before and lands on the getting started guide again.
 *
 * Three things beyond the traffic have to go with it or the reset is only half a reset: the
 * mark that says the guide was finished, which otherwise sends them straight to an empty
 * dashboard; the balance, so they meet the same empty wallet a new customer meets; and the
 * saved card, because a card on file is a different first run entirely.
 *
 * This exists because a demo account is easy to spoil by accident: one call sent while
 * testing is enough to mark it connected, and then it goes to the dashboard for ever after.
 *
 *   node scripts/clear-traffic.js somebody@example.com
 */

import { db, now } from '../src/db/index.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Give me an email address: node scripts/clear-traffic.js somebody@example.com');
  process.exit(1);
}

const ws = await db.prepare(
  `SELECT w.id, w.name, u.email FROM workspaces w JOIN users u ON u.id = w.owner_user_id
    WHERE u.email = ?`).get(email);
if (!ws) {
  console.error(`No account for ${email}.`);
  process.exit(1);
}

const before = (await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ?').get(ws.id)).n;

await db.tx(async (tx) => {
  for (const sql of [
    'DELETE FROM eval_samples WHERE run_id IN (SELECT id FROM eval_runs WHERE workspace_id = ?)',
    'DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE workspace_id = ?)',
    'DELETE FROM eval_runs WHERE workspace_id = ?',
    'DELETE FROM promotions WHERE workload_id IN (SELECT id FROM workloads WHERE workspace_id = ?)',
    'DELETE FROM calls WHERE workspace_id = ?',
    'DELETE FROM workload_signatures WHERE workspace_id = ?',
    'DELETE FROM workloads WHERE workspace_id = ?',
    'DELETE FROM activity WHERE workspace_id = ?',
    'DELETE FROM ledger WHERE workspace_id = ?',
  ]) await tx.prepare(sql).run(ws.id);
  await tx.prepare(
    `UPDATE billing_accounts SET balance_usd = 0, eval_used_usd = 0, auto_topup = 0,
            payment_method = NULL, card_brand = NULL, card_last4 = NULL,
            stripe_customer = NULL, topup_failed_note = NULL,
            plan = NULL, plan_status = NULL, updated_at = ?
      WHERE workspace_id = ?`).run(now(), ws.id);
  await tx.prepare('UPDATE workspaces SET onboarded_at = NULL WHERE id = ?').run(ws.id);
});

const after = (await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workspace_id = ?').get(ws.id)).n;
const w = await db.prepare('SELECT onboarded_at FROM workspaces WHERE id = ?').get(ws.id);
const bal = await db.prepare('SELECT balance_usd, payment_method, card_last4 FROM billing_accounts WHERE workspace_id = ?').get(ws.id);
console.log(`${email}: ${before} calls cleared, ${after} left.`);
console.log(`  guide finished: ${w.onboarded_at == null ? 'no, it will run again' : 'STILL MARKED DONE'}`);
console.log(`  balance: $${Number(bal?.balance_usd ?? 0).toFixed(2)}   saved card: ${bal?.payment_method || bal?.card_last4 ? 'STILL THERE' : 'none'}`);
await db.close();
