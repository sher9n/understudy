import { db, now } from '../db/index.js';
import config from '../config.js';
import { jevUsable, jevResting } from '../jev.js';
import { gateEval, optimizeSpent } from '../billing.js';
import { zdrFor } from '../workspace.js';
import { loadFacts, routedCallPrice, callPrice } from '../models/facts.js';
import { ratingsFor } from '../models/arena.js';
import { profileOf, speedRule } from './profile.js';
import { selectCandidates, refThinksOf } from './select.js';
import { fitsFor } from './fit.js';
import { historyFor, fleetHistory } from './history.js';
import { judgementsFor, judgementCost } from './judge.js';
import { callsToClear } from './compare.js';
import { calibrationFor } from './calibrate.js';
import { armKey, referenceSpec } from '../learn/arms.js';

/* What a measurement WOULD do, worked out before anything is spent.
 *
 * One function, used by the page and by the run itself, so the screen can never promise
 * something the run then refuses or does differently. The page reads it from what is already
 * known, cached facts and cached judgements, and never waits on anybody; the run asks Jev for
 * whatever the page had to go without, and then chooses exactly as the page showed. */

const DAY = 86400000;

/* Which recorded answers are the customer's own model's, as a condition on a call `c` with its
   parameters in order: the reference, the workload, and the key of the plain reference strategy.
   A call answered through a switch records its lead model as the one that served it, and for the
   customer's own model thinking less, or pinned to its cheapest provider, that model is the reference
   itself: taken as the customer's own answer, a lighter answer was held against a full one, which
   loosened the bar for every candidate and scored the strategy partly against its own answers. Only
   a call no strategy served, or one the customer's own model served as it is (the control a switch is
   held against, the yardstick), carries the customer's own answer. */
const OWN_ANSWER = (c) => `${c}response_json IS NOT NULL AND ${c}served_model = ?
  AND (${c}arm_id IS NULL OR ${c}arm_id IN (SELECT a.id FROM arms a WHERE a.workload_id = ? AND a.key = ?))`;
export const ownArmKey = (workload) => armKey(referenceSpec(workload));

/** The calls a run is allowed to replay: this workload's own traffic, with content kept, at most
    EVAL_POOL_PER_DAY from each day, exactly as the run draws them. And how many of them carry the
    answer the customer's own model gave, which the run uses instead of paying for it again. */
async function eligible(workload) {
  const perDay = config.EVAL_POOL_PER_DAY;
  const r = await db.prepare(
    `SELECT COALESCE(SUM(LEAST(n, ?)), 0) AS n, COALESCE(SUM(own::float * LEAST(1.0, ?::float / n)), 0) AS own FROM (
        SELECT (c.created_at / 86400000) AS d, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE ${OWN_ANSWER('c.')}) AS own
          FROM calls c
         WHERE c.workload_id = ? AND c.request_json IS NOT NULL AND c.created_at >= ?
           AND c.source NOT IN ('replay', 'test') AND (c.status_code IS NULL OR c.status_code < 400)
         GROUP BY 1) x`)
    .get(perDay, perDay, String(workload.reference_model ?? ''), workload.id, ownArmKey(workload), workload.id, now() - 30 * DAY);
  const n = Number(r?.n || 0);
  return { n, recordedShare: n && config.EVAL_USE_RECORDED ? Math.min(1, Number(r.own || 0) / n) : 0 };
}

/* What a month of this workload is: how many calls it makes, and what they cost on the customer's
   own model. From its real traffic over the last thirty days, never from replays or tests. */
