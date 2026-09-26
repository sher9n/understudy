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
import { historyFor, fleetHistory, cantKeepUpOn } from './history.js';
import { judgePrices, canJudge } from './judge.js';
import { callsToClear } from './compare.js';
import { calibrationFor } from './calibrate.js';
import { FOUND, OUTCOME_OF } from './outcome.js';
import { servingKey, heldBack } from './promote.js';
import { armKey, referenceSpec, armById } from '../learn/arms.js';
import { ROUTER_VERSION } from '../learn/kinds.js';

const parseRecipe = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

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

/** The calls a run is allowed to replay: this workload's own traffic over thirty days, with content kept,
    every one of them up to EVAL_POOL_MAX, exactly as the run draws them (by count, never capped by day).
    And how many of them carry the answer the customer's own model gave, which the run uses instead of
    paying for it again: the same share as over all of them, since the run takes each day in turn. */
async function eligible(workload) {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ${OWN_ANSWER('c.')}) AS own
       FROM calls c
      WHERE c.workload_id = ? AND c.request_json IS NOT NULL AND c.created_at >= ?
        AND c.source NOT IN ('replay', 'test') AND (c.status_code IS NULL OR c.status_code < 400)`)
    .get(String(workload.reference_model ?? ''), workload.id, ownArmKey(workload), workload.id, now() - 30 * DAY);
  const all = Number(r?.n || 0);
  const n = Math.min(all, config.EVAL_POOL_MAX);
  return { n, recordedShare: all && config.EVAL_USE_RECORDED ? Math.min(1, Number(r.own || 0) / all) : 0 };
}

/** How many calls a measurement of this workload could draw on now, counted exactly as a run counts them
    (see eligible): what a workload waiting for calls is waiting to reach (measureWhenReady in src/proxy.js). */
export const usableCalls = async (workload) => (await eligible(workload)).n;

/** The bar a measurement nobody asked for is sized for (the workload's own, or before it has one, the first bar
    for its kind of answer), how many calls a sample needs to clear it even with every answer matching, and how
    many usable calls give a sample that size. */
export function barNeed(workload) {
  const barPct = Number(workload?.floor_pct) > 0 ? Number(workload.floor_pct)
    : workload?.shape_kind === 'free_text' ? config.EVAL_FIRST_FLOOR_TEXT_PCT : config.EVAL_FLOOR_MIN_PCT;
  const need = callsToClear(barPct);
  return { barPct, need, calls: Math.max(config.EVAL_MIN_CALLS, Math.ceil(need / config.EVAL_SAMPLE_SHARE)) };
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
   fee is taken off the saving first, because the saving is only worth what the customer keeps.

   What serves is found by its own name (`servingAs`, see servingKey): the customer's own model
   thinking less, or from its cheapest provider, is the reference by model, and looked for by model it
   was never found, so its saving counted as protecting nothing and it was counted again as a new
   saving to find. A strategy is known by its lead model's row, the nearest there is. */
export function worthOf({ ranked, refPer, month, serving, servingAs = null, tries, fee = config.ROUTING_FEE_PCT }) {
  const perMonth = refPer > 0 ? refPer * month.calls : month.cost;
  const nameOf = (r) => r.key || r.model;
  const servingRow = serving ? (ranked.find((r) => servingAs && nameOf(r) === servingAs)
    || ranked.find((r) => r.model === serving && !r.key)) : null;
  const servingShare = serving ? Math.max(0, Number(servingRow?.savingShare ?? 0)) : 0;
  const pool = ranked.filter((r) => r.savingShare !== null && r.savingShare > servingShare && r !== servingRow)
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

export async function enabledSet(workspaceId) {
  return new Set((await db.prepare(
    `SELECT c.model_id FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1`).all(workspaceId)).map((r) => r.model_id));
}

/* What earlier measurements of this workload have drawn on, among the calls a run could draw now,
   and how much of a bar is already paid for on the calls it would actually draw. As shares of those
   calls, so they can be read against the pool, which is capped a day at a time.

   A run steers away from every call a finished measurement used, so that a lucky sample is not
   simply measured again, and what those calls bought is no help to its bar: counted as paid for, it
   quoted a re-check a nearly free bar that it then bought in full. Calls a measurement that was
   stopped or cut short drew are not steered away from, and what it bought for them is used again.
   A second look never uses a call any measurement has looked at. A call's bar is paid for when both
   of the customer's model's answers are kept, or when its own recorded answer is one of them and the
   other is kept. */
async function drawnFor(workload) {
  const row = await db.prepare(
    `WITH eligible AS (
        SELECT c.id, (?::boolean AND ${OWN_ANSWER('c.')}) AS rec
          FROM calls c
         WHERE c.workload_id = ? AND c.request_json IS NOT NULL AND c.created_at >= ?
           AND c.source NOT IN ('replay', 'test') AND (c.status_code IS NULL OR c.status_code < 400)),
      drawn AS (
        SELECT s.call_id, bool_or(${FOUND('r.')}) AS used
          FROM eval_samples s JOIN eval_runs r ON r.id = s.run_id
         WHERE r.workload_id = ? GROUP BY s.call_id),
      kept AS (
        SELECT k.call_id, COUNT(DISTINCT k.slot) AS slots, bool_or(k.slot = 1) AS second
          FROM replay_cache k
         WHERE k.model_id = ? AND k.status = 200 AND k.recipe_json IS NULL AND k.created_at >= ?
           AND k.call_id IN (SELECT id FROM eligible)
         GROUP BY k.call_id)
     SELECT COUNT(*) AS n,
            COUNT(*) FILTER (WHERE d.used) AS used,
            COUNT(*) FILTER (WHERE d.call_id IS NOT NULL) AS seen,
            COUNT(*) FILTER (WHERE NOT COALESCE(d.used, false) AND (k.slots >= 2 OR (e.rec AND k.second))) AS paid_fresh,
            COUNT(*) FILTER (WHERE d.used AND (k.slots >= 2 OR (e.rec AND k.second))) AS paid_used
       FROM eligible e LEFT JOIN drawn d ON d.call_id = e.id LEFT JOIN kept k ON k.call_id = e.id`)
    .get(!!config.EVAL_USE_RECORDED, String(workload.reference_model ?? ''), workload.id, ownArmKey(workload),
      workload.id, now() - 30 * DAY, workload.id, String(workload.reference_model ?? ''), now() - config.REPLAY_REUSE_DAYS * DAY);
  const n = Number(row?.n || 0);
  const share = (x) => (n ? Number(x || 0) / n : 0);
  return { used: share(row?.used), seen: share(row?.seen), paidFresh: share(row?.paid_fresh), paidUsed: share(row?.paid_used) };
}

/* Which of these models a measurement of this workload would try: switched on in its workspace,
   able to do what its calls ask (their length, tools and structured answers, and keeping nothing when
   the workspace requires that), able to answer within its cap on answers, not being retired,
   answering reliably, cheaper than the customer's model at the price that would really be paid, not
   far too slow by what its providers publish, and not switched back before. The plan's own rules, on
   these models alone, from what is already known: nothing is asked of anybody. */
export async function wouldTry(workload, modelIds) {
  if (!workload?.reference_model || !modelIds?.length) return [];
  const facts = await loadFacts();
  const asked = new Set(modelIds.filter((m) => facts.models.has(m)));
  if (!asked.size) return [];
  const keep = new Set([...asked, workload.reference_model, workload.routed_model].filter(Boolean));
  const models = new Map([...facts.models].filter(([m]) => keep.has(m)));
  const profile = await profileOf(workload);
  const sel = selectCandidates({
    facts: { ...facts, models }, profile, reference: workload.reference_model,
    enabled: await enabledSet(workload.workspace_id), want: keep.size, tryMultiple: 1,
    reverted: await heldBack(workload.id), cantKeepUp: await cantKeepUpOn(workload.id),
    serving: workload.routed_model, servingAs: await servingKey(workload),
    speed: speedRule(workload, profile, config),
    refThinks: refThinksOf(facts.models.get(workload.reference_model) || null, profile.refThinking, profile.thinking),
    config, at: now(), zdrOnly: await zdrFor(workload.workspace_id),
  });
  return sel.ranked.filter((r) => !r.key && asked.has(r.model) && r.model !== workload.routed_model).map((r) => r.model);
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
/* `only`, a set of model ids, plans a measurement of those models alone: a second look at the ones that passed once and had
   too few new calls to be looked at again (a run with trigger 'second_look', see pendingSecondLook in src/eval/run.js),
   quoted and turned down on what that costs, not on what a whole measurement would. */
export async function planFor(workload, { canRoute, forRun = false, memo = false, automatic = false, only = null } = {}) {
  if (memo && !forRun) {
    const key = [workload.speed_pref, workload.judge_mode, workload.routed_model, workload.reference_model, workload.status, canRoute].join('|');
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
    ceilingUsd: config.EVAL_MAX_USD_PER_RUN, optimizeBudget: null, unseenPool: pool, yardstick: null,
    // how many setups of a router serving now are measured whatever the model count says (0 when none serves)
    routerParts: 0,
  };

  if (!canRoute) {
    plan.reason = 'Routing is not configured on this deployment, so nothing can be replayed.';
    return plan;
  }
  if (!workload.reference_model) {
    plan.reason = "We don't know which model this workload runs on yet, so there is nothing to compare other models with.";
    return plan;
  }
  if (pool < config.EVAL_MIN_CALLS) {
    plan.reason = `${pool} of the ${config.EVAL_MIN_CALLS} calls we need. `
      + 'Keep sending traffic and this turns on by itself.';
    // the calls it waits for: the one that brings the count to them starts it (see waitForCalls)
    plan.needCalls = config.EVAL_MIN_CALLS;
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
  const servingAs = workload.routed_model ? await servingKey(workload) : null;
  const base = {
    facts, profile, reference: workload.reference_model, enabled, want: models,
    tryMultiple: config.EVAL_TRY_MULTIPLE, reverted: history.reverted, cantKeepUp: history.cantKeepUp,
    serving: workload.routed_model, servingAs,
    servingRecipe: parseRecipe(workload.routed_recipe),
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
  /* The calls this run would draw, and how many of them earlier measurements already paid a bar for;
     and the calls no measurement has looked at, which is all a second look may use. */
  const drawn = await drawnFor(workload);
  const freshPool = Math.round(pool * (1 - drawn.used));
  const paidFresh = Math.round(pool * drawn.paidFresh);
  const paidUsed = Math.round(pool * drawn.paidUsed);
  plan.cachedBar = sample ? Math.min(sample, paidFresh + Math.min(Math.max(0, sample - freshPool), paidUsed)) / sample : 0;
  plan.unseenPool = Math.round(pool * (1 - drawn.seen));
  // the yardstick the last measurement that compared anything used, when there was one: it decides what the judging costs
  const lastCompared = await db.prepare(
    `SELECT yardstick, plan_json FROM eval_runs WHERE workload_id = ? AND yardstick IS NOT NULL AND ${FOUND()} AND ${OUTCOME_OF()} = 'compared'
      ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  plan.yardstick = lastCompared?.yardstick ?? null;
  /* Whether that measurement read the work as plainly not open-ended writing (planRecord.judging in src/eval/run.js): it
     differed from itself in figures, facts or decisions, or few of its requests read as open-ended. Only then is a written
     workload judged automatically quoted "the same answer" alone; one read before open-ended writing was looked for, or
     read near the line, may be held to "at least as good" this time, and is quoted the dearer. */
  let lastJudging = null;
  try { lastJudging = JSON.parse(lastCompared?.plan_json || 'null')?.judging ?? null; } catch { lastJudging = null; }
  const open = lastJudging?.openEnded;
  plan.closedWork = !!(lastJudging && lastJudging.mode === 'auto' && !lastJudging.reason && open
    && (open.share === null || (Number(open.share) < config.EVAL_OPEN_ENDED_KEEP_SHARE && !open.yes)));
  /* Whether the customer's model last disagreed with itself too often for "the same answer" to be a bar: a structured
     workload is then held to "at least as good" too, which is judged, and the quote counts that judging. */
  const lastBar = await db.prepare(`SELECT noise_pct FROM eval_runs WHERE workload_id = ? AND status = 'done' AND noise_pct IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  plan.noisy = Number(lastBar?.noise_pct) > config.EVAL_NOISE_MAX_PCT;
  plan.worth = worthOf({ ranked: first.ranked, refPer: first.refPrice ?? 0, month, serving: workload.routed_model, servingAs, tries });
  /* A measurement nobody asked for waits until it has enough calls to show anything: on too few, even a
     model that matched every answer could not clear the bar, and all it would buy is a bar. */
  if (automatic) {
    const { barPct, need, calls: poolNeed } = barNeed(workload);
    if (sample < need) {
      plan.notWorth = true;
      /* The calls it waits for, counted as a run counts them: the call that brings the count to them starts it
         (see waitForCalls). It used to be booked for when they were guessed to arrive, from the pace so far and
         never sooner than six hours, and a new workload that had them within the hour waited the six. A sample
         bigger than the most a measurement takes waits for no call, since none could bring it. */
      plan.needCalls = need <= config.EVAL_SAMPLE_MAX ? poolNeed : null;
      plan.reason = `Waiting for more calls: a measurement on ${sample} of them could not show a cheaper model is as good as yours `
        + `at a ${barPct.toFixed(barPct < 10 ? 1 : 0)}% bar, even one that matched every answer. It takes about ${need}, which `
        + `${poolNeed} calls from the last thirty days give, however many of them arrive in one day. `
        + 'It starts by itself as soon as they are here, and you can measure now whenever you like.';
      return plan;
    }
  }
  // (a plan of some models only is quoted on those models, below, never on everything a whole measurement would try)
  if (automatic && first.order.length && !only) {
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
  plan.order = [...sel.order];
  plan.waiting = sel.waiting;
  plan.refPrice = sel.refPrice;
  plan.refHealth = sel.refHealth;
  /* A router by kind of request serving now has every one of its setups answer every call, first (see
     servingParts in run.js), so the quote counts each of them among the models measured to the end, and
     prices one the plan held back or left out like the rest. Quoted as the plan had them, a router of
     three setups was quoted for one or two, and ran into the most a measurement may spend. */
  const servingArm = workload.routed_arm_id ? await armById(workload.routed_arm_id) : null;
  if (servingArm?.spec?.kind === 'router' && Number(servingArm.spec.version) === ROUTER_VERSION && Array.isArray(servingArm.spec.options)) {
    const ref = workload.reference_model;
    const partKey = (p) => (p.model === ref && p.recipe?.reasoning ? `${ref}#lighter`
      : p.model === ref && p.recipe?.pinned ? `${ref}#cheapest` : p.model);
    const pin = profile.promptAvg || 0;
    const pout = profile.outAvg || 0;
    const front = servingArm.spec.options.map((o) => {
      const k = o.key || partKey(o);
      const at = plan.order.findIndex((q) => (q.key || q.model) === k);
      if (at >= 0) return plan.order.splice(at, 1)[0];
      const m = facts.models.get(o.model);
      const price = m ? (routedCallPrice(m, pin, pout, profile.hours) ?? callPrice(m, pin, pout, profile.hours) ?? 0) : 0;
      return { model: o.model, key: k === o.model ? undefined : k, recipe: o.recipe ?? null, price, label: null, chance: null,
        savingShare: null, parts: null, family: null, note: 'part of the router serving now' };
    });
    plan.order = [...front, ...plan.order];
    plan.models = Math.max(plan.models, front.length);
    plan.routerParts = front.length;
  }
  if (only) {
    // the models it was asked for, as the plan had them (their recipes and ranks), and nothing else
    plan.order = plan.order.filter((q) => only.has(q.model));
    plan.models = Math.max(1, plan.order.length);
    plan.routerParts = 0;
    plan.only = [...only];
  }
  plan.candidates = plan.order.map((r) => ({ model_id: r.model, per: r.price, recipe: r.recipe }));

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
  plan.worth = worthOf({ ranked: sel.ranked, refPer: sel.refPrice ?? 0, month, serving: workload.routed_model, servingAs, tries });
  plan.ceilingUsd = ceilingFor(plan.worth);
  plan.worth.worthIt = plan.estimateUsd <= plan.worth.budgetUsd;
  if (plan.estimateUsd > plan.ceilingUsd) {
    /* Testing fewer models brings it down only to the setups of the router serving now, which are always
       checked: said as that where they are what the measurement tests, rather than advice that cannot help. */
    const forced = plan.routerParts > 0 && plan.models <= plan.routerParts;
    plan.reason = `This would cost about $${plan.estimateUsd.toFixed(2)}, over the $`
      + `${plan.ceilingUsd.toFixed(2)} one test of this workload may spend. `
      + (forced
        ? `It checks all ${plan.routerParts} models of the router serving it now, however few models you test in Settings. `
          + `Its live requests are still watched${config.CONTROL_ENABLED ? `, and, within your optimization budget, a few a day are checked against ${short(workload.reference_model)} in the background` : ''}.`
        : 'Testing fewer models in Settings brings it down.');
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

/* What a measurement is expected to cost, from this workload's own average call: what the run will
 * actually do, so that the quote a person sees, the test of whether a measurement nobody asked for
 * pays for itself, and the limit a run keeps to are never below what it spends.
 *
 * The bar: the customer's own model twice on each sampled call, one of the two read from the call
 * itself where its own answer was recorded, less the calls whose bar is already paid for among the
 * ones this run will draw (see drawnFor). A re-check draws calls no finished measurement used, so
 * what earlier ones bought seldom helps it.
 *
 * The race: the models measured to the end answer every call, and the ones dropped early the few
 * calls they answered first.
 *
 * The second look: up to EVAL_CONFIRM_TRIES of the cheapest that clear, each on calls no measurement
 * of this workload has looked at, as many as the run would take, with the customer's model answering
 * them too (once: every look in a run is on the same calls). It used to price one look though a run
 * takes two.
 *
 * Written answers are judged, and each judgement is priced at what it costs (see judgePrices): the
 * bar's pairs, the pairs whose answer is known that test the judge, and every candidate answer. When
 * the customer's own model varies too much for "the same answer" to be a bar, every pair is read again
 * for "at least as good", both ways round, and the candidates are judged that way too, by whichever
 * judge got the planted answers right. The run finds out which it needs as it goes, so a workload not
 * compared before is quoted the dearer.
 *
 * Strategies for the cheaper models that cannot manage alone, and Jev's reading of how the models
 * suit the task, which the measurement pays for, are counted too. */
const FIT_TOKENS = 1500;
function estimate(plan, profile, facts, workload) {
  const pin = profile.promptAvg || 0;
  const pout = profile.outAvg || 0;
  const refModel = facts.models.get(workload.reference_model);
  const refPer = plan.refPrice ?? (refModel ? routedCallPrice(refModel, pin, pout, profile.hours)
    ?? callPrice(refModel, pin, pout, profile.hours) : 0) ?? 0;
  const s = plan.sample;
  const recorded = Math.max(0, Math.min(1, plan.recordedShare || 0));
  // the customer's model on a call it has not answered before: two answers, one of them read where it was recorded
  const refCall = refPer * (2 - recorded);
  const covered = Math.min(s, Math.round((plan.cachedBar || 0) * s));
  let total = refCall * (s - covered);

  const finalists = plan.order.slice(0, plan.models);
  const extra = plan.order.slice(plan.models);
  const screened = Math.min(s, config.EVAL_SCREEN_CALLS);
  for (const c of finalists) total += c.price * s;
  for (const c of extra) total += c.price * screened;

  /* Judging written answers, by the yardstick the run will use, or the dearer when that is not known yet. A structured
     workload is compared field by field, which is free, unless its model last disagreed with itself too often for that
     to be a bar (plan.noisy), when it is held to "at least as good" like written work. */
  const text = workload.shape_kind === 'free_text';
  const judged = canJudge() && (text || (config.EVAL_QUALITY_YARDSTICK && (plan.yardstick === 'quality' || plan.noisy)));
  const prices = judged ? judgePrices(pin, pout, facts.models.get(config.EVAL_JUDGE_MODEL)) : null;
  /* Written work is judged as its setting says (workloads.judge_mode), and automatically as the run decides: "at least as
     good" for varied or open-ended work (see judgeMode in src/eval/run.js). Automatically, a workload last held to "the
     same answer" is quoted that alone only where its work read as plainly not open-ended (plan.closedWork). */
  const mode = text && ['same', 'quality'].includes(workload.judge_mode) ? workload.judge_mode : 'auto';
  const yardsticks = !prices ? []
    : !text ? ['quality']
      : !config.EVAL_QUALITY_YARDSTICK || mode === 'same' ? ['agreement']
        : mode === 'quality' || plan.yardstick === 'quality' ? ['quality']
          : plan.yardstick === 'agreement' && (plan.closedWork || !config.EVAL_OPEN_ENDED) ? ['agreement'] : ['agreement', 'quality'];
  /* Reading what kind of writing the requests ask for, when judged automatically: up to EVAL_OPEN_ENDED_ASK requests, each
     read by Jev and, where Jev cannot answer one, by the language model, at no more than one reading of a pair (half of
     llmQuality, which is two). */
  if (prices && text && mode === 'auto' && config.EVAL_OPEN_ENDED && config.EVAL_QUALITY_YARDSTICK) {
    const perRead = (jevUsable() ? ((Math.min(pin, 2500) + 250) * config.JEV_PRICE_PER_MTOK) / 1e6 : 0) + prices.llmQuality / 2;
    total += Math.min(s, config.EVAL_OPEN_ENDED_ASK) * perRead;
  }
  const judging = yardsticks.map((yard) => {
    const quality = yard === 'quality';
    const pair = quality ? prices.quality : prices.bar;
    const answer = quality ? prices.quality : prices.candidate;
    /* Every written pair read for sameness first, and again for "at least as good". Held to that, the judge is tested
       on up to ten planted answers, read again by the language model where Jev misses one, two of them put into another
       language first, and the instruction is read once as a checklist; held to the same answer, on up to four. */
    const planted = quality ? 10 * (prices.quality + prices.llmQuality) + 2 * prices.translate + prices.checklist : 4 * pair;
    const bar = (text ? s * prices.bar : 0) + (quality ? s * prices.quality : 0) + planted;
    return { pair, answer, cost: bar + (finalists.length * s + extra.length * screened) * answer };
  }).sort((a, b) => b.cost - a.cost)[0] || null;
  if (judging) total += judging.cost;

  /* The second look. Whether there are enough unseen calls for one is read at the loosest bar this
     workload can be expected to have, and how many it takes at the bar it had last, or at the
     tightest there is when it has had none, so the quote is never short of a look the run takes. */
  const looseBar = Number(workload.floor_pct) > 0 ? Number(workload.floor_pct)
    : workload.shape_kind === 'free_text' ? config.EVAL_FIRST_FLOOR_TEXT_PCT : config.EVAL_FLOOR_MIN_PCT;
  const sizeBar = Number(workload.floor_pct) > 0 ? Number(workload.floor_pct) : config.EVAL_FLOOR_MIN_PCT;
  const unseen = Math.max(0, Math.round(plan.unseenPool ?? plan.pool ?? 0) - s);
  const looked = [...finalists].sort((a, b) => a.price - b.price).slice(0, Math.max(0, config.EVAL_CONFIRM_TRIES));
  if (looked.length && unseen >= callsToClear(looseBar)) {
    const looks = Math.min(unseen, Math.max(config.EVAL_CONFIRM_MIN, Math.ceil(config.EVAL_CONFIRM_MULTIPLE * callsToClear(sizeBar)), s));
    // the customer's model on the looked-at calls, and its two answers compared, once for every look
    total += looks * refCall + (judging ? looks * judging.pair : 0);
    for (const c of looked) total += looks * (c.price + (judging ? judging.answer : 0));
  }

  /* Strategies for the cheaper models that cannot manage alone: up to two dropped part way have
     their other calls finished, and up to three have each answer checked once by Jev. */
  const cheapest = [...plan.order].sort((a, b) => a.price - b.price).slice(0, 3);
  for (const c of cheapest.slice(0, 2)) total += c.price * s * 0.5;
  if (jevUsable()) {
    const perCheck = ((Math.min(pin, 700) + Math.min(pout, 700) + 350) * config.JEV_PRICE_PER_MTOK) / 1e6;
    total += cheapest.length * s * perCheck;
  }
  // Jev's reading of how the models suit the task: what the run paid, or what the ones not read yet will cost
  total += plan.fitCost > 0 ? plan.fitCost : ((plan.pendingJev || 0) * FIT_TOKENS * config.JEV_PRICE_PER_MTOK) / 1e6;
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
