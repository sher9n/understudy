import { db, now } from '../db/index.js';

/* What earlier measurements found, as evidence for ranking the next one.
 *
 * On this workload: the latest verdict each model earned, from the last sixty days, because a
 * model measured on these very calls is the best evidence there is about it. Across every
 * workload of the same kind of answer: how often each model cleared, counting only verdicts,
 * never anybody's content. Older results are left out, because models and providers change. */

const DAY = 86400000;

export async function historyFor(workload) {
  const own = new Map();
  const rows = await db.prepare(
    `SELECT r.model_id, r.verdict, e.created_at FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.workload_id = ? AND r.verdict <> 'reference' AND e.created_at >= ?
      ORDER BY e.created_at DESC`).all(workload.id, now() - 60 * DAY);
  for (const r of rows) if (!own.has(r.model_id)) own.set(r.model_id, { verdict: r.verdict, at: r.created_at });

  const shape = new Map();
  const agg = await db.prepare(
    `SELECT r.model_id, COUNT(*) AS n, SUM(CASE WHEN r.verdict = 'cleared' THEN 1 ELSE 0 END) AS cleared
       FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.shape_kind = ? AND e.workload_id <> ? AND r.verdict IN ('cleared', 'review', 'missed', 'slower')
        AND e.created_at >= ?
      GROUP BY r.model_id`).all(workload.shape_kind, workload.id, now() - 60 * DAY);
  for (const a of agg) shape.set(a.model_id, { n: Number(a.n), cleared: Number(a.cleared) });

  const reverted = new Set((await db.prepare(
    `SELECT DISTINCT from_model FROM promotions WHERE workload_id = ? AND action IN ('revert', 'auto_revert')`)
    .all(workload.id)).map((r) => r.from_model));
  return { own, shape, reverted };
}
