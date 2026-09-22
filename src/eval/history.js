import { db, now } from '../db/index.js';
import { recipeKind } from './select.js';
import { WATCH_COOL_OFF_DAYS } from './promote.js';

/* What earlier measurements found, as evidence for ranking the next one.
 *
 * On this workload: the latest verdict each model earned, from the last sixty days, because a
 * model measured on these very calls is the best evidence there is about it. Across every
 * workload of the same kind of answer: how often each model's answers matched, counting only
 * verdicts, never anybody's content. Older results are left out, because models and providers
 * change. */

const DAY = 86400000;
const HOUR = 3600000;

export async function historyFor(workload) {
  const own = new Map();
  const rows = await db.prepare(
    `SELECT r.model_id, r.verdict, r.stopped, e.created_at FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.workload_id = ? AND r.verdict <> 'reference' AND e.created_at >= ?
      ORDER BY e.created_at DESC`).all(workload.id, now() - 60 * DAY);
  for (const r of rows) {
    if (!own.has(r.model_id)) own.set(r.model_id, { verdict: r.verdict, stopped: r.stopped || null, at: r.created_at });
  }

  /* Whether the answers matched, elsewhere. "Slower" at the end of a measurement matched and was
     too slow, so it counts as matching; "slower" in the first few calls was never judged on its
     answers, and neither was a model whose provider failed it, so those are not counted. A
     model close enough to need a look counts as half. */
  const shape = new Map();
  const agg = await db.prepare(
    `SELECT r.model_id, COUNT(*) AS n,
            SUM(CASE WHEN r.verdict = 'cleared' OR r.verdict = 'slower' THEN 1
                     WHEN r.verdict = 'review' THEN 0.5 ELSE 0 END) AS cleared
       FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.shape_kind = ? AND e.workload_id <> ? AND e.created_at >= ?
        AND (r.verdict IN ('cleared', 'review', 'missed') OR (r.verdict = 'slower' AND r.stopped IS NULL))
      GROUP BY r.model_id`).all(workload.shape_kind, workload.id, now() - 60 * DAY);
  for (const a of agg) shape.set(a.model_id, { n: Number(a.n), cleared: Number(a.cleared) });

  // switched back for good, or for something that can change, within its cool-off
  const reverted = new Set((await db.prepare(
    `SELECT DISTINCT from_model FROM promotions WHERE workload_id = ?
        AND (action IN ('revert', 'auto_revert') OR (action = 'soft_revert' AND created_at >= ?))`)
    .all(workload.id, now() - WATCH_COOL_OFF_DAYS * DAY)).map((r) => r.from_model));
  return { own, shape, reverted, live: liveElsewhere(await liveRates(workload.shape_kind), workload.workspace_id) };
}

/* How often each model's live calls worked, on the same kind of answer, for everybody.
 *
 * A measurement asks whether a model gives the customer's own answers; live calls show whether
 * answers worked (see src/learn/outcomes.js). Across customers that is the best evidence there is
 * about a model on a kind of task, so it nudges the next measurement's order. Only counts are kept,
 * never anybody's content, per model and workspace, so one customer's own calls can be left out of
 * what they are shown. Read at most every ten minutes. */
const liveMemo = new Map();
async function liveRates(shapeKind) {
  const hit = liveMemo.get(shapeKind);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.rows;
  const rows = (await db.prepare(
    `SELECT c.served_model AS model_id, c.workspace_id, COUNT(*) AS n,
            SUM(CASE WHEN c.status_code = 200 THEN COALESCE(c.reward, 1) ELSE 0 END) AS s
       FROM calls c JOIN workloads w ON w.id = c.workload_id
      WHERE w.shape_kind = ? AND c.source = 'routed' AND c.served_model IS NOT NULL
        AND c.created_at >= ? AND c.created_at < ?
        AND (c.status_code = 200 OR c.status_code IN (0, 404, 408, 429) OR c.status_code >= 500)
      GROUP BY 1, 2`).all(shapeKind, now() - 30 * DAY, now() - 10 * 60000))
    .map((r) => ({ model: r.model_id, ws: r.workspace_id, n: Number(r.n), s: Number(r.s) }));
  liveMemo.set(shapeKind, { at: Date.now(), rows });
  return rows;
}

