import { db } from '../db/index.js';
import { track } from '../traffic.js';
import { upsertArm, armById } from './arms.js';

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
  const arm = await upsertArm(workload, { kind: 'model', model: workload.routed_model, recipe }, { status: 'serving', originRunId: workload.promoted_run_id ?? null });
  await db.prepare('UPDATE workloads SET routed_arm_id = ? WHERE id = ? AND routed_model = ? AND routed_arm_id IS NULL')
    .run(arm.id, workload.id, workload.routed_model);
  return arm;
}

/**
 * The strategy for this call: { armId, spec, propensity, explored, shadow } or null when the
 * workload has no strategy and nothing is being tried (the customer's model serves it as sent).
 */
export async function chooseStrategy(workload) {
  const serving = await servingArm(workload);
  if (tryInstead) {
    /* An experiment is never worth a failed call: if choosing one goes wrong, the call is served
       the way it would have been without it. */
    let pick = null;
    try { pick = await tryInstead(workload, serving); } catch (err) {
      console.error(`choosing an experiment for ${workload.slug} failed: ${err?.message || err}`);
    }
    if (pick) return pick;
  }
  return serving ? { armId: serving.id, spec: serving.spec, propensity: 1, explored: false, shadow: null } : null;
}