async function monthOf(workloadId) {
  const t = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, MIN(created_at) AS first FROM calls
      WHERE workload_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`)
    .get(workloadId, now() - 30 * DAY);
  const days = t?.n ? Math.min(30, Math.max(1, (now() - Number(t.first)) / DAY)) : 30;
  return { calls: (Number(t?.n || 0) / days) * 30, cost: (Number(t?.cost || 0) / days) * 30 };
}

/* What a measurement is worth, before anything is spent on it.

   Every model a measurement tries has a chance of clearing the bar and a share it would save, both
   from what is already known about it. The cheapest that clears wins, so the saving to expect is the
   first one down the list, cheapest first, that clears: each model's saving, times its chance, times
   the chance that every cheaper one did not. A workload already switched is only worth the part of
   that beyond what it saves now, and its measurement also protects the saving it has (a model that
   slipped is caught), which counts for EVAL_PROTECT_SHARE of it.

   A measurement nobody asked for runs only when that pays for it within EVAL_PAYBACK_MONTHS, and our
   fee is taken off the saving first, because the saving is only worth what the customer keeps. */
export function worthOf({ ranked, refPer, month, serving, tries, fee = config.ROUTING_FEE_PCT }) {
  const perMonth = refPer > 0 ? refPer * month.calls : month.cost;
  const servingRow = serving ? ranked.find((r) => r.model === serving && !r.key) : null;
  const servingShare = serving ? Math.max(0, Number(servingRow?.savingShare ?? 0)) : 0;
  const pool = ranked.filter((r) => r.savingShare !== null && r.savingShare > servingShare && !(serving && r.model === serving && !r.key))
    .slice(0, Math.max(1, tries))
    .sort((a, b) => b.savingShare - a.savingShare);
  let none = 1;
  let share = 0;
  const f = (Number(fee) || 0) / 100;
  for (const r of pool) {
    const p = Math.max(0, Math.min(1, Number(r.chance) || 0));
    const gain = Math.max(0, (r.savingShare - servingShare) - f * (1 - r.savingShare));
    share += gain * p * none;
    none *= 1 - p;
  }
  const expectedMonthlyUsd = Math.round(perMonth * share * 100) / 100;
  const protectedMonthlyUsd = Math.round(perMonth * servingShare * 100) / 100;
  const budgetUsd = Math.round(config.EVAL_PAYBACK_MONTHS
    * (expectedMonthlyUsd + config.EVAL_PROTECT_SHARE * protectedMonthlyUsd) * 100) / 100;
  return { monthlyUsd: Math.round(perMonth * 100) / 100, expectedMonthlyUsd, protectedMonthlyUsd, budgetUsd, chanceAny: Math.round((1 - none) * 1000) / 1000 };
}

/** The most one measurement may spend on this workload: at least what anybody may ask for, more when it is worth more. */
export const ceilingFor = (worth) => Math.max(config.EVAL_MAX_USD_PER_RUN,
  Math.min(config.EVAL_RUN_CAP_USD, Number(worth?.budgetUsd) || 0));

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
      WHERE r.model_id = ? AND r.status = 200 AND r.created_at >= ? AND r.recipe_json IS NULL
        AND r.call_id IN (SELECT id FROM calls WHERE workload_id = ? AND created_at >= ?)`)
    .get(workload.reference_model, now() - config.REPLAY_REUSE_DAYS * DAY, workload.id, now() - 30 * DAY)).n;
  return Math.min(1, Number(n) / Math.max(1, sample * 2));
}

/* Work for Jev a later look at the page will want: readings of how each model suits this
   task, and which leaderboard entry each model is. Queued, never waited on here. */
let queueFit = null;
export const onMissingFits = (fn) => { queueFit = fn; };

/* A page asks for the plan every couple of seconds while a measurement runs, and the plan reads
   a good deal to answer. The page's copy is kept for a few seconds, under everything about the
   workload that changes what it says, so a change of setting shows at once. A measurement, and a
   press of Measure now, always work it out afresh. */
const pageMemo = new Map();
const PAGE_MEMO_MS = 10000;
export const forgetPlan = (workloadId) => pageMemo.delete(workloadId);
// every page copy at once, after a workspace-wide setting that changes what a plan says
export const forgetPlanAll = () => pageMemo.clear();

/* The whole plan, and whether it can run. `reason` is written to be shown to somebody as it
   is: it is the sentence under a button that cannot be pressed. */