/* Other workspaces' live rates, per model, only where so many stand behind a figure that no one
   customer's traffic can be read from it: at least five workspaces, a hundred calls, and no single
   workspace making up more than half of them. With two, a customer could watch the other one's
   volume move from one reading to the next. The figure itself never leaves the server either: the
   page is only told whether a model did better or worse than most, never a count or a rate. */
export const LIVE_MIN_SPACES = 5;
export function liveElsewhere(rows, workspaceId) {
  const theirs = rows.filter((r) => r.ws !== workspaceId);
  let allN = 0;
  let allS = 0;
  const by = new Map();
  for (const r of theirs) {
    allN += r.n;
    allS += r.s;
    const m = by.get(r.model) || { n: 0, s: 0, spaces: 0, top: 0 };
    m.n += r.n;
    m.s += r.s;
    m.spaces += 1;
    m.top = Math.max(m.top, r.n);
    by.set(r.model, m);
  }
  const fleet = allN ? allS / allN : null;
  const out = new Map();
  for (const [model, m] of by) {
    if (m.spaces >= LIVE_MIN_SPACES && m.n >= 100 && m.top <= m.n / 2 && fleet !== null) {
      out.set(model, { n: m.n, rate: m.s / m.n, fleet, spaces: m.spaces });
    }
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

let fleetMemo = null;
let fleetAt = 0;

/* What every measurement lately says about each model's speed and reachability, whoever's
 * workload it was. Only times and ratios, never anybody's content, so nothing about one
 * customer reaches another.
 *
 * Speed: over the last two weeks, how long each model took against the customer's model in the
 * same measurement, typical to typical, by how it was asked to think. Kept as ratios, because a
 * ratio carries over between workloads where a time does not: a long answer is slow on every
 * model.
 *
 * Busy: the models whose providers were too busy to answer a measurement in the last few
 * hours. OpenRouter shares a model's capacity between everybody who uses it, and a model at
 * its limit this afternoon is likely to be at it again an hour later, but not tomorrow. */
export async function fleetHistory({ fresh = false } = {}) {
  if (!fresh && fleetMemo && Date.now() - fleetAt < 5 * 60000) return fleetMemo;
  const rows = await db.prepare(
    `SELECT r.model_id, r.recipe_json, r.latency_p50, r.ttft_p50, e.ref_latency_p50, e.ref_ttft_p50
       FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.created_at >= ? AND r.verdict <> 'reference'
        AND r.latency_p50 > 0 AND e.ref_latency_p50 > 0`).all(now() - 14 * DAY);
  const groups = new Map();
  for (const r of rows) {
    let recipe = null;
    try { recipe = r.recipe_json ? JSON.parse(r.recipe_json) : null; } catch { recipe = null; }
    const key = `${r.model_id}|${recipeKind(recipe)}`;
    if (!groups.has(key)) groups.set(key, { lat: [], ttft: [] });
    const g = groups.get(key);
    g.lat.push(Number(r.latency_p50) / Number(r.ref_latency_p50));
    if (r.ttft_p50 > 0 && r.ref_ttft_p50 > 0) g.ttft.push(Number(r.ttft_p50) / Number(r.ref_ttft_p50));
  }
  const speed = new Map();
  for (const [key, g] of groups) {
    speed.set(key, { latency: median(g.lat), ttft: median(g.ttft), n: g.lat.length });
  }

  const busy = new Map();
  const b = await db.prepare(
    `SELECT r.model_id, COUNT(*) AS n, MAX(e.created_at) AS at
       FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.created_at >= ? AND r.stopped = 'errors'
      GROUP BY r.model_id`).all(now() - 6 * HOUR);
  for (const x of b) busy.set(x.model_id, { n: Number(x.n), at: Number(x.at) });

  fleetMemo = { speed, busy };
  fleetAt = Date.now();
  return fleetMemo;
}

/** Forget the copy, after a measurement adds to what it would say. */
export const forgetFleet = () => { fleetMemo = null; };
