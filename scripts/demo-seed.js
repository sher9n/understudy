/* The two demo states, set up from nothing, repeatably.
 *
 *   sheran.corera@docupath.ai  has traffic, so it lands on the dashboard with workloads
 *                              already found, which is what an established customer sees.
 *   sherancorera@gmail.com     has none, so it lands on the getting started guide, which is
 *                              what somebody signing up today sees.
 *   new@understudy.demo        also empty, a spare for walking the guide again.
 *
 * Run it as often as you like: it clears whatever the seeded accounts had and rebuilds
 * them, so the two states are always exactly these two and never half of each.
 *
 *   node scripts/demo-seed.js
 */

import { db, now } from '../src/db/index.js';
import migrate from '../src/db/migrate.js';
import config from '../src/config.js';

await migrate({ quiet: true });

const WITH_TRAFFIC = 'sheran.corera@docupath.ai';
const EMPTY = ['sherancorera@gmail.com', 'new@understudy.demo'];
const BASE = process.env.SEED_BASE || `http://localhost:${config.PORT}`;

const workspaceOf = async (email) => db.prepare(
  `SELECT w.* FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE u.email = ?`)
  .get(email.toLowerCase());

/** Everything a workspace has ever been sent. The account itself stays. */
async function clearTraffic(email) {
  const ws = await workspaceOf(email);
  if (!ws) return null;
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
    await tx.prepare('UPDATE billing_accounts SET balance_usd = 0, eval_used_usd = 0, updated_at = ? WHERE workspace_id = ?')
      .run(now(), ws.id);
  });
  return ws;
}

for (const email of [...EMPTY, WITH_TRAFFIC]) {
  const ws = await clearTraffic(email);
  console.log(ws ? `  cleared ${email}` : `  ${email} has no account yet, run scripts/demo-users.js first`);
}

const ws = await workspaceOf(WITH_TRAFFIC);
if (!ws) {
  console.error('\nNo account for ' + WITH_TRAFFIC + '. Run: node scripts/demo-users.js');
  process.exit(1);
}

/* Traffic goes in through the real endpoint with a real key, exactly as a customer's would,
   so what the screens show afterwards is what they would show for anybody. */
const { issueKey } = await import('../src/keys.js');
const key = await issueKey(ws.id, 'demo-seed');
console.log(`\n  minted a key for ${WITH_TRAFFIC}`);

process.env.SEED_KEY = key.secret;
process.env.SEED_BASE = BASE;
console.log(`  sending traffic to ${BASE}/v1/traces\n`);
await import('./seed.js');
