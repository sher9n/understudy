import { db, now } from '../db/index.js';
import config from '../config.js';

/* When a workload is next measured by itself.
 *
 * A re-check that keeps finding what it found last time is paying for the same answer again, so each
 * one that changes nothing spaces the next one out, doubling up to EVAL_BACKOFF_MAX_DOUBLINGS times
 * the workspace's own rhythm. One that changed something (a switch, a switch back, a new candidate, a
 * candidate that needs a look) goes back to that rhythm. And something that could matter to a
 * workload, a model it has not seen or a price that moved, brings its next check forward, never
 * sooner than EVAL_NUDGE_MIN_DAYS after its last one: a catalogue that changes every day would
 * otherwise measure everything every day. Whether a measurement nobody asked for then actually runs
 * is the plan's decision: only when what it can be expected to find pays for it (see worthOf). */

const DAY = 86400000;
const HOUR = 3600000;

/** How often a workspace measures by itself, in days; zero means never. */
export async function cadenceOf(workspaceId) {
  const ws = await db.prepare('SELECT measure_every_days FROM workspaces WHERE id = ?').get(workspaceId);
  const d = ws?.measure_every_days === null || ws?.measure_every_days === undefined
    ? config.MEASURE_EVERY_DAYS : Number(ws.measure_every_days);
  return d > 0 ? d : 0;
}

/** After a measurement: when the next is due, and the streak of ones that changed nothing. */
export async function scheduleNext(workloadId, { changed }) {
  const w = await db.prepare('SELECT workspace_id, recheck_streak FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = await cadenceOf(w.workspace_id);
  const streak = changed ? 0 : Math.min(config.EVAL_BACKOFF_MAX_DOUBLINGS, Number(w.recheck_streak || 0) + 1);
  // whole milliseconds: the column is a bigint, and a fraction of one is refused
  const at = cadence ? Math.round(now() + cadence * DAY * 2 ** streak) : null;
  await db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = ? WHERE id = ?').run(at, streak, workloadId);
  return at;
}

/* A measurement nobody asked for that the plan turned down: looked at again later, rather than at
   every hourly pass. When it waits for more calls, about when they will have arrived; otherwise after
   one of the workspace's own periods (a week when it measures only when asked, for the page's sake). */
export async function deferAutomatic(workloadId, { waitMs = null } = {}) {
  const w = await db.prepare('SELECT workspace_id FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = (await cadenceOf(w.workspace_id)) || 7;
  const wait = waitMs !== null && Number.isFinite(waitMs)
    ? Math.max(6 * HOUR, Math.min(cadence * DAY, waitMs)) : cadence * DAY;
  const at = Math.round(now() + wait);
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(at, workloadId);
  return at;
}

/* Something changed that could matter: the next measurement of these workloads comes forward to
   within EVAL_NUDGE_HOURS, unless one ran in the last EVAL_NUDGE_MIN_DAYS. Answers how many moved. */
export async function nudge(workloadIds) {
  let moved = 0;
  const at = Math.round(now() + config.EVAL_NUDGE_HOURS * HOUR);
  const recent = Math.round(now() - config.EVAL_NUDGE_MIN_DAYS * DAY);
  for (const id of new Set(workloadIds)) {
    moved += (await db.prepare(
      `UPDATE workloads w SET recheck_after = ?, recheck_streak = 0
        WHERE w.id = ? AND (w.recheck_after IS NULL OR w.recheck_after > ?)
          AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id AND r.created_at >= ?)`)
      .run(at, id, at, recent)).changes;
  }
  return moved;
}

const blend = (m) => Number(m.price_in || 0) + Number(m.price_out || 0);

/* What moved in the catalogue between two readings, and which workloads it could matter to:
     a model that serves a workload got dearer, so its saving may be gone;
     the customer's own model got cheaper under a switch, so the switch may no longer save;
     a model new to the catalogue, or much cheaper than it was, costs a good deal less than what a
     workload runs on now, so it may be worth trying. */
export async function nudgeForCatalog(before, after) {
  const was = new Map(before.map((m) => [m.model_id, m]));
  const added = [];
  const cheaper = [];
  const dearer = new Set();
  const droppedPrice = new Set();
  for (const m of after) {
    const old = was.get(m.model_id);
    if (!old) { added.push(m); continue; }
    const a = blend(old);
    const b = blend(m);
    if (a > 0 && b < a * 0.9) { cheaper.push(m); droppedPrice.add(m.model_id); }
    if (a > 0 && b > a * 1.1) dearer.add(m.model_id);
  }
  const tryable = [...added, ...cheaper].filter((m) => blend(m) > 0);
  if (!tryable.length && !dearer.size && !droppedPrice.size) return { added: added.length, cheaper: cheaper.length, dearer: dearer.size, nudged: 0 };
  const priceOf = new Map(after.map((m) => [m.model_id, blend(m)]));
  const live = await db.prepare(
    `SELECT id, reference_model, routed_model FROM workloads WHERE state = 'live' AND merged_into IS NULL`).all();
  const cheapest = tryable.length ? Math.min(...tryable.map(blend)) : null;
  const ids = [];
  for (const w of live) {
    if (w.routed_model && dearer.has(w.routed_model)) { ids.push(w.id); continue; }
    if (w.routed_model && droppedPrice.has(w.reference_model)) { ids.push(w.id); continue; }
    const serving = priceOf.get(w.routed_model || w.reference_model);
    if (cheapest !== null && serving && cheapest * 1.25 < serving) ids.push(w.id);
  }
  const nudged = ids.length ? await nudge(ids) : 0;
  return { added: added.length, cheaper: cheaper.length, dearer: dearer.size, nudged };
}