export async function planFor(workload, { canRoute, forRun = false, memo = false, automatic = false } = {}) {
  if (memo && !forRun) {
    const key = [workload.speed_pref, workload.routed_model, workload.reference_model, workload.status, canRoute].join('|');
    const hit = pageMemo.get(workload.id);
    if (hit && hit.key === key && Date.now() - hit.at < PAGE_MEMO_MS) return hit.plan;
    const plan = await planFor(workload, { canRoute, forRun: false });
    pageMemo.set(workload.id, { key, at: Date.now(), plan });
    return plan;
  }
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const models = modelCountFor(ws);
  const { n: pool, recordedShare } = await eligible(workload);
  const sample = sampleSizeFor(pool);
  const plan = {
    pool, sample, models, candidates: [], order: [], funnel: [], excluded: [], waiting: 0,
    estimateUsd: null, canRun: false, reason: null, reference: workload.reference_model,
    judge: jevUsable() ? 'jev' : 'llm', jevResting: jevResting(), factsAt: {}, speed: null, profile: null, pendingJev: 0,
    difficulty: null, cachedBar: 0, refThinks: null, recordedShare, worth: null, notWorth: false,
    ceilingUsd: config.EVAL_MAX_USD_PER_RUN, optimizeBudget: null,
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
  const refThinks = refThinksOf(facts.models.get(workload.reference_model) || null, profile.refThinking, profile.thinking);
  plan.factsAt = facts.syncedAt;
  plan.profile = profile;
  plan.speed = speed;
  plan.refThinks = refThinks;
  const base = {
    facts, profile, reference: workload.reference_model, enabled, want: models,
    tryMultiple: config.EVAL_TRY_MULTIPLE, reverted: history.reverted, serving: workload.routed_model,
    history, speed, refThinks, speedHistory: fleet.speed, busy: fleet.busy, config, at: now(),
    zdrOnly: await zdrFor(workload.workspace_id),
    calibration: await calibrationFor(workload.workspace_id),
  };

  // who survives the rules, before anything is ranked
  const first = selectCandidates(base);
  const survivors = first.ranked.map((r) => r.model);

  /* What a measurement is worth, from what is known before Jev reads anything, so one nobody asked for
     that would not pay for itself costs nothing at all to turn down. */
  const month = await monthOf(workload.id);
  const tries = Math.max(models, Math.round(models * config.EVAL_TRY_MULTIPLE));
  plan.cachedBar = await cachedBarShare(workload, sample);
  plan.worth = worthOf({ ranked: first.ranked, refPer: first.refPrice ?? 0, month, serving: workload.routed_model, tries });
  /* A measurement nobody asked for waits until it has enough calls to show anything: on too few, even a
     model that matched every answer could not clear the bar, and all it would buy is a bar. */
  if (automatic) {
    const barPct = Number(workload.floor_pct) > 0 ? Number(workload.floor_pct)
      : workload.shape_kind === 'free_text' ? config.EVAL_FIRST_FLOOR_TEXT_PCT : config.EVAL_FLOOR_MIN_PCT;
    const need = callsToClear(barPct);
    if (sample < need) {
      const poolNeed = Math.ceil(need / config.EVAL_SAMPLE_SHARE);
      const perDay = month.calls / 30;
      plan.notWorth = true;
      plan.waitMs = perDay > 0 ? ((poolNeed - pool) / perDay) * DAY : null;
      plan.reason = `Waiting for more calls: a measurement on ${sample} of them could not show a cheaper model is as good as yours `
        + `at a ${barPct.toFixed(barPct < 10 ? 1 : 0)}% bar, even one that matched every answer. It takes about ${need}, which `
        + `${poolNeed} calls in thirty days gives${perDay > 0 ? `, about ${Math.max(1, Math.ceil((poolNeed - pool) / perDay))} days away at your pace` : ''}. `
        + 'It starts by itself then, and you can measure now whenever you like.';
      return plan;
    }
  }
  if (automatic && first.order.length) {
    const early = estimate({ ...plan, order: first.order, refPrice: first.refPrice }, profile, facts, workload);
    if (early > plan.worth.budgetUsd) {
      plan.notWorth = true;
      plan.estimateUsd = early;
      plan.reason = notWorthReason(early, plan.worth);
      return plan;
    }
  }

  // what Jev and the leaderboard say about the survivors; the run asks for what is missing
  /* Jev reads the models only for a measurement, which pays for the reading like any other call. It
     used to read them whenever a workload page was opened, which spent money nobody was charged for. */
  const { fits, difficulty, cost: fitCost } = await fitsFor(profile, survivors, facts, { compute: forRun });
  plan.fitCost = Number(fitCost) || 0;
  const arena = await ratingsFor([workload.reference_model, ...survivors], facts, { link: forRun });
  plan.pendingJev = jevUsable() ? survivors.filter((id) => !fits.has(id)).length : 0;
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

  plan.estimateUsd = estimate(plan, profile, facts, workload);
  plan.worth = worthOf({ ranked: sel.ranked, refPer: sel.refPrice ?? 0, month, serving: workload.routed_model, tries });
  plan.ceilingUsd = ceilingFor(plan.worth);
  plan.worth.worthIt = plan.estimateUsd <= plan.worth.budgetUsd;
  if (plan.estimateUsd > plan.ceilingUsd) {
    plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)}, over the $`
      + `${plan.ceilingUsd.toFixed(2)} one measurement of this workload may spend. `
      + 'Testing fewer models in Settings brings it down.';
    return plan;
  }
  /* A measurement nobody asked for runs only when it pays for itself. A person can always ask. */
  if (automatic && !plan.worth.worthIt) {
    plan.notWorth = true;
    plan.reason = notWorthReason(plan.estimateUsd, plan.worth);
    return plan;
  }
  /* The workspace's own ceiling on optimizing, measurements and background answers together, over the
     last thirty days. Nothing is spent past it, whoever asks. */
  const budget = ws?.optimize_budget_usd == null ? null : Number(ws.optimize_budget_usd);
  if (budget !== null) {
    const spent = await optimizeSpent(workload.workspace_id);
    const left = Math.max(0, budget - spent);
    plan.optimizeBudget = { budgetUsd: budget, spentUsd: spent, leftUsd: Math.round(left * 100) / 100 };
    if (plan.estimateUsd > left) {
      plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)}, and $${left.toFixed(2)} of your $`
        + `${budget.toFixed(2)} optimization budget for the last thirty days is left. Raise it in Settings, `
        + 'or this can run once earlier spending is more than thirty days old.';
      return plan;
    }
  }
  /* The plan's monthly allowance is spent before the balance, so a plan customer with no balance can
     still measure within it. */
  const gate = await gateEval(workload.workspace_id, { estimatedUsd: plan.estimateUsd });
  if (!gate.ok) {
    const free = Math.max(0, Number(gate.free ?? 0));
    plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)}, and `
      + (gate.allowance > 0 ? `$${gate.allowance.toFixed(2)} of this month's allowance and ` : '')
      + `$${free.toFixed(2)} of balance are free. Add credit and it can run.`;
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
  /* The bar's two answers for each call, less those already paid for, and less the one the customer's
     own model recorded, which is read rather than bought. */
  const barPaid = Math.max(0, plan.sample * 2 * (1 - (plan.cachedBar || 0)) - plan.sample * (plan.recordedShare || 0));
  let total = refPer * barPaid;
  const finalists = plan.order.slice(0, plan.models);
  /* The second look: the cheapest that clears, on calls it has never seen, as many as a perfect run
     at the lowest bar needs, times EVAL_CONFIRM_MULTIPLE. Only when there are that many to look at. */
  const least = callsToClear(config.EVAL_FLOOR_MIN_PCT);
  const fresh = Math.max(0, (plan.pool || 0) - plan.sample);
  if (fresh >= least && finalists.length) {
    const looks = Math.min(fresh, Math.max(config.EVAL_CONFIRM_MIN, Math.ceil(config.EVAL_CONFIRM_MULTIPLE * least), plan.sample));
    const cheapestPrice = Math.min(...finalists.map((c) => c.price));
    total += looks * (cheapestPrice + refPer * (2 - (plan.recordedShare || 0)));
    if (workload.shape_kind === 'free_text') {
      const llm = facts.models.get(config.EVAL_JUDGE_MODEL);
      const llmPer = llm ? callPrice(llm, Math.min(pin, 600) + 400, 6) : 0;
      total += looks * judgementCost(pin, pout, llmPer);
    }
  }
  const extra = plan.order.slice(plan.models);
  for (const c of finalists) total += c.price * plan.sample;
  for (const c of extra) total += c.price * Math.min(plan.sample, config.EVAL_SCREEN_CALLS);
  /* Strategies for the cheaper models that cannot manage alone: up to two dropped part way have
     their other calls finished, and up to three have each answer checked once by Jev. */
  const cheapest = [...plan.order].sort((a, b) => a.price - b.price).slice(0, 3);
  for (const c of cheapest.slice(0, 2)) total += c.price * plan.sample * 0.5;
  if (jevUsable()) {
    const perCheck = ((Math.min(pin, 700) + Math.min(pout, 700) + 350) * config.JEV_PRICE_PER_MTOK) / 1e6;
    total += cheapest.length * plan.sample * perCheck;
  }
  const judged = judgementsFor(workload.shape_kind, plan.sample, finalists.length);
  if (judged) {
    const llm = facts.models.get(config.EVAL_JUDGE_MODEL);
    const llmPer = llm ? callPrice(llm, Math.min(pin, 600) + 400, 6) : 0;
    total += judged * judgementCost(pin, pout, llmPer);
  }
  return Math.round(total * 1e8) / 1e8;
}

function notWorthReason(cost, worth) {
  return `Not worth measuring by itself yet: it would cost about $${cost.toFixed(2)}, and we expect it to find `
    + `about $${worth.expectedMonthlyUsd.toFixed(2)} a month`
    + (worth.protectedMonthlyUsd > 0 ? `, on top of the $${worth.protectedMonthlyUsd.toFixed(2)} a month it saves now` : '')
    + `. It runs by itself once it would pay for itself within ${config.EVAL_PAYBACK_MONTHS} months; you can measure now whenever you like.`;
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
