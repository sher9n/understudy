import { db } from '../db/index.js';
import { track } from '../traffic.js';
import { upsertArm, armById, referenceSpec } from './arms.js';
import { beforeHash } from './threads.js';
import { mayContinue } from './explore.js';

/* Which strategy serves one call.
 *
 * The strategy a workload was switched to serves it. A switch made before strategies were kept
 * (only a model and how it was asked) is kept as one the first time it serves a call, so every
 * call from then on can say which strategy answered it and what chance it had of being chosen.
 * The learning layer adds its choice on top of this: now and then, within the limits the
 * workload allows, a strategy being tried instead. */

let tryInstead = null;
/** Set by the learning layer: given a workload and its serving strategy, maybe one to try instead. */
export const onChoose = (fn) => { tryInstead = fn; };

let afterServe = null;
/** Set by the learning layer: told about every answered call, to answer a few again in the background. */
export const onServed = (fn) => { afterServe = fn; };
/** A routed call was answered. Never holds up the answer, and never fails it. */
export function served(info) {
  if (afterServe && info?.workload) track(afterServe(info), `a background answer for ${info.workload.slug}`);
}

/** The serving strategy, or null when the workload runs on the customer's own model untouched. */
export async function servingArm(workload) {
  if (!workload?.routed_model) return null;
  if (workload.routed_arm_id) {
    const arm = await armById(workload.routed_arm_id);
    if (arm?.spec) return arm;
  }
  let recipe = null;
  try { recipe = workload.routed_recipe ? JSON.parse(workload.routed_recipe) : null; } catch { recipe = null; }
  /* with what its measurement said, its cost against the customer's own model above all, which the
     learning layer needs before it can price anything against this switch */
  const row = await db.prepare(
    `SELECT r.cost_ratio, r.verdict, r.gap_pct, r.runs, r.run_id FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
      WHERE e.workload_id = ? AND r.model_id = ? AND r.cost_ratio IS NOT NULL
      ORDER BY (r.run_id = ?) DESC, e.created_at DESC LIMIT 1`).get(workload.id, workload.routed_model, workload.promoted_run_id ?? '');
  const offline = row ? { verdict: row.verdict, gap: row.gap_pct, ratio: Number(row.cost_ratio), runs: row.runs, runId: row.run_id } : null;
  const arm = await upsertArm(workload, { kind: 'model', model: workload.routed_model, recipe },
    { status: 'serving', originRunId: workload.promoted_run_id ?? null, offline });
  await db.prepare('UPDATE workloads SET routed_arm_id = ? WHERE id = ? AND routed_model = ? AND routed_arm_id IS NULL')
    .run(arm.id, workload.id, workload.routed_model);
  return arm;
}

/* The customer's own model, as the strategy a switch in progress is held against when nothing served
   before it. Kept once per workload, and remembered here, so a call never writes to find it. */
const baselineMemo = new Map();
async function baselineOf(workload) {
  const hit = baselineMemo.get(workload.id);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.arm;
  const arm = await upsertArm(workload, referenceSpec(workload), { status: 'baseline', offline: { ratio: 1 } });
  baselineMemo.set(workload.id, { at: Date.now(), arm });
  if (baselineMemo.size > 5000) baselineMemo.clear();
  return arm;
}

/* A switch in progress: its share of the calls goes to the new strategy, the rest to what served
   before it, each by chance, and each call records the chance it had, so the two can be compared
   fairly while the share grows. No experiment runs meanwhile: one change at a time. */
async function rolloutChoice(workload, serving, rng) {
  const share = Number(workload.rollout_share);
  const fromArm = workload.rollout_from_arm_id ? await armById(workload.rollout_from_arm_id) : null;
  const control = fromArm?.spec ? fromArm : await baselineOf(workload);
  const toOwn = { armId: null, spec: referenceSpec(workload), propensity: 1, explored: false, shadow: null, isFallback: true };
  const isOwn = (a) => a?.spec?.kind === 'model' && a.spec.model === workload.reference_model && !a.spec.recipe;
  if (rng() < share) {
    return { armId: serving.id, spec: serving.spec, propensity: share, explored: false, shadow: null,
      fallback: isOwn(serving) ? null : toOwn, rollout: 'new' };
  }
  return { armId: control.id, spec: control.spec, propensity: 1 - share, explored: false, shadow: null,
    fallback: isOwn(control) ? null : toOwn, rollout: 'before' };
}

/* A call that carries on a conversation or a tool loop is served the way the conversation's earlier
   call was, when that was chosen by chance: an experiment or a rollout decides once per task, not once
   per step. A model changing half way through a conversation reads oddly to whoever is in it, and an
   outcome that shows at the end of a task (a tool that failed on step three) belongs to the strategy
   that ran the whole of it. Found by the conversation's fingerprint, the same way outcomes find it.

   Only while the reason the task was given there still holds, checked again on every step (see
   stillChosen): otherwise the step is served the way any call is now. Checked on the first step alone,
   a fifty step agent task ran on past the day's budget and the workspace's, turning experiments off
   did not stop the tasks already running, and since each step only had to follow the one before it
   within a day, a task never ended. So a task is also re-decided once it is older than TASK_MAX_MS,
   counted from its first step. */
