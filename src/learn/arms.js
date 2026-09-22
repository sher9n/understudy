import { db, id, now } from '../db/index.js';

/* The ways a workload's calls can be served, called arms: one model, a cascade (a cheap model
   answers, a quick check reads it, and a doubtful answer is sent on to the customer's own model),
   or a router (a small model of the workload's own calls picks, call by call, which of two models
   answers). Each is kept once per workload, with what the measurement that found it said and
   what has been learned about it since. */

const short = (m) => String(m || '').split('/').pop();
const parse = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

const lighter = (recipe) => {
  const r = recipe?.reasoning;
  if (!r) return false;
  return r.enabled === false || ['none', 'minimal', 'low'].includes(r.effort);
};

/** The same strategy found again has the same key, whatever the order its parts were written in. */
export function armKey(spec) {
  const part = (p) => `${p?.model || ''}~${JSON.stringify(p?.recipe || null)}`;
  if (spec.kind === 'cascade') return `cascade:${part(spec.first)}>${part(spec.fallback)}`;
  if (spec.kind === 'router') return `router:${part(spec.cheap)}|${part(spec.strong)}`;
  return `model:${part(spec)}`;
}

/** A strategy in words somebody can read at a glance. */
export function labelOf(spec, reference = null) {
  // one model asked two ways: thinking less first, and thinking fully when that is not enough
  const same = (a, b) => a.model === b.model && lighter(a.recipe) && !lighter(b.recipe);
  if (spec.kind === 'cascade') {
    if (same(spec.first, spec.fallback)) return `${short(spec.first.model)} thinking less, checked, thinking fully when unsure`;
    return `${short(spec.first.model)}, checked, ${short(spec.fallback.model)} when unsure`;
  }
  if (spec.kind === 'router') {
    if (same(spec.cheap, spec.strong)) return `${short(spec.cheap.model)} thinking less or fully, picked call by call`;
    return `${short(spec.cheap.model)} or ${short(spec.strong.model)}, picked call by call`;
  }
  if (reference && spec.model === reference && lighter(spec.recipe)) return `${short(spec.model)}, thinking less`;
  if (reference && spec.model === reference) return `${short(spec.model)} (yours)`;
  return short(spec.model);
}

/** The model that answers most of a strategy's calls, which is what the rest of the app calls "serving". */
export function leadModel(spec) {
  if (spec.kind === 'cascade') return spec.first;
  if (spec.kind === 'router') return spec.cheap;
  return { model: spec.model, recipe: spec.recipe ?? null };
}

export const referenceSpec = (workload) => ({ kind: 'model', model: workload.reference_model, recipe: null });

const rowOut = (r) => (r ? { ...r, spec: parse(r.spec_json, null), offline: parse(r.offline_json, null), stats: parse(r.stats_json, null) } : null);

/** Keep a strategy for a workload, or find the one already kept; new facts about it are added. */
export async function upsertArm(workload, spec, { status = 'resting', originRunId = null, offline = null } = {}) {
  const key = armKey(spec);
  const t = now();
  await db.prepare(`INSERT INTO arms (id, workspace_id, workload_id, kind, key, spec_json, label, status, origin_run_id,
        offline_json, stats_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT (workload_id, key) DO UPDATE SET
        /* what serves keeps the exact settings it was switched to: the key leaves out a cascade's
           threshold and a router's weights, and a later measurement finding the same strategy at other
           settings used to rewrite the live one with no switch recorded */
        spec_json = CASE WHEN arms.status = 'serving' THEN arms.spec_json ELSE excluded.spec_json END,
        label = CASE WHEN arms.status = 'serving' THEN arms.label ELSE excluded.label END,
        origin_run_id = COALESCE(excluded.origin_run_id, arms.origin_run_id),
        offline_json = COALESCE(excluded.offline_json, arms.offline_json), updated_at = excluded.updated_at`)
    .run(id('arm'), workload.workspace_id, workload.id, spec.kind, key, JSON.stringify(spec),
      labelOf(spec, workload.reference_model), status, originRunId, offline ? JSON.stringify(offline) : null, t, t);
  const row = await db.prepare('SELECT * FROM arms WHERE workload_id = ? AND key = ?').get(workload.id, key);
  return rowOut(row);
}

export async function armById(armId) {
  return armId ? rowOut(await db.prepare('SELECT * FROM arms WHERE id = ?').get(armId)) : null;
}

export async function armsFor(workloadId) {
  return (await db.prepare(`SELECT * FROM arms WHERE workload_id = ? AND status <> 'retired' ORDER BY created_at`).all(workloadId)).map(rowOut);
}

export async function setStatus(armId, status) {
  await db.prepare('UPDATE arms SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), armId);
}

/**
 * What a screen calls a measurement's result: the plain model, or a strategy in words, long and
 * short, with what kind of thing it is so a chart can draw it differently.
 *   kind: model | lighter | cascade | router
 */
export function nameOfResult(row) {
  const spec = parse(row?.arm_json, null);
  const id = String(row?.model_id || '');
  if (!spec) return { kind: 'model', label: id, short: short(id) };
  if (spec.kind === 'cascade') {
    const same = spec.first.model === spec.fallback.model;
    return { kind: 'cascade', label: labelOf(spec), short: same ? `${short(spec.first.model)} thinking less, checked` : `${short(spec.first.model)}, checked`,
      first: spec.first.model, fallback: spec.fallback.model, threshold: spec.threshold ?? null };
  }
  if (spec.kind === 'router') {
    return { kind: 'router', label: labelOf(spec), short: `${short(spec.cheap.model)}, picked per call`,
      first: spec.cheap.model, fallback: spec.strong.model, threshold: spec.threshold ?? null };
  }
  return { kind: 'lighter', label: `${short(spec.model)}, thinking less`, short: `${short(spec.model)}, thinking less`, first: spec.model };
}

/** The strategy a measurement's result row stands for: its own, or the plain model it names. */
export function specOfResult(row) {
  const own = parse(row?.arm_json, null);
  if (own) return own;
  return { kind: 'model', model: row.model_id, recipe: parse(row?.recipe_json, null) };
}
