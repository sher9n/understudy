import { db, now } from '../db/index.js';
import config from '../config.js';
import { priceCall } from '../openrouter.js';
import { account } from '../billing.js';
import { judgementsFor } from './judge.js';

/* What a measurement WOULD do, worked out before anything is spent.
 *
 * One function, used by the button and by the run itself, so the screen can never promise
 * something the run then refuses. Before this the button marked a workload "Measuring" and
 * the run quietly declined a moment later for a reason nobody was told, which left workloads
 * saying "Measuring" for ever. */

const DAY = 86400000;

/** The calls a run is allowed to replay: this workload's own traffic, with content kept. */
async function eligible(workloadId) {
  return (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls
      WHERE workload_id = ? AND request_json IS NOT NULL AND created_at >= ?
        AND source NOT IN ('replay', 'test')`).get(workloadId, now() - 30 * DAY)).n;
}

/* How many of them to replay. Ten at the least, a hundred at the most, and never more than
   half of what there is: a measurement is a sample, and leaving the other half untouched is
   what lets a promoted model be re-checked later on calls it has never seen. */
export function sampleSizeFor(pool) {
  const half = Math.floor(pool * config.EVAL_SAMPLE_SHARE);
  return Math.max(config.EVAL_SAMPLE_MIN, Math.min(config.EVAL_SAMPLE_MAX, half));
}

/** How many models this workspace tries, within the ceiling everyone shares. */
export function modelCountFor(ws) {
  const asked = Number(ws?.eval_models);
  const n = Number.isFinite(asked) && asked > 0 ? asked : config.EVAL_MODELS_DEFAULT;
  return Math.max(1, Math.min(config.EVAL_MODELS_MAX, Math.round(n)));
}

/* Which models to try.
 *
 * Not "the cheapest few", which is what this used to be. The cheapest few models in a
 * catalogue of three hundred are tiny ones that will fail almost anything, so a run spent
 * real money confirming that the bottom of the market is the bottom of the market, and told
 * you nothing about the middle.
 *
 * Instead: every model the workspace has ENABLED, priced on this workload's own average call
 * rather than on a headline rate, keeping only those cheaper than what it runs on now,
 * because a dearer model cannot save anything. Then spread the picks evenly across that
 * range, from the one just below the current model down to the cheapest. A run then shows
 * where quality falls away as price does, which is the question being asked. */
export async function candidatesFor(workspaceId, workloadId, reference, wanted) {
  const t = await db.prepare(
    `SELECT COALESCE(AVG(prompt_tokens), 0) AS pin, COALESCE(AVG(completion_tokens), 0) AS pout
       FROM calls WHERE workload_id = ? AND source NOT IN ('replay', 'test')`).get(workloadId);

  const enabled = await db.prepare(
    `SELECT c.model_id, c.price_in, c.price_out FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1 AND c.price_in > 0 AND c.price_out > 0
        AND c.model_id != ?`).all(workspaceId, reference);

  const per = (m) => m.price_in * t.pin + m.price_out * t.pout;
  const refPer = await priceCall(reference, t.pin, t.pout);

  const cheaper = enabled
    .map((m) => ({ model_id: m.model_id, per: per(m) }))
    .filter((m) => m.per > 0 && (refPer === null || m.per < refPer))
    .sort((a, b) => b.per - a.per);          // dearest first: nearest your model, then down

  if (cheaper.length <= wanted) return cheaper;

  /* Evenly spaced across the price range, always including both ends, so the list is a
     ladder from just-below-yours to the cheapest rather than a clump. */
  const picked = [];
  for (let i = 0; i < wanted; i += 1) {
    const at = Math.round((i * (cheaper.length - 1)) / (wanted - 1));
    if (!picked.some((p) => p.model_id === cheaper[at].model_id)) picked.push(cheaper[at]);
  }
  return picked;
}

/** What a run would cost, from this workload's own average call. */
export async function estimateFor(workloadId, reference, candidates, sample, shapeKind) {
  const t = await db.prepare(
    `SELECT COALESCE(AVG(prompt_tokens), 0) AS pin, COALESCE(AVG(completion_tokens), 0) AS pout
       FROM calls WHERE workload_id = ? AND source NOT IN ('replay', 'test')`).get(workloadId);
  const refPer = (await priceCall(reference, t.pin, t.pout)) ?? 0;
  let total = refPer * sample * 2;           // the bar is your own model, run twice
  for (const c of candidates) total += ((await priceCall(c.model_id, t.pin, t.pout)) ?? 0) * sample;
  /* Free text is settled by asking a model whether two answers mean the same thing, and
     those questions are model calls too. Leaving them out of the estimate would put a price
     on the button that the run then beats. */
  const judgements = judgementsFor(shapeKind, sample, candidates.length);
  if (judgements) {
    const per = (await priceCall(config.EVAL_JUDGE_MODEL, Math.min(t.pin, 600) + 400, 6)) ?? 0;
    total += per * judgements;
  }
  return Math.round(total * 1e8) / 1e8;
}

/* The whole plan, and whether it can run. `reason` is written to be shown to somebody as it
   is: it is the sentence under a button that cannot be pressed. */
export async function planFor(workload, { canRoute }) {
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const models = modelCountFor(ws);
  const pool = await eligible(workload.id);
  const sample = sampleSizeFor(pool);
  const plan = {
    pool, sample, models, candidates: [], estimateUsd: null,
    canRun: false, reason: null, reference: workload.reference_model,
  };

  if (!canRoute) {
    plan.reason = 'Routing is not configured on this deployment, so nothing can be replayed.';
    return plan;
  }
  if (!workload.reference_model) {
    plan.reason = 'We do not know which model this workload runs on yet, so there is nothing to measure against.';
    return plan;
  }
  if (pool < config.EVAL_MIN_CALLS) {
    plan.reason = `${pool} of the ${config.EVAL_MIN_CALLS} calls we need. `
      + 'Keep sending traffic and this turns on by itself.';
    return plan;
  }

  plan.candidates = await candidatesFor(workload.workspace_id, workload.id, workload.reference_model, models);
  if (!plan.candidates.length) {
    plan.reason = 'Nothing you have enabled in Models costs less than what this workload runs on, '
      + 'so there is nothing cheaper to try. Enable more models and this turns on.';
    return plan;
  }

  plan.estimateUsd = await estimateFor(workload.id, workload.reference_model, plan.candidates,
    sample, workload.shape_kind);
  if (plan.estimateUsd > config.EVAL_MAX_USD_PER_RUN) {
    plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)}, over the $`
      + `${config.EVAL_MAX_USD_PER_RUN.toFixed(2)} we allow for one measurement. `
      + 'Testing fewer models in Settings brings it down.';
    return plan;
  }

  const acct = await account(workload.workspace_id);
  if (acct.balance_usd < plan.estimateUsd) {
    plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)} and your balance is $`
      + `${Number(acct.balance_usd).toFixed(2)}. Add credit and it can run.`;
    return plan;
  }

  plan.canRun = true;
  return plan;
}
