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
  /* The providers a model was measured on are how it is served, not what it is: a measurement that
     happened to be answered by a different pair of providers is the same strategy, and its record
     must not start again. Only a model pinned to one provider on purpose (#cheapest) keeps it. */
  const recipeOf = (p) => {
    const r = p?.recipe || null;
    if (!r || !r.providers || r.pinned) return r;
    const { providers, ...rest } = r;
    return Object.keys(rest).length ? rest : null;
  };
  const part = (p) => `${p?.model || ''}~${JSON.stringify(recipeOf(p))}`;
  if (spec.kind === 'cascade') return `cascade:${part(spec.first)}>${part(spec.fallback)}`;
  // a router by kind of request: every setup it chooses between, and the customer's own
  if (spec.kind === 'router' && Array.isArray(spec.options)) return `router:${spec.options.map(part).join('+')}|${part(spec.strong)}~kinds`;
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
  if (spec.kind === 'router' && Array.isArray(spec.options)) {
    const names = spec.options.map((o) => (o.model === spec.strong?.model && lighter(o.recipe) ? `${short(o.model)} thinking less` : short(o.model)));
    return `${[...names, `${short(spec.strong?.model)} (yours)`].join(', ').replace(/, ([^,]*)$/, ' or $1')}, picked by kind of request`;
  }
  if (spec.kind === 'router') {
    if (same(spec.cheap, spec.strong)) return `${short(spec.cheap.model)} thinking less or fully, picked call by call`;
    return `${short(spec.cheap.model)} or ${short(spec.strong.model)}, picked call by call`;
  }
  // any way of thinking set on the customer's own model is a lighter one: the lightest it offers can be "medium"
  if (reference && spec.model === reference && spec.recipe?.reasoning) return `${short(spec.model)}, thinking less`;
  if (reference && spec.model === reference && spec.recipe?.pinned) return `${short(spec.model)}, from its cheapest provider`;
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
 *   kind: model | lighter | cheapest | cascade | router
 * The customer's own model bought from the provider that sells it most cheaply is "cheapest": it
 * used to be named as thinking less, which it does not.
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
  if (spec.kind === 'router' && Array.isArray(spec.options)) {
    /* Each setup it sends requests to, with how many of the kinds it learned go to it and what share of the
       measured calls those kinds were; and the same for the customer's own model. */
    const table = Array.isArray(spec.table) ? spec.table : [];
    const sizes = Array.isArray(spec.sizes) ? spec.sizes : [];
    const total = sizes.reduce((a, b) => a + (Number(b) || 0), 0);
    const shareOf = (pick) => (total > 0 ? Math.round((table.reduce((a, t, k) => a + (pick(t) ? Number(sizes[k]) || 0 : 0), 0) / total) * 10000) / 10000 : null);
    const partLabel = (o) => (o.model === spec.strong?.model && lighter(o.recipe) ? `${short(o.model)} thinking less` : short(o.model));
    const names = spec.options.map(partLabel);
    return { kind: 'router', version: 2, label: labelOf(spec),
      short: names.length === 1 ? `${names[0]} or ${short(spec.strong?.model)}, by kind of request` : `${names[0]} and ${names.length - 1} more, by kind of request`,
      first: spec.cheap.model, fallback: spec.strong.model, threshold: null, options: spec.options.map((o) => o.model),
      kinds: table.length || null,
      parts: spec.options.map((o, j) => ({ option: j, model: o.model, label: names[j], kinds: table.filter((t) => t === j).length, share: shareOf((t) => t === j) })),
      yours: { kinds: table.filter((t) => t < 0).length, share: shareOf((t) => t < 0) } };
  }
  if (spec.kind === 'router') {
    return { kind: 'router', label: labelOf(spec), short: `${short(spec.cheap.model)}, picked per call`,
      first: spec.cheap.model, fallback: spec.strong.model, threshold: spec.threshold ?? null };
  }
  /* Read the way the key was made (keyOfSpec in src/eval/promote.js): a way of thinking is "#lighter"
     whatever effort it names, since the lightest a model offers can be "medium", and a provider pinned
     on purpose is "#cheapest". */
  if (id.endsWith('#lighter') || (!id.endsWith('#cheapest') && spec.recipe?.reasoning)) {
    return { kind: 'lighter', label: `${short(spec.model)}, thinking less`, short: `${short(spec.model)}, thinking less`, first: spec.model };
  }
  if (id.endsWith('#cheapest') || spec.recipe?.pinned) {
    return { kind: 'cheapest', label: `${short(spec.model)}, from its cheapest provider`, short: `${short(spec.model)}, cheapest provider`, first: spec.model };
  }
  return { kind: 'model', label: short(spec.model), short: short(spec.model), first: spec.model };
}

/** The strategy a measurement's result row stands for: its own, or the plain model it names. */
export function specOfResult(row) {
  const own = parse(row?.arm_json, null);
  if (own) return own;
  return { kind: 'model', model: row.model_id, recipe: parse(row?.recipe_json, null) };
}
