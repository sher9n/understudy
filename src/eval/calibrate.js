import { db, now } from '../db/index.js';

/* How far to believe a model's chance of clearing, from how often chances like it came true.
 *
 * Every measurement writes down the chance it gave each model before it started (rank_json), and
 * then finds out whether the model cleared. Put side by side, those say whether "a 60% chance"
 * cleared about six times in ten or two. The chance a measurement starts from is then read through
 * that record, bin by bin, so the order models are tried in, and the saving a measurement is
 * expected to find, rest on what has actually happened rather than on weights somebody chose.
 *
 * Only verdicts are counted, never anybody's content. A workspace's own results always count for
 * itself; another workspace's only when it has said its results may help others (share_stats). A
 * bin with too little behind it leans on the chance as given, and the whole table stands down
 * until there are enough results to say anything. */

const DAY = 86400000;
const EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const MIN_RESULTS = 40;
// how many results a bin needs before its own record outweighs the chance it was given
const PRIOR_WEIGHT = 8;

const memo = new Map();
const MEMO_MS = 30 * 60000;

export async function calibrationFor(workspaceId) {
  const hit = memo.get(workspaceId);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.table;
  const rows = await db.prepare(
    `SELECT r.model_id, r.rank_json, r.verdict FROM eval_results r
       JOIN eval_runs e ON e.id = r.run_id
       JOIN workspaces w ON w.id = e.workspace_id
      WHERE e.created_at >= ? AND r.rank_json IS NOT NULL
        AND r.verdict IN ('cleared', 'review', 'missed')
        AND (e.workspace_id = ? OR w.share_stats = 1)`)
    .all(now() - 120 * DAY, workspaceId);
  const bins = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, cleared: 0, said: 0 }));
  let total = 0;
  for (const r of rows) {
    /* Only a chance worked out from evidence, before it was read through this table, so the table
       never calibrates itself. A strategy's row carries the calibrated chance of the model it is built
       on and no raw one, and the customer's own model thinking less, or from its cheapest provider, is
       given a fixed guess (six in ten, eight in ten) that no evidence moved. Falling back to the
       calibrated chance counted those, which pushed the chances it hands back upwards. */
    let chance = null;
    try { chance = JSON.parse(r.rank_json)?.rawChance ?? null; } catch { chance = null; }
    if (chance === null || !Number.isFinite(Number(chance))) continue;
    if (String(r.model_id).includes('#') || /^(cascade|router):/.test(String(r.model_id))) continue;
    const p = Math.max(0, Math.min(1, Number(chance)));
    const b = bins.find((x) => p >= x.lo && p < x.hi);
    if (!b) continue;
    b.n += 1;
    b.said += p;
    // close enough to need a look counts as half, as it does everywhere else a verdict is counted
    b.cleared += r.verdict === 'cleared' ? 1 : r.verdict === 'review' ? 0.5 : 0;
    total += 1;
  }
  const table = total >= MIN_RESULTS ? { bins, total } : null;
  memo.set(workspaceId, { at: Date.now(), table });
  return table;
}

export const forgetCalibration = () => memo.clear();

/** A chance read through the record: each bin's rate, pulled towards the chance as given while it has few results. */
export function calibrated(table, p) {
  if (!table || !Number.isFinite(Number(p))) return p;
  const x = Math.max(0, Math.min(1, Number(p)));
  const b = table.bins.find((y) => x >= y.lo && x < y.hi);
  if (!b || !b.n) return x;
  const rate = (b.cleared + PRIOR_WEIGHT * x) / (b.n + PRIOR_WEIGHT);
  return Math.max(0.01, Math.min(0.97, rate));
}
