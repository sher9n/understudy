import { db, now } from '../db/index.js';
import config from '../config.js';
import { jevUsable, jevResting } from '../jev.js';
import { account } from '../billing.js';
import { loadFacts, routedCallPrice, callPrice } from '../models/facts.js';
import { ratingsFor } from '../models/arena.js';
import { profileOf, speedRule } from './profile.js';
import { selectCandidates, refThinksOf } from './select.js';
import { fitsFor } from './fit.js';
import { historyFor, fleetHistory } from './history.js';
import { judgementsFor, judgementCost } from './judge.js';

/* What a measurement WOULD do, worked out before anything is spent.
 *
 * One function, used by the page and by the run itself, so the screen can never promise
 * something the run then refuses or does differently. The page reads it from what is already
 * known, cached facts and cached judgements, and never waits on anybody; the run asks Jev for
 * whatever the page had to go without, and then chooses exactly as the page showed. */

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

/** How many models this workspace measures to the end, within the ceiling everyone shares. */
export function modelCountFor(ws) {
  const asked = Number(ws?.eval_models);
  const n = Number.isFinite(asked) && asked > 0 ? asked : config.EVAL_MODELS_DEFAULT;
  return Math.max(1, Math.min(config.EVAL_MODELS_MAX, Math.round(n)));
}

async function enabledSet(workspaceId) {
  return new Set((await db.prepare(
    `SELECT c.model_id FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1`).all(workspaceId)).map((r) => r.model_id));
}

/* How much of the bar is already paid for: answers from the customer's own model to this
   workload's recent calls, still young enough to use again. */
async function cachedBarShare(workload, sample) {
  const n = (await db.prepare(
    `SELECT COUNT(*) AS n FROM replay_cache r
      WHERE r.model_id = ? AND r.status = 200 AND r.created_at >= ?
        AND r.call_id IN (SELECT id FROM calls WHERE workload_id = ? AND created_at >= ?)`)
    .get(workload.reference_model, now() - config.REPLAY_REUSE_DAYS * DAY, workload.id, now() - 30 * DAY)).n;
  return Math.min(1, Number(n) / Math.max(1, sample * 2));
}

/* Work for Jev a later look at the page will want: readings of how each model suits this
   task, and which leaderboard entry each model is. Queued, never waited on here. */
let queueFit = null;
export const onMissingFits = (fn) => { queueFit = fn; };

/* The whole plan, and whether it can run. `reason` is written to be shown to somebody as it
   is: it is the sentence under a button that cannot be pressed. */
export async function planFor(workload, { canRoute, forRun = false } = {}) {
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const models = modelCountFor(ws);
  const pool = await eligible(workload.id);
  const sample = sampleSizeFor(pool);
  const plan = {
    pool, sample, models, candidates: [], order: [], funnel: [], excluded: [], waiting: 0,
    estimateUsd: null, canRun: false, reason: null, reference: workload.reference_model,
    judge: jevUsable() ? 'jev' : 'llm', jevResting: jevResting(), factsAt: {}, speed: null, profile: null, pendingJev: 0,
    difficulty: null, cachedBar: 0, refThinks: null,
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

  const facts = await loadFacts();
  const profile = await profileOf(workload);
  const speed = speedRule(workload, profile, config);
  const history = await historyFor(workload);
  const fleet = await fleetHistory();
  const enabled = await enabledSet(workload.workspace_id);
  // whether the customer's model thinks, so candidates are asked the same way; the run checks it
  const refThinks = refThinksOf(facts.models.get(workload.reference_model) || null, profile.refThinking);
  plan.factsAt = facts.syncedAt;
  plan.profile = profile;
  plan.speed = speed;
  plan.refThinks = refThinks;
  const base = {
    facts, profile, reference: workload.reference_model, enabled, want: models,
    tryMultiple: config.EVAL_TRY_MULTIPLE, reverted: history.reverted, serving: workload.routed_model,
    history, speed, refThinks, speedHistory: fleet.speed, busy: fleet.busy, config, at: now(),
  };

  // who survives the rules, before anything is ranked
  const first = selectCandidates(base);
  const survivors = first.ranked.map((r) => r.model);

  // what Jev and the leaderboard say about the survivors; the run asks for what is missing
  const { fits, difficulty } = await fitsFor(profile, survivors, facts, { compute: forRun });
  const arena = await ratingsFor([workload.reference_model, ...survivors], facts, { link: forRun });
  plan.pendingJev = jevUsable() ? survivors.filter((id) => !fits.has(id)).length : 0;
  if (!forRun && plan.pendingJev && queueFit) queueFit(workload.id);
  plan.difficulty = difficulty;

  const sel = selectCandidates({ ...base, fits, arena, difficulty });
  plan.funnel = sel.funnel;
  plan.excluded = sel.excluded;
  plan.order = sel.order;
  plan.waiting = sel.waiting;
  plan.refPrice = sel.refPrice;
  plan.refHealth = sel.refHealth;
  plan.candidates = sel.order.map((r) => ({ model_id: r.model, per: r.price, recipe: r.recipe }));

  if (!plan.order.length) {
    const top = mostCommon(sel.excluded);
    plan.reason = top
      ? `Nothing you have switched on could be measured against ${short(workload.reference_model)}. `
        + `${top.count === 1 ? 'The one model left' : `${top.count} of them were`} ruled out for the same reason, `
        + `for example ${short(top.model)}, which ${top.reason}. Switch on more models and this turns on.`
      : 'Nothing you have enabled in Models costs less than what this workload runs on, '
        + 'so there is nothing cheaper to try. Enable more models and this turns on.';
    return plan;
  }

  plan.cachedBar = await cachedBarShare(workload, sample);
  plan.estimateUsd = estimate(plan, profile, facts, workload);
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

/* What a measurement is expected to cost, from this workload's own average call.
 *
 * The bar is the customer's own model twice on every sampled call, less whatever is already
 * paid for. The models are the ones measured to the end, every call, plus the ones dropped
 * early, which are charged for the few calls they answered before being dropped. Judging
 * written answers is part of the work and is counted. */
function estimate(plan, profile, facts, workload) {
  const pin = profile.promptAvg || 0;
  const pout = profile.outAvg || 0;
  const refModel = facts.models.get(workload.reference_model);
  const refPer = plan.refPrice ?? (refModel ? routedCallPrice(refModel, pin, pout, profile.hours)
    ?? callPrice(refModel, pin, pout, profile.hours) : 0) ?? 0;
  let total = refPer * plan.sample * 2 * (1 - plan.cachedBar);
  const finalists = plan.order.slice(0, plan.models);
  const extra = plan.order.slice(plan.models);
  for (const c of finalists) total += c.price * plan.sample;
  for (const c of extra) total += c.price * Math.min(plan.sample, config.EVAL_SCREEN_CALLS);
  const judged = judgementsFor(workload.shape_kind, plan.sample, finalists.length);
  if (judged) {
    const llm = facts.models.get(config.EVAL_JUDGE_MODEL);
    const llmPer = llm ? callPrice(llm, Math.min(pin, 600) + 400, 6) : 0;
    total += judged * judgementCost(pin, pout, llmPer);
  }
  return Math.round(total * 1e8) / 1e8;
}

function mostCommon(excluded) {
  const by = new Map();
  for (const e of excluded) {
    const k = e.step;
    if (!by.has(k)) by.set(k, { count: 0, reason: e.reason, model: e.model });
    by.get(k).count += 1;
  }
  return [...by.values()].sort((a, b) => b.count - a.count)[0] || null;
}

const short = (id) => String(id || '').split('/').pop();