const THREAD_MS = 24 * 3600000;
const TASK_MAX_MS = 24 * 3600000;
async function taskChoice(workload, body, serving) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (!msgs.some((m) => m.role === 'assistant' || m.role === 'tool')) return null;
  const before = beforeHash(msgs);
  if (!before) return null;
  const at = Date.now();
  const parent = await db.prepare(
    `SELECT c.arm_id, c.propensity, c.explored, f.created_at AS started
       FROM calls c LEFT JOIN calls f ON f.id = COALESCE(c.task_id, c.id)
      WHERE c.workspace_id = ? AND c.after_hash = ? AND c.created_at >= ? AND c.workload_id = ?
      ORDER BY c.created_at DESC LIMIT 1`).get(workload.workspace_id, before, at - THREAD_MS, workload.id);
  if (!parent?.arm_id) return null;
  if (Number(parent.started ?? at) < at - TASK_MAX_MS) return null;
  const chance = parent.propensity === null || parent.propensity === undefined ? 1 : Number(parent.propensity);
  const explored = Number(parent.explored) === 1;
  if (!(explored || chance < 1)) return null;
  const arm = await armById(parent.arm_id);
  if (!arm?.spec || !stillChosen(workload, serving, arm, explored)) return null;
  const own = (a) => a?.spec?.kind === 'model' && a.spec.model === workload.reference_model && !a.spec.recipe;
  const toOwn = { armId: null, spec: referenceSpec(workload), propensity: 1, explored: false, shadow: null, isFallback: true };
  /* If this step fails: an experiment's step is served the way the call would have been, by what serves;
     a rollout's step as rolloutChoice serves it, by the customer's own model, never by the other side. */
  const toServing = !rolling(workload) && serving && serving.id !== arm.id
    ? { armId: serving.id, spec: serving.spec, propensity: null, explored: false, shadow: null, fallback: own(serving) ? null : toOwn } : null;
  return { armId: arm.id, spec: arm.spec, propensity: chance, explored, shadow: null, task: true,
    fallback: toServing || (own(arm) ? null : toOwn) };
}

// a switch still taking over a share of the calls
const rolling = (workload) => workload.rollout_share !== null && workload.rollout_share !== undefined && Number(workload.rollout_share) < 1;

/* Whether the reason a task's first step went to `arm` still holds for this step.
   A switch taking over a share of the calls: its task stays on its side while the rollout is under way,
   the side before it included, which the switch set aside as resting and the old check turned away,
   so a conversation that began before the switch was drawn again half way through.
   An experiment: its task stays only within the limits that let it start (mayContinue).
   A task what serves was given by chance, beside an experiment: the same, since outside an experiment
   its calls are no longer given by chance and do not belong in the fair record. */
function stillChosen(workload, serving, arm, explored) {
  if (rolling(workload)) {
    // no experiment runs while a switch takes over (see chooseStrategy): only the rollout's own sides
    if (explored) return false;
    return arm.id === serving.id || (workload.rollout_from_arm_id ? arm.id === workload.rollout_from_arm_id : arm.status === 'baseline');
  }
  if (!explored && arm.id !== serving.id) return false;
  if (!['serving', 'trying', 'baseline'].includes(arm.status)) return false;
  return mayContinue(workload, serving, arm.id);
}

/**
 * The strategy for this call: { armId, spec, propensity, explored, shadow } or null when the
 * workload has no strategy and nothing is being tried (the customer's model serves it as sent).
 */
export async function chooseStrategy(workload, { rng = Math.random, body = null } = {}) {
  const serving = await servingArm(workload);
  if (serving && body) {
    try {
      const same = await taskChoice(workload, body, serving);
      if (same) return same;
    } catch (err) {
      console.error(`reading the task for ${workload.slug} failed: ${err?.message || err}`);
    }
  }
  if (serving && workload.rollout_share !== null && workload.rollout_share !== undefined && Number(workload.rollout_share) < 1) {
    try {
      return await rolloutChoice(workload, serving, rng);
    } catch (err) {
      console.error(`choosing a share for ${workload.slug} failed: ${err?.message || err}`);
    }
  }
  if (tryInstead) {
    /* An experiment is never worth a failed call: if choosing one goes wrong, the call is served
       the way it would have been without it. */
    let pick = null;
    try { pick = await tryInstead(workload, serving); } catch (err) {
      console.error(`choosing an experiment for ${workload.slug} failed: ${err?.message || err}`);
    }
    if (pick) return pick;
  }
  if (!serving) return null;
  /* What serves a switched workload can fail where the customer's own model would not: a provider
     that is down or busy, a model that has left the catalogue, a call longer than the new model
     takes. The call is then answered by the customer's own model, and the failure is kept against
     the strategy so the watch can switch it back. Without this the customer's call simply failed. */
  const fallback = { armId: null, spec: referenceSpec(workload), propensity: 1, explored: false, shadow: null, isFallback: true };
  const same = serving.spec?.kind === 'model' && serving.spec.model === workload.reference_model && !serving.spec.recipe;
  return { armId: serving.id, spec: serving.spec, propensity: 1, explored: false, shadow: null, fallback: same ? null : fallback };
}
