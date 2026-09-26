import { db, id, now, round8 } from '../db/index.js';
import config, { canRoute } from '../config.js';
import { priceCall } from '../openrouter.js';
import { addActivity } from '../traffic.js';
import { gateEval, chargeEval, hold, release as releaseHold, allowanceLeft, withFee } from '../billing.js';
import { planFor, ownArmKey, barNeed } from './plan.js';
import { judgeBarPair, judgeCandidate, judgeQuality, canJudge, translated, openEndedOf, numbersDiffer, numbersOf } from './judge.js';
import { checklistFor, breakOne } from './checklist.js';
import { extract, disagreement, gates, floorFrom, marginFloor, verdictWith, sampleCalls, barIsMeaningful, structuredCompare, proseText, callsToClear } from './compare.js';
import { promote, revert, trafficOf, everReverted } from './promote.js';
import { replayOnce } from './replay.js';
import { thinkingFit } from './select.js';
import { loadFacts } from '../models/facts.js';
import { forgetFleet } from './history.js';
import { OUTCOME_OF, OUTCOME_CASE, FOUND, cheaperCleared, confirmed } from './outcome.js';
import { reportCallFailure } from '../alerts.js';
import { jevUsable } from '../jev.js';
import { structureOf, jevCheck, requestText, answerText as checkedText } from '../learn/check.js';
import { simulateCascade, simulateRouter, bestOf, crossFit } from '../learn/simulate.js';
import { featuresOf, predict } from '../learn/router.js';
import { featuresRaw, crossFitRouter, simulateRoutes, routeOf, ROUTER_VERSION } from '../learn/kinds.js';
import { chanceWithin, safeSaving, rankCleared, routingModeOf } from './confidence.js';
import { askOf } from './ask.js';
import { labelOf, armById, leadModel, nameOfResult, armsFor, setStatus } from '../learn/arms.js';
import { servingKey, keyOfSpec } from './promote.js';
import { markTrying } from '../learn/explore.js';
import { forgetBar } from '../learn/control.js';
import { scheduleNext, deferAutomatic, deferAfterStop, deferAfterFailure, cadenceOf, waitForCalls } from './schedule.js';
import { notify } from '../notify.js';

/* A measurement, run as a race.
 *
 * The bar comes first: the customer's own model answers each sampled call twice, and how often
 * it disagrees with itself sets how far a cheaper model may stray. Answers already paid for by an
 * earlier measurement are used again instead of being bought twice.
 *
 * Then the models the plan ranked are tried in that order, several at once, each on the same
 * calls. A model is dropped the moment it cannot win: when a provider refuses it, when even
 * answering every remaining call exactly right could not bring it inside the bar, or when it is
 * slower than the workload's speed setting allows. Its place goes to the next in line, until the
 * number of models asked for in Settings have answered every call, or the line runs out. A model
 * that could never win used to be paid for on every call; in the one real measurement on
 * production, four of ten answered nothing at all and were still sent all eleven. */

const DAY = 86400000;

/** What a month of this workload would cost on a model at list price, from its real traffic. */
async function monthlyOn(workloadId, modelId) {
  /* Replays and test calls are ours, not the customer's traffic: counting them projected the
     month from the measurements themselves, which on the invoice workloads was 1,200 replays
     against 267 real calls. */
  const t = await db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS pin, COALESCE(SUM(completion_tokens), 0) AS pout,
            COUNT(*) AS n, MIN(created_at) AS first
       FROM calls WHERE workload_id = ? AND created_at >= ? AND source NOT IN ('replay', 'test')`)
    .get(workloadId, now() - 30 * DAY);
  if (!t.n) return null;
  const per = await priceCall(modelId, t.pin, t.pout);
  if (per === null) return null;
  const days = Math.max(1, (now() - t.first) / DAY);
  return round8((per / days) * 30);
}

const pct = (xs, p) => {
  const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// a candidate's own name in a run: the model, or the customer's model thinking less
const keyOf = (cand) => cand.key || cand.model;
// an answer as a judge of "at least as good" reads it: written text as it is, a structured one as its JSON
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const short = (m) => String(m || '').split('/').pop();

/* The fewest of n calls past the slow end that chance would give less than one time in twenty,
   when one call in ten runs past it anyway. Never fewer than two: one slow call is never enough. */
export function slowEndCount(n, share = 0.1, alpha = 0.05) {
  let choose = 1;
  let tail = 1;
  for (let k = 0; k <= n; k += 1) {
    if (k >= 2 && tail < alpha) return k;
    tail -= choose * share ** k * (1 - share) ** (n - k);
    choose = (choose * (n - k)) / (k + 1);
  }
  return n + 1;
}

/* The calls a measurement can draw on: this workload's own traffic over thirty days, spread across
   those days. It used to be the newest six hundred, which on a busy workload is its last few hours.
   Each day's calls are taken in turn, every day's first before any day's second, up to EVAL_POOL_MAX:
   a quiet month is taken whole, and a busy one still spans its days, but a day with more calls than the
   others is never held to their number, so every call counts towards a test (see eligible in plan.js).
   Calls that failed when they were made are left out: replaying them measures nothing. Each comes
   with the key of the strategy that served it, if one did (see `recorded` in runEvaluation). */
export async function poolOf(workloadId, { seed = String(now()), max = config.EVAL_POOL_MAX } = {}) {
  return db.prepare(
    `SELECT c.id, c.request_json, c.response_json, c.served_model, c.source, c.cost_usd, c.created_at, c.arm_id,
            a.key AS arm_key
       FROM calls c LEFT JOIN arms a ON a.id = c.arm_id
      WHERE c.id IN (SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY (created_at / 86400000) ORDER BY md5(id || ?)) AS rn, md5(id || ?) AS h
            FROM calls WHERE workload_id = ? AND request_json IS NOT NULL AND created_at >= ?
             AND source NOT IN ('replay', 'test') AND (status_code IS NULL OR status_code < 400)) x
        ORDER BY rn, h LIMIT ?)`).all(seed, seed, workloadId, now() - 30 * DAY, max);
}

/* Run tasks with at most `n` going at once. When one throws, the others finish what they are
   doing and start nothing more, and the error is thrown once they have: thrown at once, it left
   the other lanes sending paid calls that nothing would ever settle. */
async function inParallel(items, n, fn) {
  let next = 0;
  let failure = null;
  const lane = async () => {
    while (!failure && next < items.length) {
      const i = next;
      next += 1;
      try { await fn(items[i], i); } catch (err) { failure = failure || err; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
  if (failure) throw failure;
}

/* The calls whose bar is already paid for and still young enough to use, so the sample can prefer
   them: both of the customer's own model's answers are kept, or its own recorded answer is one of
   the two (`recorded` says whether a call has one) and the other is kept. A measurement that was
   stopped or cut short leaves exactly these behind, and the one after it uses them again rather than
   buying another bar. */
async function paidForCalls(model, calls, recorded) {
  if (!calls.length) return new Set();
  const byId = new Map(calls.map((c) => [c.id, c]));
  const rows = await db.prepare(
    `SELECT call_id, COUNT(DISTINCT slot) AS slots, bool_or(slot = 1) AS second FROM replay_cache
      WHERE model_id = ? AND status = 200 AND created_at >= ? AND recipe_json IS NULL AND call_id = ANY(?)
      GROUP BY call_id`)
    .all(model, now() - config.REPLAY_REUSE_DAYS * DAY, [...byId.keys()]);
  return new Set(rows.filter((r) => Number(r.slots) >= 2 || (r.second && recorded(byId.get(r.call_id))))
    .map((r) => r.call_id));
}

/* What an answer said, to keep beside it, whatever shape it came in. */
function answerText(json) {
  const m = json?.choices?.[0]?.message;
  if (!m) return null;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    return JSON.stringify(m.tool_calls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments }))).slice(0, 4000);
  }
  return typeof m.content === 'string' ? m.content.slice(0, 4000) : null;
}

/* `scored` is whether the answer counted towards the model's figure: false for a judgement that did not come back, or a
   refusal from a provider that was only busy, which are kept with a score all the same. `look` is 2 for an answer to a
   model's second look, on new requests (lookAgain), and null for its first (see 032-answers-as-read.sql). */
/* What the judge said of one answer held to "at least as good", as its page shows it request by request: what each of its
   two readings chose ('first', 'second' or 'equal', the answer judged first in the first) and how sure each was, whether
   they split, whether it was the better, a requirement of the instruction it broke, and a figure it changed. JSON for
   eval_replays.readings (033-open-ended-judging.sql); null where there was no reading. */
function readingsOf(j) {
  const d = j?.detail;
  if (!d && j?.judgedBy !== 'numbers') return null;
  const out = {};
  if (Array.isArray(d?.picks)) out.picks = d.picks;
  // what each reading leaned to before a lean under EVAL_QUALITY_SURE was read as a tie
  if (Array.isArray(d?.seen)) out.seen = d.seen;
  if (Array.isArray(d?.chances)) out.chances = d.chances.map((x) => (x === null || x === undefined ? null : Math.round(Number(x) * 100) / 100));
  if (d?.split) out.split = true;
  if (d?.candBetter) out.better = true;
  if (d?.broke) out.broke = String(d.broke).slice(0, 160);
  if (j?.judgedBy === 'numbers') out.figures = true;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

async function keepReplay(runId, callId, model, slot, r, { score = null, judged = null, failure = null, scored = null, look = null, readings = null } = {}) {
  await db.prepare(
    `INSERT INTO eval_replays (id, run_id, call_id, model_id, slot, cache_key, reused, status, error, failure, answer,
            latency_ms, ttft_ms, completion_tokens, reasoning_tokens, cost_usd, score, judged_by, difference, scored, look, readings,
            created_at)
     VALUES (@id, @run_id, @call_id, @model_id, @slot, @cache_key, @reused, @status, @error, @failure, @answer,
            @latency_ms, @ttft_ms, @completion_tokens, @reasoning_tokens, @cost_usd, @score, @judged_by, @difference,
            @scored, @look, @readings, @created_at)`).run({
    id: id('rpl'), run_id: runId, call_id: callId, model_id: model, slot, cache_key: r.key ?? null,
    reused: r.reused ? 1 : 0, status: r.status ?? null, error: r.error ?? null, failure,
    answer: answerText(r.json), latency_ms: r.latencyMs ?? null, ttft_ms: r.ttftMs ?? null,
    completion_tokens: r.completionTokens ?? null, reasoning_tokens: r.reasoningTokens ?? null,
    cost_usd: round8(r.cost || 0), score, judged_by: judged?.judgedBy ?? null,
    difference: score > 0 ? (judged?.detail?.kind ?? failure ?? null) : null,
    scored: scored === null ? null : (scored ? 1 : 0), look, readings, created_at: now(),
  });
}

/* The same refusal, said by most of the calls that were refused, in the provider's words. */
const commonest = (texts) => {
  const by = new Map();
  for (const t of texts.filter(Boolean)) by.set(t, (by.get(t) || 0) + 1);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

/* What it means when the customer's own model's answers cannot be used, in words. */
const UNUSABLE = {
  'no tool call': 'it answered in words instead of calling one of the tools',
  'unparseable arguments': 'its tool calls carried arguments that were not valid JSON',
  'unparseable json': 'it did not return valid JSON',
  empty: 'it returned an empty answer',
  truncated: 'its answers were cut off at the length limit',
  'no choice': 'it returned no answer at all',
};

const KIND_WORDS = {
  wording: 'wording only', omission: 'leaves things out', fact: 'changes facts', decision: 'reaches different decisions',
  refusal: 'refuses', 'cut off': 'stops mid-answer', worse: 'gives worse answers', unrelated: 'answers something else', truncated: 'runs out of room',
  instruction: 'ignores your instruction',
  empty: 'answers nothing', 'unparseable json': 'returns broken JSON', 'no tool call': 'calls no tool',
  'unparseable arguments': 'returns broken tool arguments', refused: 'is refused by its provider',
};

/* Whether a measurement should not start, because a person stopped it or another one of the same
 * workload is running. Answers what the job should do instead, or null to go ahead.
 *
 * A job can reach the queue again after its run has begun: a restart puts every claimed job back,
 * and a run whose process went away still says it is running. Started anyway, one workload was
 * measured twice side by side, and a measurement somebody had stopped started again. So, before
 * anything is planned or spent:
 *   - a run of this very job that a person stopped ends the job here: they said stop;
 *   - one of this job still running with a heartbeat (another process has it) is left to finish,
 *     and so is one that already finished; one that was interrupted is what this job is here to
 *     try again;
 *   - every run of the workload that nothing is running any more is closed, as stopped when
 *     somebody asked for that and as interrupted otherwise, and one that is still alive under
 *     another job means this one waits for it, or, when nobody asked for this one, is not needed. */
async function alreadyMeasuring(workload, { jobId, trigger }) {
  const wait = config.EVAL_STALE_MIN * 60000;
  if (jobId) {
    for (const r of await db.prepare(`SELECT * FROM eval_runs WHERE job_id = ? AND status = 'running'`).all(jobId)) {
      if (isAbandoned(r)) await closeRun(r, r.stop_requested_at ? 'stopped' : 'interrupted', { release: false });
    }
    const mine = await db.prepare('SELECT status, stop_requested_at FROM eval_runs WHERE job_id = ?').all(jobId);
    if (mine.some((r) => r.status === 'stopped' || r.stop_requested_at)) {
      await db.prepare(`UPDATE jobs SET status = 'cancelled', error = 'stopped by you' WHERE id = ? AND status = 'claimed'`).run(jobId);
      await deferAfterStop(workload.id);
      return { ok: false, reason: 'stopped by you' };
    }
    if (mine.some((r) => r.status === 'running')) return { snoozeMs: wait, note: 'its measurement is still running' };
    if (mine.some((r) => r.status === 'done')) return { ok: true, already: true };
  }
  await closeAbandoned(workload.id);
  const live = await db.prepare(`SELECT id FROM eval_runs WHERE workload_id = ? AND status = 'running' LIMIT 1`).get(workload.id);
  return live ? measuringAlready(trigger) : null;
}

/* Another run of the workload is alive: one somebody asked for waits its turn, and one nobody asked
   for is not needed, since the one running finds what it would. */
const measuringAlready = (trigger) => (trigger === 'automatic' || trigger === 'first'
  ? { ok: false, reason: 'another measurement of this workload is running' }
  : { snoozeMs: config.EVAL_STALE_MIN * 60000, note: 'another measurement of this workload is running' });

/* Why the last test nobody asked for did not run, kept on the workload for its page ("Next: paused at your testing limit"),
   and said on the workspace's activity the first time in a day that one stops for the testing limit, the balance, or the
   most one test may spend. One that waits for requests, or would not pay for itself yet, is only kept for the page. */
const SKIP_SHORT = {
  limit: 'paused at your testing limit',
  balance: 'paused until credit is added',
  ceiling: 'over what one test may spend',
};
async function noteSkip(workload, plan) {
  const reason = plan.limitReached ? 'limit' : plan.lowBalance ? 'balance' : plan.needCalls > plan.pool ? 'calls'
    : plan.notWorth ? 'worth' : /one test of this workload may spend/.test(plan.reason || '') ? 'ceiling' : 'other';
  let prev = null;
  try { prev = JSON.parse(workload.test_skip_json || 'null'); } catch { prev = null; }
  const short = SKIP_SHORT[reason] ?? null;
  await db.prepare('UPDATE workloads SET test_skip_json = ? WHERE id = ?')
    .run(JSON.stringify({ reason, short, text: plan.reason ?? null, at: now() }), workload.id);
  if (!short || (prev?.reason === reason && now() - Number(prev.at || 0) < 86400000)) return;
  await addActivity(workload.workspace_id, {
    kind: 'floor', title: `A test of ${workload.slug} did not run by itself`, detail: plan.reason, workloadId: workload.id,
  });
}

/* A measurement, and the money it set aside given back however it ends: finished, stopped, cut short, turned away or
   thrown. One whose process dies has it given back by the closer of runs nothing is running (closeRun), or when the hold
   lapses on its own. */
export async function runEvaluation(workloadId, opts = {}) {
  const box = { holdId: null };
  try {
    return await measure(workloadId, opts, box);
  } finally {
    if (box.holdId) await releaseHold(box.holdId).catch(() => {});
  }
}

async function measure(workloadId, { trigger = 'manual', jobId = null } = {}, box = { holdId: null }) {
  const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!workload) return { ok: false, reason: 'gone' };
  if (!canRoute()) return { snoozeMs: 15 * 60000, note: 'no OPENROUTER_API_KEY' };

  const reference = workload.reference_model;
  if (!reference) return { ok: false, reason: 'no reference model' };

  const already = await alreadyMeasuring(workload, { jobId, trigger });
  if (already) return already;

  /* The same plan the page showed, with whatever the page had to go without asked for now: the
     page never waits on Jev, a measurement does. */
  // nobody asked for it: the schedule, a change in the catalogue, or a new workload's first calls
  const automatic = trigger === 'automatic' || trigger === 'first';
  /* One nobody asked for that was queued while another measurement of this workload was still going is answered
     by that one once it ends. Started after it instead, it measured the workload again straight away and paid
     twice to learn the same thing. A stop answers it too: a person said stop. Only another job's ending counts,
     since a run of this job that a restart interrupted is what the job is here to try again. */
  if (automatic && jobId) {
    const queuedAt = Number((await db.prepare('SELECT created_at FROM jobs WHERE id = ?').get(jobId))?.created_at) || 0;
    const answered = queuedAt > 0 && await db.prepare(
      `SELECT 1 FROM eval_runs WHERE workload_id = ? AND status IN ('done', 'stopped') AND finished_at >= ?
          AND job_id IS DISTINCT FROM ? LIMIT 1`).get(workloadId, queuedAt, jobId);
    if (answered) return { ok: false, reason: 'measured since this was queued' };
  }
  /* A workspace that measures only when asked measures nothing by itself: not on its schedule, not
     for a new model in the catalogue, and not a new workload's first measurement either. Settings
     promises that nothing is replayed and nothing is spent until somebody presses Measure now. */
  if (automatic && !(await cadenceOf(workload.workspace_id))) {
    if (workload.status === 'measuring') await rest(workloadId);
    return { ok: false, reason: 'This workspace measures only when somebody asks.' };
  }
  const plan = await planFor(workload, { canRoute: canRoute(), forRun: true, automatic });
  if (!plan.canRun) {
    /* Looked at again when it is due rather than on every hourly pass, which would work the plan out
       over and over to reach the same answer. */
    if (automatic) {
      /* Turned down for want of calls: started by the call that brings them (waitForCalls), never at a guess of
         when that will be. For anything else, looked at again in its time. */
      // and only for a count it has not reached, so what could start it again never turns it down again
      if (plan.needCalls > plan.pool) await waitForCalls(workloadId, plan.needCalls);
      else await deferAutomatic(workloadId, { waitMs: plan.notWorth ? null : 6 * 3600000 });
      await noteSkip(workload, plan);
    }
    /* Back to what its last measurement found, not to "new": a workload that has been measured
       before still has that result, and forgetting it here would put "Not optimized yet" over a
       page that shows a candidate. */
    if (workload.status === 'measuring') await rest(workloadId);
    return { ok: false, reason: plan.reason };
  }

  const pool = await poolOf(workloadId);
  const shape = workload.shape_kind;
  // how many models the race finishes; raised below to take in every setup of a router by kind serving now
  let want = plan.models;
  const ownArm = ownArmKey(workload);
  /* A call's recorded answer, when the customer's own model gave it and it can be read, used as if it
     had been replayed: nothing is paid for it, and its own timing is never used for speed.

     Only a call no strategy served, or one the customer's own model served as it is (the control a
     switch is held against, or the yardstick), carries the customer's own answer. A switched call
     records the lead model as the one that served it, and for the customer's own model thinking less,
     or pinned to one provider, that is the reference itself: read as the customer's answer, a lighter
     answer was held against a full one, which loosened the bar for every candidate, and the strategy
     serving was scored partly against its own answers. */
  const recorded = (c) => {
    if (!config.EVAL_USE_RECORDED || !c?.response_json || !c.served_model || String(c.served_model) !== String(reference)) return null;
    if (c.arm_id && c.arm_key !== ownArm) return null;
    let json = null;
    try { json = JSON.parse(c.response_json); } catch { return null; }
    if (!json?.choices?.[0]?.message) return null;
    const usage = json.usage || {};
    const was = Number(usage.cost ?? c.cost_usd ?? 0) || 0;
    return {
      ok: true, status: 200, json, error: null, latencyMs: null, ttftMs: null, cost: 0, originalCost: was,
      reused: true, recorded: true, savedUsd: was, key: null, transient: false, account: false,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      provider: json.provider ?? null, promptTokens: usage.prompt_tokens ?? null,
    };
  };
  /* What earlier measurements of this workload drew on. A re-check measures calls no finished
     measurement used, so a lucky sample is not simply measured again: the same twelve calls, the same
     cached answers and the same verdict, at no cost, was what a re-measure used to be. Only finished
     ones count here: a measurement that was stopped or cut short found nothing, and counting its calls
     sent the one that tried again away from the very answers it had just bought, to pay for another
     bar. Every call any measurement looked at, finished or not, is kept from a second look, which has
     to be on calls the model has never seen. */
  const drawnBefore = await db.prepare(
    `SELECT s.call_id, bool_or(${FOUND('r.')}) AS used FROM eval_samples s JOIN eval_runs r ON r.id = s.run_id
      WHERE r.workload_id = ? GROUP BY s.call_id`).all(workloadId);
  const usedBefore = new Set(drawnBefore.filter((r) => r.used).map((r) => r.call_id));
  const seenBefore = new Set(drawnBefore.map((r) => r.call_id));
  const freshSet = new Set(pool.filter((c) => !usedBefore.has(c.id)).map((c) => c.id));
  const recheckRun = usedBefore.size > 0;
  /* Calls whose bar is already paid for come first within each length band, a re-check's included:
     among calls no finished measurement used, those are the ones a measurement cut short bought. */
  const samples = sampleCalls(pool, plan.sample, now() % 100003, await paidForCalls(reference, pool, recorded),
    { fresh: recheckRun ? freshSet : null });
  const queue = plan.order;
  // the catalogue as the run found it: which models anyone can run, and who sells them
  const factsNow = await loadFacts();
  const speed = plan.speed || { factor: null };

  const gate = await gateEval(workload.workspace_id, { estimatedUsd: plan.estimateUsd });
  if (!gate.ok) {
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} is waiting`, detail: gate.message, workloadId,
    });
    /* Somebody who pressed Measure now is waiting on this, so it looks again in half an hour; one nobody
       asked for waits six hours, since a balance that is empty now is rarely full half an hour later. */
    return { snoozeMs: (automatic ? 6 * 60 : 30) * 60000, note: gate.code };
  }
  /* The most it may spend, set aside on the balance before anything is sent, less what the plan's allowance covers: no
     other test can count the same money, and this one can never take the balance below zero. It is given back as the
     test is charged, and whatever is left once it ends. A customer's own requests may still use it (see available in
     src/billing.js); the test notices, and stops. */
  const toHold = round8(Math.max(0, (Number(plan.atMostUsd) || 0) - (Number(gate.allowance) || 0)));
  if (toHold > 0) {
    const held = await hold(workload.workspace_id, toHold, 'test');
    if (!held.ok) {
      await addActivity(workload.workspace_id, {
        kind: 'floor', title: `Testing ${workload.slug} is waiting`,
        detail: `It may spend up to $${toHold.toFixed(2)}, and only $${Math.max(0, Number(held.free) || 0).toFixed(2)} of your balance `
          + 'is free right now. Add credit in Settings and it starts again on its own.',
        workloadId,
      });
      return { snoozeMs: (automatic ? 6 * 60 : 30) * 60000, note: 'no_balance' };
    }
    box.holdId = held.holdId;
  }

  const planRecord = {
    funnel: plan.funnel,
    ruledOut: Object.values(plan.excluded.reduce((a, e) => {
      a[e.step] = a[e.step] || { step: e.step, count: 0, examples: [] };
      a[e.step].count += 1;
      if (a[e.step].examples.length < 6) a[e.step].examples.push({ model: e.model, reason: e.reason });
      return a;
    }, {})),
    order: queue.map((r) => ({
      model: r.model, key: r.key ?? null, label: r.label ?? null, price: r.price, savingShare: r.savingShare, chance: r.chance,
      expected: r.expected, parts: r.parts, family: r.family, recipe: r.recipe, note: r.note,
    })),
    want, judge: plan.judge, difficulty: plan.difficulty, speed,
  };

  /* Every model call the run expects to make: the bar's two replays of each sampled call, one
     replay per call for each model measured to the end, and for written answers the judgements,
     one for each of the bar's pairs and one for each model's answer. */
  const perCall = shape === 'free_text' ? 2 : 1;
  const finalists = Math.min(want, queue.length);
  /* A recorded answer is read, not sent, so it is not a step: the count on the page is of calls that
     went out and were paid for. */
  const recordedAhead = samples.filter((c) => recorded(c)).length;
  const nominal = samples.length * 2 - recordedAhead + (shape === 'free_text' ? samples.length : 0) + finalists * samples.length * perCall;
  const runStartedAt = now();
  const run = {
    id: id('run'), workspace_id: workload.workspace_id, workload_id: workloadId,
    status: 'running', shape_kind: shape, reference_model: reference,
    sample_size: samples.length, created_at: now(), started_at: now(),
    steps_total: nominal, steps_done: 0, phase: `Checking how much ${reference}'s answers vary`,
    trigger: automatic ? 'automatic' : 'manual',
    models_planned: Math.min(want, queue.length), heartbeat_at: now(),
    plan_json: JSON.stringify(planRecord), judge: plan.judge, job_id: jobId,
    // the quote as it was shown, our fee included: about what it would cost, and the most it may spend
    quote_about_usd: plan.aboutUsd ?? null, cap_usd: plan.atMostUsd ?? null, hold_id: box.holdId,
  };
  /* That nothing else is measuring this workload, and this run's own row, in one step under a lock
     on the workload: two jobs of it that reach this point together both passed the check made before
     planning, and without the lock both started. */
  const began = await db.tx(async (tx) => {
    await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`eval_run:${workloadId}`);
    if (await tx.prepare(`SELECT 1 FROM eval_runs WHERE workload_id = ? AND status = 'running' LIMIT 1`).get(workloadId)) return false;
    await tx.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, steps_total, steps_done, phase, trigger, models_planned,
              heartbeat_at, plan_json, judge, job_id, quote_about_usd, cap_usd, hold_id)
              VALUES (@id, @workspace_id, @workload_id, @status, @shape_kind, @reference_model,
              @sample_size, @created_at, @started_at, @steps_total, @steps_done, @phase, @trigger,
              @models_planned, @heartbeat_at, @plan_json, @judge, @job_id, @quote_about_usd, @cap_usd, @hold_id)`).run(run);
    return true;
  });
  if (!began) return measuringAlready(trigger);
  /* Whatever started it, a workload being measured says so from the moment the run exists, and waits for no
     more calls: this measurement is what it was waiting for. */
  await db.prepare(`UPDATE workloads SET status = 'measuring', measure_at_calls = NULL, test_skip_json = NULL, updated_at = ?
      WHERE id = ?`).run(now(), workloadId);
  if (trigger === 'first') {
    await addActivity(workload.workspace_id, {
      kind: 'run', title: `Measuring ${workload.slug}`,
      detail: `${plan.pool} calls in, which is enough for a measurement to show whether a cheaper model is as good as yours.`,
      workloadId,
    });
  }

  /* Written as the run goes: the heartbeat that says something is still running this, and the
     place a stop is noticed. It answers true when the run should end here. */
  let done = 0;
  let total = nominal;
  /* Once the race is on, how many calls are left is worked out afresh at every step: what each
     running model still has to answer, and the places still to fill from the models waiting in
     line. A model dropped early leaves its unanswered calls uncounted, and when the line runs out
     the total comes down to what will actually be made, so the count reaches its end exactly when
     the last call does. */
  let remaining = null;
  // the second looks still to come, allowed for in what is left once the race starts (see there)
  let looksAhead = 0;
  const ended = (row) => !row || row.status !== 'running' || !!row.stop_requested_at;
  /* Every model call is counted the moment it comes back, so what the page says ran is exactly
     what was sent and paid for, however many models are running at once. */
  const step = async (by, phase) => {
    done += by;
    total = remaining ? done + remaining() : Math.max(total, done);
    // lanes write this side by side, so an older count landing late must not move it backwards
    const r = await db.prepare(`UPDATE eval_runs SET steps_done = GREATEST(steps_done, ?),
                  steps_total = GREATEST(?, steps_done, ?), phase = ?, heartbeat_at = ?
                  WHERE id = ? RETURNING status, stop_requested_at`).run(done, Math.max(total, done), done, phase, now(), run.id);
    return ended(r.rows[0]);
  };
  /* Asked before every paid call goes out, replays and judgements alike, in every lane: the
     heartbeat, and whether to send the call at all. Nothing more is sent once somebody presses
     Stop, and a run waiting on one slow call is never mistaken for an abandoned one. */
  const halted = async () => {
    const r = await db.prepare(`UPDATE eval_runs SET heartbeat_at = ? WHERE id = ?
                  RETURNING status, stop_requested_at`).run(now(), run.id);
    await readRoom();
    return ended(r.rows[0]);
  };
  /* The balance itself, read at most every TEST_BALANCE_CHECK_MS on the way to a call: a customer's own requests may use
     the money this test set aside (they come first), so once the balance no longer covers what the test has run and not
     been charged for yet, it stops, rather than take the balance below zero. */
  let lowBalance = false;
  let roomReadAt = 0;
  async function readRoom() {
    if (lowBalance || Date.now() - roomReadAt < config.TEST_BALANCE_CHECK_MS) return;
    roomReadAt = Date.now();
    const bal = Number((await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?').get(workload.workspace_id))?.balance_usd ?? 0);
    const owed = withFee(spend + outUsd) - await allowanceLeft(workload.workspace_id);
    if (owed > 0 && bal - owed < 0) lowBalance = true;
  }
  /* The run's ending is written only while it is still running and nobody has asked it to stop.
     A stop can arrive while the last charge is being settled; unguarded, the run then wrote
     "done" and switched the model while the page said nothing had been switched. Answers false
     when the stop won, and the run ends stopped. */
  const finish = async (outcome, error) => {
    const ended = (await db.prepare(
      `UPDATE eval_runs SET status = 'done', outcome = ?, finished_at = ?, error = ?, phase = NULL,
              steps_done = GREATEST(steps_done, ?), steps_total = GREATEST(steps_done, ?)
        WHERE id = ? AND status = 'running' AND stop_requested_at IS NULL RETURNING id`)
      .run(outcome, now(), error, done, done, run.id)).rows.length > 0;
    // the control group reads the bar a finished measurement set from now on, rather than what it read before
    if (ended) forgetBar(workloadId);
    return ended;
  };

  let spend = 0;
  // everything this run has spent, settled or not: what the spending limits are held to
  let spentTotal = 0;
  /* What the calls still out are likely to cost, held against the limit beside what has been spent: a model
     asks a few of its calls at once (see tryModel), so the limit is checked against both before one goes. */
  let outUsd = 0;
  const perCallUsd = () => (Number(plan.estimateUsd) > 0 ? Number(plan.estimateUsd) / Math.max(1, nominal) : 0);
  /* The most this test may spend, before our fee: its quote's "at most", which the page showed, from the first call to the
     last. It used to be set only once the race began, as the larger of the quote and what one measurement may spend, so
     the bar was never held to anything, and a test quoted at thirty cents could spend two dollars. */
  const capLimit = Number(plan.capRaw) > 0 ? Number(plan.capRaw)
    : Math.max(Number(plan.ceilingUsd) || config.EVAL_MAX_USD_PER_RUN, Number(plan.estimateUsd) || 0);
  // what stops the next call: the test's own limit reached ('budget'), or a balance that no longer covers it ('balance')
  const outOfRoom = (ahead = 0) => (lowBalance ? 'balance' : spentTotal + outUsd + ahead >= capLimit ? 'budget' : null);
  let reusedCount = 0;
  let savedUsd = 0;
  // Jev's reading of the models to try, taken for this measurement, is paid for with it
  if (plan.fitCost > 0) { spend += plan.fitCost; spentTotal += plan.fitCost; }

  /* Charge what has run so far, and say whether there is anything left. What is charged comes off the money the test set
     aside, in the same step. */
  const settle = async (note) => {
    if (spend <= 0) return true;
    const amount = spend;
    spend = 0;
    await chargeEval(workload.workspace_id, amount, note, { holdId: box.holdId });
    await db.prepare('UPDATE eval_runs SET spend_usd = spend_usd + ? WHERE id = ?').run(round8(amount), run.id);
    const left = (await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?')
      .get(workload.workspace_id))?.balance_usd ?? 0;
    return left > 0;
  };
  /* Which judge actually settled the written answers, whatever the plan expected: Jev can run
     out of credit part way, and a structured workload needs no judge at all. */
  const judgedWith = new Set();
  // judgements that did not come back: left out of every number, and counted, so a run leaning on few can say so
  let judgeMisses = 0;
  // whether the judge failed a known pair this run, and how many of the bar's answers were the customer's own
  let judgeUnsure = false;
  let recordedRefs = 0;
  let judgeCheckRecord = null;
  // agreement: the same answer as the customer's own model; quality: at least as good an answer
  let yardstick = 'agreement';
  /* Under "at least as good": which judge reads it on this workload (null, Jev with the language model behind it;
     'llm', the language model alone, where the planted answers found Jev unreliable here: see chooseJudge), and what
     the workload's own instruction asks of every answer (src/eval/checklist.js). */
  let judgePrefer = null;
  let checklist = [];
  const qualityOf = (body, answer, reference) => judgeQuality(askOf(body), asText(answer), asText(reference),
    { scope: workload.workspace_id, prefer: judgePrefer, checklist });
  /* Under "at least as good", an answer that changes a figure the customer's model states the same both times is worse
     whatever a reading says: a judge can see that two answers give different figures, not which one is right. Written
     answers only; a structured one's fields are compared as fields. */
  const figuresHeld = (a, b) => yardstick === 'quality' && typeof a === 'string' && typeof b === 'string'
    && numbersOf(a).length > 0 && !numbersDiffer(a, b);
  const qualityAgainst = (body, answer, refA, refB) => (figuresHeld(refA, refB) && typeof answer === 'string' && numbersDiffer(answer, refA)
    ? { score: 1, judgedBy: 'numbers', detail: { kind: 'fact', numbers: [numbersOf(answer), numbersOf(refA)] }, cost: 0 }
    : qualityOf(body, answer, refA));
  /* The bar, from how often the customer's model differed from itself, or was clearly worse than itself: a multiple
     of that for "the same answer", and that plus a margin for "at least as good" (see marginFloor). */
  const barFrom = (noisePct) => (yardstick === 'quality'
    ? marginFloor(noisePct, { marginPct: config.EVAL_QUALITY_MARGIN_PCT, minPct: config.EVAL_FLOOR_MIN_PCT })
    : floorFrom(noisePct, { multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT }));
  const judgeLabel = () => {
    const all = [...judgedWith];
    if (all.some((j) => j.startsWith('jev'))) return 'jev';
    if (all.some((j) => j.startsWith('llm'))) return 'llm';
    return null;
  };
  const keepSavings = async () => {
    await db.prepare(`UPDATE eval_runs SET reused = ?, saved_usd = ?, judge = ?, quote_usd = ?, recorded_refs = ?,
                        judge_check_json = ?, yardstick = ? WHERE id = ?`)
      .run(reusedCount, round8(savedUsd), judgeLabel(), plan.estimateUsd ?? null, recordedRefs,
        judgeCheckRecord ? JSON.stringify(judgeCheckRecord) : null, yardstick, run.id);
  };

  /* Stopped part way. Everything that ran is charged, every model that answered all of its calls
     keeps its result, and nothing is switched. And the next measurement nobody asks for waits a whole
     rhythm (see deferAfterStop): somebody said stop. */
  const endStopped = async () => {
    await settle(`Measuring ${workload.slug}, stopped`);
    await keepSavings();
    /* Its count says what it had still to do when it stopped ("stopped at 120 of 300"), which never includes the
       second looks it was only allowing for (see looksAhead): stopped on its very last call, it made them all. */
    looksAhead = 0;
    const planned = Math.max(done, remaining ? done + remaining() : total);
    const closed = await db.prepare(`UPDATE eval_runs SET status = 'stopped', outcome = 'stopped',
                  finished_at = ?, phase = NULL, steps_done = ?, steps_total = ? WHERE id = ? AND status = 'running' RETURNING id`)
      .run(now(), done, planned, run.id);
    await db.prepare('UPDATE eval_runs SET phase = NULL WHERE id = ?').run(run.id);
    await deferAfterStop(workloadId);
    if (!closed.rows.length) return { ok: true, runId: run.id, stopped: true };
    await rest(workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `Measuring ${workload.slug} stopped`,
      detail: `Stopped at ${done} of ${Math.max(total, done)} model calls, as you asked. You were charged only for `
        + 'the calls it made, and nothing was switched.',
      workloadId,
    });
    return { ok: true, runId: run.id, stopped: true };
  };

  /* Stopped before any model was compared: at its limit ('budget', the most it may spend, as the page quoted), or because
     the balance no longer covers what it runs ('balance'). What ran is charged, nothing is switched, and it says so; the
     next test nobody asks for comes in its rhythm, as after any test. */
  const endCapped = async (why, during) => {
    await settle(`Measuring ${workload.slug}, stopped ${why === 'balance' ? 'for the balance' : 'at its limit'}`);
    await keepSavings();
    const limitWords = `its limit of $${(Number(plan.atMostUsd) || capLimit).toFixed(2)}`;
    const ok = await finish(why === 'balance' ? 'no_balance' : 'capped',
      why === 'balance' ? 'balance ran out while the bar was set' : `reached ${limitWords} while ${during}`);
    if (!ok) return await endStopped();
    await rest(workloadId);
    await scheduleNext(workloadId, { changed: false });
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: why === 'balance' ? `Testing ${workload.slug} stopped for your balance` : `Testing ${workload.slug} stopped at its limit`,
      detail: why === 'balance'
        ? `Your own requests used the money it had set aside, so it stopped while ${during}, rather than take your balance below zero. `
          + 'Nothing was switched. Add credit in Settings and the next test runs as usual.'
        : `It reached ${limitWords} while ${during}, before any cheaper model was compared. You were charged only for what it ran, `
          + 'and nothing was switched.',
      workloadId,
    });
    return { ok: true, runId: run.id, capped: why };
  };

  /* A stop that arrived while this was being picked up ends it before a single call is sent. */
  if (jobId && (await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId))?.status === 'cancelled') {
    return await endStopped();
  }

  const note = (r) => {
    if (r.reused) { reusedCount += 1; savedUsd += r.savedUsd || 0; }
    spend += r.cost || 0;
    spentTotal += r.cost || 0;
  };
  const addJudge = (cost) => { spend += cost || 0; spentTotal += cost || 0; };

  /* Ended by something that is nobody's verdict: the provider was busy on the customer's own
     model, our account with it needs attention, or something broke here. What ran is charged,
     nothing is switched, and the job is asked to try again later, because the same measurement
     will most likely go through once the problem has passed; the one that tries again uses what
     this one bought. Once the job has given up, the next measurement nobody asks for waits a while
     (see deferAfterFailure), rather than starting again at the next hourly pass. */
  const interrupt = async (why, { title, retryMs = 30 * 60000 } = {}) => {
    await settle(`Measuring ${workload.slug}, interrupted`);
    await keepSavings();
    const closed = await db.prepare(`UPDATE eval_runs SET status = 'failed', outcome = 'interrupted', error = ?,
                  finished_at = ?, phase = NULL WHERE id = ? AND status = 'running' RETURNING id`)
      .run(why, now(), run.id);
    if (!closed.rows.length) return await endStopped();
    await deferAfterFailure(workloadId);
    await rest(workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: title || `Measuring ${workload.slug} was interrupted`,
      detail: `${why} Nothing was switched, and it will try again by itself.`, workloadId,
    });
    // tried again a few times at most, so a problem that does not pass is not retried for ever
    const attempts = jobId ? Number((await db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(jobId))?.attempts ?? 0) : 0;
    return retryMs && jobId && attempts < 4 ? { snoozeMs: retryMs, note: why } : { ok: false, reason: why };
  };
  const accountProblem = (r) => `Our account with the model provider needs attention (it answered ${r.status}: `
    + `"${String(r.error || 'no reason given').slice(0, 160)}"), so no model could be asked anything.`;
  const paid = (r) => (r.reused ? Number(r.originalCost || 0) : Number(r.cost || 0));
  /* How a model that clears is served: the way it was asked, and, for a model whose weights anyone can
     run, only by the providers that answered it here. The same open model can be run differently by
     different providers (a smaller number format, an older build), and a switch should serve what was
     measured, not whatever provider has capacity that day. A model only its maker sells is left to
     route freely, and so is one whose answering providers cannot be named. */
  const openWeights = new Map();
  const servedRecipe = (cand, st) => {
    /* How it was asked, less whether other providers may stand in for the measured ones: that is a cascade's alone
       (see cascadeFor). A cascade serving now has its cheap model asked that way, and carried over, the model's own
       result took it along, and a switch to that model on its own was served by providers nobody measured. */
    const asked = { ...(cand.recipe || {}) };
    delete asked.preferred;
    const base = Object.keys(asked).length ? asked : null;
    if (base?.pinned || !st?.providers?.size) return base;
    const m = factsNow?.models?.get(cand.model);
    if (!m || !m.openWeights) return base;
    if (!openWeights.has(cand.model)) {
      const names = new Set(st.providers.keys());
      const tags = (m.endpoints || []).filter((e) => names.has(String(e.provider))).map((e) => e.tag);
      openWeights.set(cand.model, tags);
    }
    const tags = openWeights.get(cand.model);
    return tags.length ? { ...(base || {}), providers: tags } : base;
  };
  /* Every answer asked for now (a recorded one was not) came back unusable: refused, busy, or not
     the shape the call asks for. */
  const deadNow = (p) => {
    const asked = [[p.ra, p.a], [p.rb, p.b]].filter(([r]) => !r.recorded);
    return asked.length > 0 && asked.every(([r, x]) => !r.ok || !x.ok);
  };

  // the bar: the customer's own model against itself, reusing what is already paid for
  const bar = [];
  let stopped = false;
  // stopped at its limit ('budget') or for the balance ('balance') before any model was compared (see endCapped)
  let capped = null;
  let cantAnswer = false;
  let account = null;
  try {
  await inParallel(samples, 3, async (s, i) => {
    if (stopped || cantAnswer || account || capped) return;
    if (await halted()) { stopped = true; return; }
    // never past its limit, nor past what the balance covers, even while the bar is set
    const room = outOfRoom(2 * perCallUsd());
    if (room) { capped = room; return; }
    const body = JSON.parse(s.request_json);
    /* The answer the customer's own model actually gave this call, when it is kept, is one of the two
       the bar needs, so only one is paid for. It came from their real deployment, which is exactly the
       variation a switch has to be held against. */
    const had = recorded(s);
    const [ra, rb] = had ? [had, await replayOnce({ body, callId: s.id, model: reference, slot: 1, workload })]
      : await Promise.all([
        replayOnce({ body, callId: s.id, model: reference, slot: 0, workload }),
        replayOnce({ body, callId: s.id, model: reference, slot: 1, workload }),
      ]);
    if (had) recordedRefs += 1;
    note(ra);
    note(rb);
    if (ra.account || rb.account) { account = ra.account ? ra : rb; return; }
    await keepReplay(run.id, s.id, reference, 0, ra, { failure: ra.ok ? null : 'refused' });
    await keepReplay(run.id, s.id, reference, 1, rb, { failure: rb.ok ? null : 'refused' });
    await db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged)
                VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(id('smp'), run.id, s.id, s.quartile ?? 0,
           ra.json ? JSON.stringify(ra.json) : null, rb.json ? JSON.stringify(rb.json) : null);
    bar.push({
      i, s, body, ra, rb, a: extract(ra.json, shape), b: extract(rb.json, shape),
      /* A recorded answer that carries no price of its own is priced like the replay beside it, so the
         customer's model is never made to look cheaper than it is (which would make every candidate
         look dearer, and the saving smaller than it is). */
      refCost: had && !(paid(ra) > 0) ? paid(rb) : (paid(ra) + paid(rb)) / 2,
    });
    if (await step(had ? 1 : 2, `Checking how much ${reference}'s answers vary, ${bar.length} of ${samples.length} requests`)) stopped = true;
    /* When the customer's own model cannot answer the first few calls at all, the rest will not
       go differently, and every further call would be paid for to learn nothing. Only what was asked
       of it now counts: a recorded answer says it could answer then, not that it can today. */
    if (!stopped && bar.length >= 3 && bar.every((p) => deadNow(p))) cantAnswer = true;
  });
  } catch (err) {
    await interrupt(`Something went wrong here while setting the bar: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
    throw err;
  }
  if (stopped) return await endStopped();
  if (capped) return await endCapped(capped, `checking how much ${reference}'s answers vary`);
  if (account) {
    reportCallFailure({ kind: 'measurement replays', model: reference, status: account.status, message: account.error });
    return await interrupt(accountProblem(account));
  }
  bar.sort((x, y) => x.i - y.i);

  /* When the customer's own model is refused on most calls, there is nothing to measure against,
     and the reason is the provider's, not a disagreement. It used to be counted as the model
     disagreeing with itself every time, which told a customer their model was inconsistent when
     every call had been refused for one plain reason. */
  /* A call the customer's own model could not answer either time says nothing about anybody, so
     it is left out for every model. When that is most of them, there is nothing to measure
     against, and the reason is said plainly: the provider refused the calls, or the model did not
     return what the calls ask for. It used to be counted as the model disagreeing with itself on
     every call, which told somebody their model was inconsistent when it had never answered. */
  /* Calls with nothing usable at all, and calls whose every answer asked for now failed: with a
     recorded answer beside it, a replay that failed leaves one answer, which can set no bar. */
  const unusable = bar.filter((p) => (!p.a.ok && !p.b.ok) || deadNow(p));
  /* When every one of those calls failed only because the provider was busy or timing out, that
     is an outage, not the customer's model being unable to answer: it used to end the run as
     "your own model could not answer these calls", which the page then said for a month. */
  const outage = unusable.length > 0 && unusable.every((p) => [p.ra, p.rb].every((r) => r.ok || r.transient || r.recorded));
  if ((unusable.length * 2 > bar.length || cantAnswer) && outage) {
    return await interrupt(`The provider was too busy to answer ${reference} on ${unusable.length} of the first `
      + `${bar.length} calls, so the bar could not be set.`);
  }
  if (unusable.length * 2 > bar.length || cantAnswer) {
    const refusedHttp = unusable.filter((p) => [p.ra, p.rb].filter((r) => !r.recorded).every((r) => !r.ok));
    const byProvider = refusedHttp.length * 2 >= unusable.length;
    const count = cantAnswer ? `every one of the first ${bar.length}` : `${unusable.length} of ${bar.length}`;
    const why = byProvider
      ? `The provider refused ${count} calls and said: "${commonest(refusedHttp.map((p) => p.ra.error || p.rb.error)) || 'no reason given'}"`
      : `On ${count} calls ${UNUSABLE[commonest(unusable.map((p) => p.a.reason || p.b.reason))] || 'it did not return what the calls ask for'}.`;
    await settle(`Measuring ${workload.slug}, setting the bar`);
    await keepSavings();
    if (!await finish('refused', `${reference} could not answer ${count} calls`)) return await endStopped();
    await db.prepare('UPDATE eval_runs SET ref_error = ? WHERE id = ?').run(why, run.id);
    await db.prepare(`UPDATE workloads SET status = 'no_match', status_note = ?, floor_pct = NULL,
                updated_at = ? WHERE id = ?`).run('Your own model could not answer these calls', now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `We could not measure ${workload.slug}`,
      detail: `${reference} could not answer ${count} of your calls when we replayed them, so there is no bar `
        + `to hold a cheaper model to. ${why} Nothing has been switched.`,
      workloadId,
    });
    await scheduleNext(workloadId, { changed: !automatic });
    return { ok: true, runId: run.id, floor: null, results: 0, refused: true };
  }
  const kept = bar.filter((p) => p.a.ok || p.b.ok);

  if (await step(0, `Comparing ${reference}'s answers with each other`)) return await endStopped();
  const noiseScores = [];
  /* Of the customer's own pairs a judge read, how many differ in a figure, a fact or a decision: work whose facts matter,
     which stays on "the same answer" however open-ended its requests read (see openEndedOf). */
  let barRead = 0;
  let barFacts = 0;
  try {
  await inParallel(kept, 6, async (p) => {
    if (stopped || capped) return;
    // a judgement is a paid call too: never past the limit, nor past what the balance covers
    const room = outOfRoom(perCallUsd());
    if (room) { capped = room; return; }
    let score;
    /* One of the two answers missing because the provider was busy says nothing about whether the
       model agrees with itself, so the pair is left out of the noise. Counted as a disagreement,
       one busy moment in ten calls read as the model disagreeing with itself one time in ten,
       and loosened the bar every candidate is then held to. */
    if (p.ra.transient || p.rb.transient) return;
    if (!p.a.ok || !p.b.ok) score = 1;
    else if (shape === 'free_text') {
      if (await halted()) { stopped = true; return; }
      const j = await judgeBarPair(askOf(p.body), p.a.value, p.b.value, { scope: workload.workspace_id, bar: true });
      addJudge(j.cost);
      if (j.cost > 0 && await step(1, `Comparing ${reference}'s answers with each other`)) stopped = true;
      /* A judge that could not judge says nothing about whether the model agrees with itself. Counted
         as a disagreement, one failed judgement in ten raised a 3% bar to 11% and let a model that was
         wrong one time in ten clear it. */
      if (j.transient || !j.judgedBy) { judgeMisses += 1; return; }
      score = j.score;
      judgedWith.add(j.judgedBy);
      barRead += 1;
      // a difference in figures, or one the judge named a fact or a decision, which is never forgiven (see judgeBarPair)
      if (j.judgedBy === 'numbers' || (j.score === 1 && ['fact', 'decision'].includes(j.detail?.kind))) barFacts += 1;
    } else {
      const d = disagreement(p.a, p.b, shape);
      if (d === null) {
        const r = await proseScore(p.body, p.a, p.b, shape, workload.workspace_id, { subject: 'b' });
        addJudge(r.cost);
        if (r.transient) { judgeMisses += 1; return; }
        if (r.judgedBy) judgedWith.add(r.judgedBy);
        score = r.score;
      } else score = d;
    }
    p.noise = score;
    noiseScores.push(score);
  });
  } catch (err) {
    await interrupt(`Something went wrong here while comparing the answers: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
    throw err;
  }
  if (stopped) return await endStopped();
  if (capped) return await endCapped(capped, `comparing ${reference}'s answers with each other`);
  /* A bar set from a handful of pairs is no bar. When the provider was too busy to give most calls
     their second answer, that is an outage, and the run tries again later rather than measuring
     every model against a bar nobody set. */
  const busyPairs = kept.filter((p) => p.ra.transient || p.rb.transient).length;
  if (busyPairs > 0 && noiseScores.length < Math.min(10, kept.length) && noiseScores.length * 2 < kept.length) {
    return await interrupt(`The provider was too busy to answer ${reference} on ${busyPairs} of the first `
      + `${bar.length} calls, so the bar could not be set.`);
  }
  /* The judge is tested on every run that leans on it, with pairs whose answer is known: an answer
     against itself with only its spacing changed must read the same, and one call's answer held
     against another call's request must read different. A judge that gets those wrong cannot be
     trusted with a bar in single percent, so nothing it settled is switched to on its own. */
  let noise = mean(noiseScores);
  /* The scores the bar is read from: the customer's model against itself, by the yardstick every
     model is then held to. The second look reads its bar from these pooled with its own, so the two
     have to be the same kind of score. */
  let barScores = noiseScores;
  /* Work with no one right answer, written or structured: the customer's own model gives a different, equally good
     answer to the same call so often that "the same answer" is no bar at all. Rather than give up, the bar becomes
     "at least as good": how often the customer's model gives a clearly worse answer than its own other one, read both
     ways round, and held to what the workload's own instruction asks of every answer. It used to be tried on written
     work only, read one way round, and kept only when that came out under the same 40% too: a judge leaning towards
     whichever answer it read first put a customer's model clearly worse than itself on 47% of calls, and the workload
     "could not be measured" at all. Now there is no such rate: a varied workload's bar is simply wide (marginFloor),
     and it takes more calls to show a setup keeps it. */
  const agreementNoise = noise;
  let judgeCheck = null;
  /* How this workload is judged: as its setting says (workloads.judge_mode), and by default by what its work is. "At least
     as good" where the customer's model varies so much that "the same answer" is no bar (varied), and for open-ended
     writing however well it agrees with itself: two poems from one model share a voice and read as the same, which set a
     bar no other model's different poem could meet. On 24 Sep a poem workload failed every model tested, and 492 of the
     498 differences counted against them were in wording alone (wl_mufo6b151fhb1ngm). Work whose own answers differ in
     figures, facts or decisions stays on "the same answer" however its requests read. */
  // a choice for written work only: answers with a shape are compared field by field, as their fields decide
  const judgeMode = shape === 'free_text' && ['same', 'quality'].includes(workload.judge_mode) ? workload.judge_mode : 'auto';
  const varied = !barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT);
  let openRead = null;
  if (judgeMode === 'auto' && !varied && shape === 'free_text' && config.EVAL_OPEN_ENDED && config.EVAL_QUALITY_YARDSTICK && canJudge()) {
    const facts = barRead ? barFacts / barRead : 0;
    if (facts > config.EVAL_OPEN_ENDED_FACTS_MAX) openRead = { yes: false, share: null, n: 0, judgedBy: null, facts };
    else {
      /* Work the newest measurement read as open-ended stays so unless its requests now clearly read otherwise
         (EVAL_OPEN_ENDED_KEEP_SHARE): the daily checks after a switch follow the newest measurement's way of judging, so
         a workload of mixed requests flipping between the two at every re-check would be held to one, then the other. */
      const before = await db.prepare(`SELECT plan_json FROM eval_runs WHERE workload_id = ? AND id <> ? AND status = 'done'
          AND yardstick IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(workload.id, run.id);
      let wasOpen = false;
      try { wasOpen = JSON.parse(before?.plan_json || 'null')?.judging?.reason === 'open-ended'; } catch { wasOpen = false; }
      if (await step(0, 'Reading what kind of writing your requests ask for')) return await endStopped();
      const r = await openEndedOf(kept.map((p) => askOf(p.body)), { scope: workload.workspace_id,
        share: wasOpen ? config.EVAL_OPEN_ENDED_KEEP_SHARE : config.EVAL_OPEN_ENDED_SHARE });
      addJudge(r.cost);
      openRead = { ...r, facts, kept: wasOpen };
    }
  }
  const judgeReason = judgeMode === 'same' ? null : judgeMode === 'quality' ? 'chosen' : varied ? 'varied' : openRead?.yes ? 'open-ended' : null;
  // what decided it, kept with the measurement so its page can say why each model was judged the way it was
  planRecord.judging = {
    mode: judgeMode, reason: judgeReason,
    // with the chance each request read was given, so what decided it can be seen request by request
    openEnded: openRead && { yes: !!openRead.yes, share: openRead.share, n: openRead.n, judge: openRead.judgedBy,
      ps: openRead.ps ?? [], factsShare: round8(openRead.facts), ...(openRead.kept ? { kept: true } : {}) },
  };
  if (config.EVAL_QUALITY_YARDSTICK && canJudge() && judgeReason) {
    const pairs = kept.filter((p) => p.a.ok && p.b.ok);
    // what the workload's instruction asks of every answer, read once for each version of it
    if (shape === 'free_text') {
      if (await step(0, 'Reading what your instruction asks of every answer')) return await endStopped();
      checklist = await checklistFor(workload, kept.map((p) => p.body), { charge: addJudge });
    }
    /* The judge is chosen on answers whose verdict is known before it is asked: answers planted as clearly worse (cut
       short, another request's, in the wrong language, ignoring the instruction) and one that is not (only its spacing
       changed). Jev reads them first; where it misses one, the language model reads them too, and the one that got
       them all right reads this run. Where both miss, nothing either settles is switched to on its word alone. */
    if (await step(0, 'Checking the judge on answers whose right verdict is known')) return await endStopped();
    const chosen = await chooseJudge(kept, { scope: workload.workspace_id, addJudge, checklist, shape });
    judgePrefer = chosen.prefer;
    judgeCheck = chosen.check;
    judgeUnsure = chosen.unsure;
    const phase = `Asking whether ${reference}'s answers are at least as good as each other`;
    if (await step(0, phase)) return await endStopped();
    total += pairs.length;
    const worse = [];
    try {
      await inParallel(pairs, 6, async (p) => {
        if (stopped || capped) return;
        if (await halted()) { stopped = true; return; }
        const room = outOfRoom(perCallUsd());
        if (room) { capped = room; return; }
        const j = await qualityOf(p.body, p.b.value, p.a.value);
        addJudge(j.cost);
        if (j.cost > 0 && await step(1, phase)) stopped = true;
        if (j.transient || j.score === null) { judgeMisses += 1; return; }
        if (j.judgedBy) judgedWith.add(j.judgedBy);
        p.worse = j.score;
        worse.push(j.score);
      });
    } catch (err) {
      await interrupt(`Something went wrong here while comparing the answers: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
      throw err;
    }
    if (stopped) return await endStopped();
    if (capped) return await endCapped(capped, `asking whether ${reference}'s answers are at least as good as each other`);
    /* Too few readings came back to set a bar from: the judge was not answering, which says nothing about the
       workload, so it tries again later rather than saying it cannot be measured. */
    if (!worse.length || (worse.length < Math.min(10, pairs.length) && worse.length * 2 < pairs.length)) {
      return await interrupt(`The judge answered on only ${worse.length} of the ${pairs.length} pairs of ${reference}'s answers, `
        + 'so the bar could not be set.');
    }
    yardstick = 'quality';
    noise = mean(worse);
    /* From here on the bar is "at least as good", and so is every reading of it: the second look's pooled bar, and
       the customer's model's own score on a call a strategy sends on to it. Pooled with the agreement scores, which
       only give way to this yardstick when they are over 40%, a second look's bar came out far above the first
       look's (agreement 55% and quality 6% gave about 38% against 7.5%), and a model clearly worse on 15% of calls
       was confirmed and switched to. */
    barScores = worse;
    for (const p of kept) p.noise = p.worse;
    planRecord.yardstick = {
      kind: 'quality', reason: judgeReason, agreementNoisePct: round8(agreementNoise * 100), qualityNoisePct: round8(noise * 100),
      marginPct: config.EVAL_QUALITY_MARGIN_PCT, judge: judgeCheck?.judge ?? null, checklist: checklist.map((x) => x.say),
    };
    await db.prepare('UPDATE eval_runs SET plan_json = ?, yardstick = ? WHERE id = ?').run(JSON.stringify(planRecord), 'quality', run.id);
  } else if (shape === 'free_text') {
    judgeCheck = await plantChecks(kept, workload.workspace_id, addJudge);
    judgeUnsure = judgeCheck.errors > 0;
  }
  if (judgeCheck) judgeCheckRecord = { ...judgeCheck, misses: judgeMisses, yardstick, prefer: judgePrefer };
  // how it is judged, and why, kept whichever way it went (under "at least as good" it is kept above already)
  if (yardstick !== 'quality') await db.prepare('UPDATE eval_runs SET plan_json = ? WHERE id = ?').run(JSON.stringify(planRecord), run.id);
  const floor = barFrom(noise * 100);

  // how fast the customer's own model is on these very calls: the yardstick for speed
  const timed = kept.flatMap((p) => [p.ra, p.rb]).filter((r) => r.ok && !r.recorded);
  const refLat = timed.map((r) => r.latencyMs);
  const refTtft = timed.map((r) => r.ttftMs);
  const refSpeed = {
    latencyP50: pct(refLat, 0.5), latencyP90: pct(refLat, 0.9),
    ttftP50: pct(refTtft, 0.5), ttftP90: pct(refTtft, 0.9),
  };
  await db.prepare(`UPDATE eval_runs SET noise_pct = ?, floor_pct = ?, ref_latency_p50 = ?, ref_latency_p90 = ?,
              ref_ttft_p50 = ?, ref_ttft_p90 = ? WHERE id = ?`)
    .run(round8(noise * 100), round8(floor), refSpeed.latencyP50, refSpeed.latencyP90,
         refSpeed.ttftP50, refSpeed.ttftP90, run.id);
  await db.prepare('UPDATE workloads SET floor_pct = ?, updated_at = ? WHERE id = ?')
    .run(round8(floor), now(), workloadId);

  /* If the reference model cannot answer its own calls consistently, "the same answer" is not a quality standard, it
     is noise; held to "at least as good" instead (above), it is measured whatever. This is left only for a deployment
     with nobody to judge whether one answer is as good as another, or with that yardstick turned off. */
  if (yardstick !== 'quality' && !barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT)) {
    await settle(`Measuring ${workload.slug}, setting the bar`);
    await keepSavings();
    if (!await finish('unmeasurable', `reference disagreed with itself on ${(noise * 100).toFixed(1)}% of calls`)) {
      return await endStopped();
    }
    await db.prepare(`UPDATE workloads SET status = 'no_match', status_note = ?, floor_pct = NULL,
                updated_at = ? WHERE id = ?`)
      .run('We could not measure this workload', now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `We could not measure ${workload.slug}`,
      detail: `${reference} gave a different answer to the same call ${(noise * 100).toFixed(0)}% of the time, `
        + 'and nothing here can judge whether one answer is as good as another, so there is no steady bar to hold a cheaper model to. '
        + 'Nothing has been switched.',
      workloadId,
    });
    await scheduleNext(workloadId, { changed: !automatic });
    return { ok: true, runId: run.id, floor: null, results: 0, unmeasurable: true };
  }

  if (!await settle(`Measuring ${workload.slug}, setting the bar`)) {
    await keepSavings();
    if (!await finish('no_balance', 'balance ran out after the bar was set')) return await endStopped();
    // what it bought is used again by the next one, which waits a while rather than an hour
    await deferAfterFailure(workloadId);
    await rest(workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} stopped early`,
      detail: 'Your balance ran out once the bar was set. Add credit and it picks up where it left off.',
      workloadId,
    });
    return { ok: true, runId: run.id, floor, results: 0, spend: 0, partial: true };
  }

  /* Whether the customer's model thought on these very calls, now that it has answered them.
     Candidates are asked to think the way it does, and the plan could only go on its catalogue
     entry or on earlier answers; where they disagree, what it just did wins. The model serving
     the workload now is measured exactly as it is served, because that is what is being checked. */
  const thought = kept.flatMap((p) => [p.ra, p.rb])
    .filter((r) => r.ok && r.reasoningTokens !== null && r.reasoningTokens !== undefined);
  const refThinks = thought.length >= 3
    ? thought.filter((r) => r.reasoningTokens > 0).length / thought.length >= 0.3
    : plan.refThinks;
  const served = (() => {
    try { return workload.routed_recipe ? JSON.parse(workload.routed_recipe) : null; } catch { return null; }
  })();
  /* What serves the workload now, by the name its result carries (see servingKey), and for a
     strategy the name of its lead model's own result, which is measured to work the strategy out
     again. Matched by name, never by model: the customer's own model thinking less and the same
     model from its cheapest provider are both the customer's model, and matched by model both were
     given the serving recipe, so the other one was measured as a copy of what serves and could "win"
     a switch to the very strategy already serving. */
  const servingNow = workload.routed_model ? await servingKey(workload) : null;
  const servingArmNow = workload.routed_arm_id ? await armById(workload.routed_arm_id) : null;
  const servingKind = ['cascade', 'router'].includes(servingArmNow?.spec?.kind) ? servingArmNow.spec.kind : null;
  const leadPart = servingKind ? leadModel(servingArmNow.spec) : null;
  // a part of a strategy by the name its own result carries: the model, or the customer's own asked another way
  const partKey = (part) => (part.model === reference && part.recipe?.reasoning ? `${reference}#lighter`
    : part.model === reference && part.recipe?.pinned ? `${reference}#cheapest` : part.model);
  const leadKey = leadPart ? partKey(leadPart) : null;
  /* A router by kinds of request serving now is re-checked as it is (see frozenKindsRouter), so every
     setup it sends calls to answers every call afresh, the way what serves always is. */
  const servingKinds = servingKind === 'router' && Number(servingArmNow?.spec?.version) === ROUTER_VERSION ? servingArmNow.spec : null;
  const servingParts = new Map(servingKinds ? servingKinds.options.map((o) => [o.key || partKey(o), o]) : []);
  const serves = (cand) => !!servingNow && (keyOf(cand) === servingNow || (leadKey !== null && keyOf(cand) === leadKey)
    || servingParts.has(keyOf(cand)));
  /* Whether a model is held to keeping up with this workload's requests (EVAL_KEEP_UP_REFUSALS): never what serves, which
     is carrying the workload now, nor the customer's own model asked another way, whose provider carries it today. */
  const heldToKeepUp = (cand) => cand.model !== reference && !serves(cand);
  // refusals at the longest wait enough to fail it; a limit of 0 switches the rule off rather than failing every model
  const keepUpFailed = (n) => config.EVAL_KEEP_UP_REFUSALS > 0 && n >= config.EVAL_KEEP_UP_REFUSALS;
  const isLighter = (cand) => String(cand.key || '').endsWith('#lighter');
  let reasked = false;
  let droppedLighter = false;
  if (refThinks !== plan.refThinks) {
    const facts = await loadFacts();
    /* The customer's model thinking less only means something when it thinks at all, so that one goes.
       Only that one: the same model from its cheapest provider does not depend on thinking, and used to
       go with it. One serving now stays either way, to be checked the way it is served. */
    if (refThinks === false) {
      for (let k = queue.length - 1; k >= 0; k -= 1) {
        if (isLighter(queue[k]) && !serves(queue[k])) { queue.splice(k, 1); droppedLighter = true; }
      }
    }
    for (const cand of queue) {
      if (serves(cand) || cand.key) continue;
      const m = facts.models.get(cand.model);
      const t = m ? thinkingFit(m, plan.profile, config.EVAL_THINKING_ROOM_TOKENS, refThinks) : null;
      if (t?.ok) { cand.recipe = t.recipe; cand.note = t.note || null; reasked = true; }
    }
  }
  for (const cand of queue) {
    // each part of a router is asked the way the router asks it; anything else serving, the way it is served
    if (servingParts.has(keyOf(cand))) cand.recipe = servingParts.get(keyOf(cand)).recipe ?? null;
    else if (serves(cand)) cand.recipe = served;
  }
  /* Every setup of a router by kind serving now answers every call, and first: moved to the front of the
     line wherever the plan had it, and counted in what the race finishes. Added only when it was missing,
     one the plan held further back could be left unmeasured once the others finished, and the re-check
     then read every call routed to it as wrong, and switched a healthy router back. */
  for (const [k, o] of [...servingParts].reverse()) {
    const at = queue.findIndex((q) => keyOf(q) === k);
    const part = at >= 0 ? queue.splice(at, 1)[0] : { model: o.model, key: k === o.model ? undefined : k, recipe: o.recipe ?? null,
      label: null, chance: null, savingShare: null, parts: null, family: null, note: 'part of the router serving now' };
    queue.unshift(part);
  }
  want = Math.max(want, servingParts.size);
  if (reasked || droppedLighter) {
    planRecord.refThinks = { planned: plan.refThinks, measured: refThinks };
    const nameOf = (o) => o.key || o.model;
    planRecord.order = planRecord.order.filter((o) => queue.some((q) => keyOf(q) === nameOf(o))).map((o) => {
      const c = queue.find((q) => keyOf(q) === nameOf(o));
      return { ...o, recipe: c?.recipe ?? null, note: c ? c.note ?? null : o.note };
    });
    await db.prepare('UPDATE eval_runs SET plan_json = ? WHERE id = ?').run(JSON.stringify(planRecord), run.id);
  }

  /* The speed a model has to keep: the workload's setting against the customer's own model's
     times on these calls. Typical and slow end both, because a model that is quick most of the
     time and very slow one call in ten is slow to whoever waits on that call. */
  const metric = speed.metric === 'ttft' && refSpeed.ttftP50 ? 'ttft' : 'latency';
  const refP50 = metric === 'ttft' ? refSpeed.ttftP50 : refSpeed.latencyP50;
  const refP90 = metric === 'ttft' ? refSpeed.ttftP90 : refSpeed.latencyP90;
  const slack = config.SPEED_SLACK_MS;
  const limit = speed.factor && refP50
    ? { p50: speed.factor * refP50 + slack, p90: speed.slowEnd * (refP90 ?? refP50) + slack } : null;
  /* Too slow on the evidence so far. On the first few calls the typical time has to be clearly
     over the limit, by a margin that shrinks as calls come in, because three calls cannot tell
     ten percent over from chance, and one slow call among a few happens to every model, the
     customer's included: on the first four measurements gpt-oss-20b started answering in about
     a second five times and then took seven seconds once, and was dropped for it. At the end,
     over every call, the typical time only has to be over. The slow end is judged by how many
     calls ran past it: about one in ten does for any model that keeps to the limit, so a model
     is slow at the end only when so many more do that chance would explain it less than one
     time in twenty. */
  const tooSlow = (st, { final = false } = {}) => {
    if (!limit) return false;
    const xs = metric === 'ttft' ? st.ttft : st.lat;
    if (xs.length < Math.min(config.EVAL_SCREEN_CALLS, kept.length)) return false;
    const margin = final ? 1 : 1 + 1.5 / xs.length;
    if (pct(xs, 0.5) > limit.p50 * margin) return true;
    /* Looked at again after every call, so each look on the way is held to one time in a hundred:
       at one in twenty each, a model exactly at the limit was dropped far more often than that. */
    return xs.filter((x) => x > limit.p90).length >= slowEndCount(xs.length, 0.1, final ? 0.05 : 0.01);
  };

  const refMonthly = await monthlyOn(workloadId, reference);
  const reviewBand = config.EVAL_REVIEW_BAND;
  /* The workload's routing priority (see src/eval/confidence.js): which of the setups that clear it
     switches to, and how strict the second look is. A cautious workload's second look is held to a
     one-sided 97.5% bound rather than 95%. */
  const workspaceRow = await db.prepare('SELECT default_routing_mode FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const routingMode = routingModeOf(workload, workspaceRow, config.ROUTING_MODE_DEFAULT);
  const confirmZ = routingMode === 'cautious' ? config.CAUTIOUS_Z : undefined;
  const results = [];
  let halt = null;

  /* How a call reads for a setup: every difference counted, or, for the strategy serving now read as it serves, without
     the ones that stand only because Jev's reading of which answer serves better did not come back (settled). Those
     count against anything that could be switched to, a setup of what serves included, and never towards switching
     back what serves, which a judge failing the same way at every re-check would otherwise do for good, on nothing.
     Null when the call says nothing that way. */
  const readingOf = (c, serving) => (!c.scored ? null : serving ? (c.settled ?? null) : c.score);
  /* What decides whether what serves keeps serving: its verdict read as it serves (keep, set beside its row by record and
     the frozen re-checks, never written), and anything else's own. Its written verdict ranks it against the rest. */
  const keepOf = (r) => r?.keep?.verdict ?? r?.verdict;
  const keepGap = (r) => (r?.keep ? r.keep.gap : r?.gap_pct);

  /* The calls the router by kind serving now sends each of its setups, by the name that setup's result
     carries, worked out once. Each setup answers those first (see tryModel): a refusal that is about the model
     rather than the request (no provider left that keeps nothing, a model withdrawn) then lands on a call the
     router sends it, and fails the router as it would a model on its own. In the order the calls were drawn,
     it could land first on a call of another kind, stop the setup there, and leave the router looking sound
     on the calls it happened to answer before. */
  let routedFirst = null;
  const routedFirstFor = (key) => {
    if (!servingKinds) return null;
    if (!routedFirst) {
      routedFirst = new Map();
      const names = servingKinds.options.map((o) => o.key || partKey(o));
      for (const [i, p] of kept.entries()) {
        const at = routeOf(servingKinds, featuresRaw(p.body)).option;
        if (at < 0 || !names[at]) continue;
        if (!routedFirst.has(names[at])) routedFirst.set(names[at], []);
        routedFirst.get(names[at]).push(i);
      }
    }
    return routedFirst.get(key) || null;
  };

  /* One model's run through the calls, until it finishes or cannot win. With `noDrop` it answers
     every call whatever its answers are like: a model a cascade might rescue is only worth
     judging on all of them. With `resume`, the run of it this measurement already has goes on from
     the call it stopped at: going through it again from the start re-read every answer it had just
     bought, counted each as an earlier measurement's saving, and kept each a second time. */
  const tryModel = async (cand, { noDrop = false, resume = null } = {}) => {
    const st = resume || {
      runs: 0, counted: 0, sum: 0, failures: 0, errors: 0, errorText: null, lat: [], ttft: [], reused: 0,
      candCost: 0, refCost: 0, kinds: new Map(), pairs: [], stopped: null, calls: [],
      // on how many of the calls it was scored on its answer was the better one (see judgeBetter)
      better: 0,
      // which providers answered it, by name, and how often
      providers: new Map(),
      // the next of the calls to put to it
      next: 0,
      // its requests turned away for coming too fast while it was already given the longest wait (see heldToKeepUp)
      tooFast: 0,
    };
    if (resume) st.stopped = null;
    const key = keyOf(cand);
    /* A model already serving this workload is re-checked on fresh answers, so a change in it shows:
       it answers every call afresh, and when it is finished after being dropped, only the answers it
       gave in this very run are used again, never ones from an earlier measurement. The customer's
       own model thinking less, or from its cheapest provider, is re-checked the same way when it is
       what serves. */
    const recheck = serves(cand);
    const reuse = noDrop || !recheck;
    const reuseSince = recheck ? runStartedAt : 0;
    answered.set(key, st.runs);
    /* The order it answers the calls in, kept with its run so one finished later goes on the same way: a setup
       of the router serving now answers the calls that router sends it first (see routedFirstFor); anything
       else, the calls as they were drawn. */
    if (!st.seq) {
      const first = routedFirstFor(key);
      const firstSet = new Set(first || []);
      st.seq = first ? [...first, ...[...kept.keys()].filter((x) => !firstSet.has(x))] : [...kept.keys()];
    }
    /* Its calls go out a few at a time (EVAL_CALLS_PER_MODEL), in its order, and everything about each is decided
       as it comes back, as when they went one at a time: once it cannot win, is too slow, is stopped, or would take
       the run past what it may spend, nothing more is sent, and the ones already out finish and count, since they
       are paid for. So a model that cannot win answers at most EVAL_CALLS_PER_MODEL - 1 more calls than it would
       have one at a time. One at a time, every measurement waited out each of a model's answers in turn. */
    const width = Math.max(1, config.EVAL_CALLS_PER_MODEL);
    let at = st.next ?? 0;
    let quit = false;
    // a call that threw, rethrown once the others out have come back
    let thrown = null;
    const out = new Set();
    // what one of its calls is likely to cost, counted against the limit while it is out
    const guess = () => (st.runs > 0 ? st.candCost / st.runs : perCallUsd());
    /* One call at a time until one has come back answered, then a few: a model refused on every call (withdrawn, or
       with no provider left that keeps nothing) is still asked once and stopped there, not refused a few times over. */
    const room = () => (st.runs - st.errors > 0 ? width : 1);
    const one = async (n) => {
      const i = st.seq[n];
      const p = kept[i];
      const r = await replayOnce({ body: p.body, callId: p.s.id, model: cand.model, recipe: cand.recipe, slot: 0, workload, reuse, reuseSince });
      note(r);
      // our own account, not this model: the whole measurement stops, and nothing is held against anybody
      if (r.account) { halt = 'account'; accountHit = accountHit || { ...r, model: cand.model }; st.stopped = 'user'; return 'quit'; }
      st.tooFast = (st.tooFast || 0) + (Number(r.refusedAtLongest) || 0);
      if (r.reused) st.reused += 1;
      st.runs += 1;
      let score = 1;
      // how much of this call's answer was the better one: 1, a share against two answers, or 0
      let better = 0;
      let judged = null;
      let failure = null;
      let counted = false;
      // whether this call says anything about the model's answers
      let scored = true;
      // the same without differences a reading left unsettled, where there were any (null: none left; see readingOf)
      let settled;
      if (!r.ok) {
        st.errors += 1;
        st.errorText = st.errorText || r.error;
        failure = 'refused';
        /* A provider that was only busy says nothing about the model's answers, so the call is
           not counted as a wrong one; it counts against the model's reliability instead. */
        if (r.transient) scored = false;
        /* A refusal that will be repeated ends this model now: it is refused for a reason of the
           provider's, like having no provider that keeps nothing. Two of the passing kind, busy or
           timing out, end it too, because a model that cannot be reached reliably in a test will
           not be in production either. */
        // never over a model already found unable to keep up, which is the failure that keeps it out for good
        if ((!r.transient || st.errors >= 2) && st.stopped !== 'busy') st.stopped = r.transient ? 'errors' : 'refused';
      } else {
        if (r.latencyMs) st.lat.push(r.latencyMs);
        if (r.provider) st.providers.set(String(r.provider), (st.providers.get(String(r.provider)) || 0) + 1);
        /* The first word is never later than the last, so an answer that came back in one piece,
           with no first word to time, is counted at its whole time rather than left out, which
           let a model that never streamed pass a first-word limit untimed. */
        const first = r.ttftMs ?? r.latencyMs;
        if (first !== null && first !== undefined) st.ttft.push(first);
        st.candCost += paid(r);
        st.refCost += p.refCost;
        const got = extract(r.json, shape);
        if (!got.ok) {
          st.failures += 1;
          failure = got.reason;
        } else if (shape === 'free_text' || yardstick === 'quality') {
          /* The replay has come back and is counted before the judgement is asked for, so a stop
             that lands between the two still counts the call that ran and was paid for. */
          answered.set(key, st.runs);
          if (await step(1, `Trying ${cand.label || cand.model}, ${st.runs} of ${kept.length} requests`)) {
            counted = true;
            halt = halt || 'stopped';
            st.stopped = 'user';
          }
          if (!st.stopped && await halted()) { halt = halt || 'stopped'; st.stopped = 'user'; }
          counted = true;
          if (st.stopped === 'user') {
            await keepReplay(run.id, p.s.id, key, 0, r, { score: null, judged: null, failure: null, scored: false });
            return 'quit';
          }
          judged = yardstick === 'quality'
            ? await qualityAgainst(p.body, got.value, p.a.ok ? p.a.value : p.b.value, p.a.ok && p.b.ok ? p.b.value : null)
            : await judgeCandidate(askOf(p.body), got.value, p.a.ok ? p.a.value : null, p.b.ok ? p.b.value : null,
              { scope: workload.workspace_id });
          addJudge(judged.cost);
          score = judged.score;
          better = yardstick === 'quality' ? (judged.detail?.candBetter ? 1 : 0)
            : Math.max(0, Math.min(1, Number(judged.detail?.better) || 0));
          if (judged.judgedBy) judgedWith.add(judged.judgedBy);
          if (judged.unsettled) settled = judged.settled ?? null;
          // a judgement that did not come back says nothing about this model's answer either
          if (judged.transient) { scored = false; judgeMisses += 1; }
        } else {
          /* Held to each of the customer's two answers and averaged, the way the bar is set: the
             bar is how often the customer's model differs from one of its own answers, so a copy
             of it scores the noise exactly. Its better match gave every candidate two chances. */
          /* A deciding field that differs makes the call different; written fields that differ only in
             wording are read for meaning, never counted as a difference on their own. */
          const both = [];
          // the same without differences a reading left unsettled (see readingOf)
          const bothSettled = [];
          const betters = [];
          let missed = false;
          let open = false;
          for (const ref of [p.a, p.b].filter((x) => x.ok)) {
            const d = disagreement(got, ref, shape);
            if (d !== null) { both.push(d); bothSettled.push(d); betters.push(0); continue; }
            const r = await proseScore(p.body, got, ref, shape, workload.workspace_id);
            addJudge(r.cost);
            if (r.transient) { missed = true; continue; }
            if (r.judgedBy) judgedWith.add(r.judgedBy);
            both.push(r.score);
            if (r.unsettled) open = true; else bothSettled.push(r.score);
            betters.push(r.better || 0);
          }
          // a written field nobody could read says nothing either way, unless a deciding one already differed
          if (!both.length && missed) { scored = false; judgeMisses += 1; score = 0; } else {
            score = both.length ? both.reduce((x, y) => x + y, 0) / both.length : 1;
            if (open) settled = bothSettled.length ? bothSettled.reduce((x, y) => x + y, 0) / bothSettled.length : null;
            better = betters.length ? betters.reduce((x, y) => x + y, 0) / betters.length : 0;
          }
        }
        st.pairs.push({ cand: got, ref: p.a.ok ? p.a : p.b, score, i });
      }
      const kind = score > 0 && scored ? (judged?.detail?.kind || failure || null) : null;
      if (kind) st.kinds.set(kind, (st.kinds.get(kind) || 0) + 1);
      if (scored) { st.sum += score; st.counted += 1; st.better += better; }
      // everything about this call a strategy built on this model would need to be worked out later
      st.calls.push({
        i, ok: !!r.ok && !failure, answered: !!r.ok, transient: !r.ok && !!r.transient, scored, score, better,
        settled: settled === undefined ? score : settled,
        json: r.ok ? r.json : null, cost: r.ok ? paid(r) : 0, latency: r.latencyMs ?? null, ttft: r.ttftMs ?? r.latencyMs ?? null,
      });
      await keepReplay(run.id, p.s.id, key, 0, r, { score, judged, failure, scored, readings: yardstick === 'quality' ? readingsOf(judged) : null });
      /* Its provider turned EVAL_KEEP_UP_REFUSALS of its requests away for coming too fast while it was already given the
         longest wait between them: it cannot keep up with this workload's traffic, so it has failed, before anything is
         said about its answers or its speed, and no later test of this workload tries it again (cantKeepUpOn in
         src/eval/history.js). Only slowed, it held the test at the longest wait for every one of its requests. It takes
         the place of any other reason it was stopped for (its answers, its speed, its errors or a refusal), so the ban is
         never lost to whichever came back first; never of a stop that was ours (a person, or the spending limit). */
      if (heldToKeepUp(cand) && keepUpFailed(st.tooFast) && st.stopped !== 'user' && st.stopped !== 'budget') st.stopped = 'busy';
      /* The best it could still do is get every remaining call right. When even that leaves it
         outside the review band, it cannot win, and every further call would be money spent on
         nothing. Never the one serving: that is a point estimate on part of the calls, and for what
         serves "missed" means a switch back held for months, so it answers every call and is judged
         on its range (see record). A serving model exactly as good as the customer's own was
         switched back on about one re-check in seven this way. */
      if (!noDrop && !st.stopped && !serves(cand) && (st.sum / kept.length) * 100 > floor * reviewBand) st.stopped = 'bar';
      /* The model serving the workload is timed on every call before anything is decided about its
         speed: a few slow calls early would otherwise switch a customer back on the least evidence. */
      if (!noDrop && !st.stopped && !serves(cand) && tooSlow(st)) st.stopped = 'speed';
      // a judgement that went out is a model call too, and is counted like one
      const judgeCalls = judged && judged.cost > 0 ? 1 : 0;
      answered.set(key, st.stopped ? kept.length : st.runs);
      if (await step((counted ? 0 : 1) + judgeCalls, `Trying ${cand.label || cand.model}, ${st.runs} of ${kept.length} requests`)) {
        halt = halt || 'stopped';
        if (!st.stopped) st.stopped = 'user';
        return 'quit';
      }
      return st.stopped ? 'quit' : null;
    };
    for (;;) {
      while (!quit && !st.stopped && !thrown && out.size < room() && at < st.seq.length) {
        if (halt) { st.stopped = halt === 'budget' || halt === 'balance' ? 'budget' : 'user'; quit = true; break; }
        /* Never past the most this test may spend, as its quote said, nor past what the balance covers: the quote counts a
           few calls for each model dropped early, and a model can be dropped late. Held to what has been spent and what the
           calls still out are likely to cost. */
        const over = outOfRoom();
        if (over) { halt = halt || over; st.stopped = 'budget'; quit = true; break; }
        if (await halted()) { halt = halt || 'stopped'; st.stopped = 'user'; quit = true; break; }
        const cost = guess();
        outUsd += cost;
        const k = at;
        at += 1;
        // a call that throws ends the model once the others out have come back, as one thrown alone did
        const task = one(k).then((said) => { if (said === 'quit') quit = true; }, (err) => { thrown = thrown || err; })
          .finally(() => { outUsd -= cost; out.delete(task); });
        out.add(task);
      }
      if (!out.size) break;
      await Promise.race(out);
    }
    // every call before this one has been asked and has come back
    st.next = at;
    /* Back in the order its calls were asked, whatever order they came back in: what is worked out from them later
       reads them by position (a router is chosen on some and scored on the others, see crossFit), and a
       measurement's result must not turn on which answer happened to arrive first. */
    const place = new Map(st.seq.map((x, k) => [x, k]));
    const inOrder = (a, b) => (place.get(a.i) ?? 0) - (place.get(b.i) ?? 0);
    st.calls.sort(inOrder);
    st.pairs.sort(inOrder);
    if (thrown) throw thrown;
    return st;
  };

  const record = async (cand, st) => {
    const finished = st.runs === kept.length && (!st.stopped || st.stopped === 'speed' || st.stopped === 'bar');
    /* The verdict carries how sure the sample can make anybody (see verdictWith): cleared only when
       even the top of its range is inside the bar, and "not enough calls" when this many calls could
       never show it, whatever the answers. */
    const judge = (scores) => {
      const read = verdictWith(scores, floor, { reviewBand });
      let verdict;
      if (st.stopped === 'refused' || st.stopped === 'errors' || st.stopped === 'busy') verdict = 'failed';
      else if (st.stopped === 'speed') verdict = 'slower';
      /* Dropped part way because even every remaining call right could not bring it inside the review
         band: it cannot win. Only a candidate is ever dropped that way, never what serves (see
         tryModel). One that answered every call is judged on its range like any other, whatever its
         last call did: turning every such stop into "missed" put a point estimate where the range
         should have decided. */
      else if (st.stopped === 'bar' && st.runs < kept.length) verdict = 'missed';
      else {
        verdict = read.verdict;
        if ((verdict === 'cleared' || verdict === 'review') && tooSlow(st, { final: true })) verdict = 'slower';
        // one refusal along the way is worth a look before anything is switched
        if (verdict === 'cleared' && st.errors > 0) verdict = 'review';
        // a judge that failed its known pairs this run settles nothing on its own
        if (judgeUnsure && verdict === 'cleared') verdict = 'review';
      }
      const gap = scores.length ? (scores.reduce((x, y) => x + y, 0) / scores.length) * 100 : 100;
      return { read, verdict, gap };
    };
    // every difference counted: what its row says, and how it ranks against every other (readingOf)
    const scoredScores = st.calls.map((c) => readingOf(c, false)).filter((x) => x !== null);
    const { read, verdict, gap } = judge(scoredScores);
    // how sure these calls make us that its true rate of worse or different answers is inside the bar
    const chance = scoredScores.length ? chanceWithin(scoredScores, floor) : null;
    /* What it would cost a month: its own cost on these calls against the customer's model's on
       the same calls, applied to the customer's real month. That carries every difference a list
       price hides: an answer that runs longer, thinking that is billed, a provider that charges
       more. The list price is the fallback when a model answered nothing. */
    const ratio = st.refCost > 0 && st.candCost > 0 ? st.candCost / st.refCost : null;
    const costMonth = refMonthly !== null && ratio !== null
      ? round8(refMonthly * ratio)
      : await monthlyOn(workloadId, cand.model);
    const g = gates(st.pairs, shape);
    const kinds = [...st.kinds.entries()].sort((a, b) => b[1] - a[1]);
    stats.set(keyOf(cand), { cand, st });
    const row = {
      id: id('res'), run_id: run.id, model_id: keyOf(cand), runs: st.runs,
      gap_pct: round8(gap), cost_month_usd: costMonth, verdict,
      gate_structure: Math.round(g.structure * 100), gate_accuracy: Math.round(g.accuracy * 100),
      gate_coverage: Math.round(g.coverage * 100), gate_complete: Math.round(g.complete * 100),
      failures: st.failures + st.errors, created_at: now(),
      latency_p50: pct(st.lat, 0.5), latency_p90: pct(st.lat, 0.9),
      ttft_p50: pct(st.ttft, 0.5), ttft_p90: pct(st.ttft, 0.9),
      // one that answered every call was not dropped early, even if its last call decided it
      errors: st.errors, stopped: finished ? null : st.stopped,
      error_text: st.errorText, difference: kinds.length ? (KIND_WORDS[kinds[0][0]] || kinds[0][0]) : null,
      reused: st.reused,
      rank_json: JSON.stringify({ chance: cand.chance, rawChance: cand.rawChance ?? null, savingShare: cand.savingShare, parts: cand.parts, family: cand.family }),
      recipe_json: servedRecipe(cand, st) ? JSON.stringify(servedRecipe(cand, st)) : null,
      providers_json: st.providers.size ? JSON.stringify(Object.fromEntries(st.providers)) : null,
      cost_ratio: ratio === null ? null : round8(ratio),
      // the customer's own model thinking less is a strategy of its own, served the way it was measured
      arm_json: cand.key ? JSON.stringify({ kind: 'model', model: cand.model, recipe: servedRecipe(cand, st) ?? null }) : null,
      escalated_pct: null,
      // where the true gap most likely is, and how many calls it would take to clear this bar
      gap_lo: round8(read.lo), gap_hi: round8(read.hi), calls_needed: read.need ?? null,
      // how sure we are it keeps the promise, what it saves times that, and how often its answer was the better one
      chance: chance === null ? null : round8(chance),
      safe_saving: ratio === null || chance === null ? null : round8(safeSaving(ratio, chance, config.ROUTING_FEE_PCT)),
      better_pct: st.counted ? round8((st.better / st.counted) * 100) : null,
    };
    /* The model that is itself what serves is judged as it serves as well, without the differences a reading left
       unsettled: kept beside its row and never written, that alone decides whether it keeps serving (keepOf). Its
       row ranks against the rest on every difference, as theirs does: ranked on the other, it came first where it
       should not have, and a cheaper setup behind it was never looked at again. */
    if (keyOf(cand) === servingNow) {
      const asServed = judge(st.calls.map((c) => readingOf(c, true)).filter((x) => x !== null));
      row.keep = { verdict: asServed.verdict, gap: round8(asServed.gap) };
    }
    await insertResult(row);
    // failed as unable to keep up: out of this workload's live experiments at once, as well as its tests (restBusyArms)
    if (row.stopped === 'busy') await restBusyArms(row.model_id);
    return finished;
  };

  /* The second look: the candidate on calls it has never seen, scored exactly as the first look scored
     it, against two of the customer's own model's answers to each call (the recorded one where there is
     one, and a replay), averaged. Scored against one answer instead, the second look was stricter than
     the first, and turned down models as good as the ones the first look let through.
     Enough calls that a model better than the bar can clear: EVAL_CONFIRM_MULTIPLE times what a perfect
     run needs, and never fewer than what a perfect run needs.

     Only calls no measurement of this workload has looked at, finished or not, and with too few of
     those there is no second look. Short of them it used to fall back on calls earlier measurements
     had used, whose answers were kept, so a model was "confirmed" on calls it had been chosen on. The
     calls a second look uses are kept with the run like its sample, so no later look takes them for
     unseen either.

     Every second look this run takes is on the same calls, and the customer's model answers them, and
     is compared with itself on them, once. A look at the next model on calls chosen afresh paid the
     customer's model again for most of them, and counted what it did find kept as answers reused from
     an earlier measurement. It is no weaker for it: the next model was not chosen on these calls
     either. */
  const looked = new Set();
  const keepLook = async (c, ra, rb) => {
    if (looked.has(c.id)) return;
    looked.add(c.id);
    await db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged)
                VALUES (?, ?, ?, ?, ?, ?, 0)`)
      .run(id('smp'), run.id, c.id, c.quartile ?? 0,
           ra.json ? JSON.stringify(ra.json) : null, rb.json ? JSON.stringify(rb.json) : null);
    // their times and costs too, as the first look keeps them, so a model's answers on these calls are set beside them
    await keepReplay(run.id, c.id, reference, 0, ra, { failure: ra.ok ? null : 'refused', look: 2 });
    await keepReplay(run.id, c.id, reference, 1, rb, { failure: rb.ok ? null : 'refused', look: 2 });
  };
  let lookCalls = null;
  // each looked-at call's two answers from the customer's model, how far they were from each other, and how long it took
  const lookRefs = new Map();

  /* One answer scored against the customer's model's answers to the same call, exactly as the first look
     scores a candidate's. Answers { score: null when it says nothing, judged: paid judgements }. */
  const scoreReply = async (body, got, refs) => {
    if (!refs.length || !got) return { score: null, judged: 0 };
    if (!got.ok) return { score: got.transient ? null : 1, judged: 0 };
    const g = extract(got.json, shape);
    if (!g.ok) return { score: 1, judged: 0 };
    let judged = 0;
    if (shape === 'free_text' || yardstick === 'quality') {
      const j = yardstick === 'quality'
        ? await qualityAgainst(body, g.value, refs[0].value, refs[1]?.value ?? null)
        : await judgeCandidate(askOf(body), g.value, refs[0].value, refs[1]?.value ?? null, { scope: workload.workspace_id });
      addJudge(j.cost);
      if (j.cost > 0) judged += 1;
      return { score: j.transient || j.score === null ? null : j.score, judged, readings: yardstick === 'quality' ? readingsOf(j) : null };
    }
    const each = [];
    for (const ref of refs) {
      const d = disagreement(g, ref, shape);
      if (d !== null) { each.push(d); continue; }
      const pr = await proseScore(body, g, ref, shape, workload.workspace_id);
      addJudge(pr.cost);
      if (pr.cost > 0) judged += 1;
      if (!pr.transient) each.push(pr.score);
    }
    return { score: each.length ? each.reduce((a, b) => a + b, 0) / each.length : null, judged };
  };

  /* The customer's model on one fresh call, asked once whatever looks at it: its two answers, how far they
     were from each other, and how long it took (a recorded answer carries no time, so the replay's, or the
     bar's typical time). Answers { seen, sent } or { account }. */
  const refsFor = async (c, body) => {
    const hit = lookRefs.get(c.id);
    if (hit) return { seen: hit, sent: 0 };
    let sent = 0;
    const had = recorded(c);
    const [ra, rb] = had ? [had, await replayOnce({ body, callId: c.id, model: reference, slot: 1, workload })]
      : await Promise.all([
        replayOnce({ body, callId: c.id, model: reference, slot: 0, workload }),
        replayOnce({ body, callId: c.id, model: reference, slot: 1, workload }),
      ]);
    if (had) recordedRefs += 1;
    note(ra);
    note(rb);
    const refHit = [ra, rb].find((x) => x.account);
    if (refHit) return { account: { ...refHit, model: reference } };
    await keepLook(c, ra, rb);
    sent += had ? 1 : 2;
    const refs = [extract(ra.json, shape), extract(rb.json, shape)].filter((x, k) => [ra, rb][k].ok && x.ok);
    let noise = null;
    if (refs.length === 2) {
      if (shape === 'free_text' || yardstick === 'quality') {
        const j = yardstick === 'quality'
          ? await qualityOf(body, refs[1].value, refs[0].value)
          : await judgeBarPair(askOf(body), refs[0].value, refs[1].value, { scope: workload.workspace_id, bar: true });
        addJudge(j.cost);
        if (j.cost > 0) sent += 1;
        if (!j.transient && j.score !== null && j.score !== undefined) noise = j.score;
      } else {
        const d = disagreement(refs[0], refs[1], shape);
        if (d !== null) noise = d;
        else {
          const pr = await proseScore(body, refs[0], refs[1], shape, workload.workspace_id, { subject: 'b' });
          addJudge(pr.cost);
          if (pr.cost > 0) sent += 1;
          if (!pr.transient) noise = pr.score;
        }
      }
    }
    const timed = [ra, rb].find((x) => x.ok && !x.recorded && Number.isFinite(x.latencyMs));
    const refLatency = timed?.latencyMs ?? refSpeed.latencyP50 ?? null;
    const seen = { refs, noise, refLatency, refTtft: timed ? (timed.ttftMs ?? timed.latencyMs) : (refSpeed.ttftP50 ?? refLatency) };
    lookRefs.set(c.id, seen);
    return { seen, sent };
  };

  /* The second look, for anything that can be switched to: a model, or a strategy. `answer(c, body, seen)`
     puts one fresh call to it and answers { score, sent, latency, ttft } or { account }. Held to the bar read
     from both samples, at the workload's strictness (a cautious workload's is 97.5% rather than 95%), and to
     the speed rule on these calls too: a second look used to check answers only, so a model that was quick
     on the first sample and slow on the second went through. */
  /* `busy`, when given, names the model (by its row's key) a look has found cannot keep up, or null: the look then sends
     nothing more, ends as 'busy', and that model's row says it failed (failBusy). */
  const lookAgain = async (r, freshCalls, { label, answer, busy = () => null }) => {
    const least = callsToClear(floor, confirmZ);
    const from = freshCalls.filter((c) => !seenBefore.has(c.id));
    if (from.length < least) {
      await db.prepare('UPDATE eval_results SET confirm_runs = 0, confirm_verdict = ? WHERE id = ?').run('insufficient', r.id);
      Object.assign(r, { confirm_runs: 0, confirm_verdict: 'insufficient' });
      return { verdict: 'insufficient', runs: 0,
        note: `there are not yet enough calls it has not seen to look again (${from.length} of the ${least} needed)` };
    }
    /* Never thinner than the first look: a second look on fewer calls is a noisier one, not a stricter one.
       And sized at the usual strictness whatever this one is held to: a cautious look is stricter by its
       bound, not by reading more calls. Sized by its own bound it read about 250 calls at a 3% bar rather
       than 176, which let it clear with two worse answers where the usual look allows one, so a cautious
       workload switched more often, and in simulation to a setup past its bar more often, than a balanced one. */
    const n = Math.min(from.length, Math.max(least, config.EVAL_CONFIRM_MIN, Math.ceil(config.EVAL_CONFIRM_MULTIPLE * callsToClear(floor)), samples.length));
    lookCalls = lookCalls || sampleCalls(from, n, (now() % 99991) + 13);
    const picks = lookCalls;
    // the calls it will send: its own one, and one or two of the customer's model where they are not in hand
    const sends = (c) => (lookRefs.has(c.id) ? 1 : recorded(c) ? 2 : 3);
    confirmLeft = picks.reduce((a, c) => a + sends(c), 0);
    // what is left of this look, and of the looks after it that could still come (see looksAhead)
    remaining = () => confirmLeft + looksAhead;
    const scores = [];
    const lat = [];
    const ttft = [];
    // the customer's own model against itself on these calls too, so the bar is read from both samples
    const freshNoise = [];
    /* A few of the calls at once, as in a model's first look (see tryModel), ended the same way: a stop, a problem
       with our own account or the spending limit sends nothing more, and the calls already out finish. There is
       nothing to decide part way here, since every call is read. */
    let over = false;
    // the model this look found cannot keep up, once it has (see busy)
    let busyKey = null;
    await inParallel(picks, Math.max(1, config.EVAL_CALLS_PER_MODEL), async (c) => {
      if (over || halt) { over = true; return; }
      const room = outOfRoom();
      if (room) { if (room === 'balance') halt = halt || 'balance'; over = true; return; }
      if (await halted()) { halt = 'stopped'; over = true; return; }
      confirmLeft = Math.max(0, confirmLeft - sends(c));
      const body = JSON.parse(c.request_json);
      const cost = perCallUsd() * sends(c);
      outUsd += cost;
      try {
        const got = await refsFor(c, body);
        if (got.account) { halt = 'account'; accountHit = got.account; over = true; return; }
        const { seen } = got;
        if (seen.noise !== null) freshNoise.push(seen.noise);
        const a = seen.refs.length ? await answer(c, body, seen) : { score: null, sent: 0 };
        if (a.account) { halt = 'account'; accountHit = a.account; over = true; return; }
        if (!busyKey) {
          busyKey = busy();
          if (busyKey) over = true;
        }
        if (a.score !== null && a.score !== undefined) scores.push(a.score);
        if (Number.isFinite(a.latency)) lat.push(a.latency);
        if (Number.isFinite(a.ttft)) ttft.push(a.ttft);
        if (await step(got.sent + (a.sent || 0), `Testing ${label} again on new requests, ${scores.length} of ${picks.length}`)) {
          halt = 'stopped';
          over = true;
        }
      } finally {
        outUsd -= cost;
      }
    });
    confirmLeft = 0;
    /* A model its provider could not keep up with on these calls has failed whatever its answers were like: nothing
       more is read into them, and the next in line gets its look. */
    if (busyKey) {
      const note = `its provider turned requests away for coming too fast even with ${Math.round(config.MODEL_BACKOFF_MAX_MS / 1000)} seconds `
        + 'between them, so it cannot keep up with this workload';
      await db.prepare(`UPDATE eval_results SET confirm_runs = ?, confirm_verdict = 'busy', confirm_note = ? WHERE id = ?`)
        .run(scores.length, note, r.id);
      Object.assign(r, { confirm_runs: scores.length, confirm_verdict: 'busy', confirm_note: note });
      await failBusy(busyKey);
      // a strategy one of whose models could not keep up has failed with it
      if (busyKey !== r.model_id) await failBusy(r.model_id);
      return { verdict: 'busy', runs: scores.length, note };
    }
    /* The bar, read from both samples: how often the customer's model disagreed with itself on the first
       look's calls and on these. A bar read from one sample of a hundred moves a good deal by chance,
       and a second look held to the first sample's bar alone turned good models down whenever the two
       samples happened to differ. The candidate's own reading is from these calls only, as it must be.
       Both samples are read by the same yardstick: under "at least as good", the first look's bar
       scores are the quality ones (see barScores), as these are, and the bar is theirs plus the margin. */
    const pooled = [...barScores, ...freshNoise];
    const bar = pooled.length ? barFrom(mean(pooled) * 100) : floor;
    const v = verdictWith(scores, bar, { reviewBand, z: confirmZ });
    let verdict = judgeUnsure && v.verdict === 'cleared' ? 'review' : v.verdict;
    let note = null;
    if (verdict === 'cleared' && limit && tooSlow({ lat, ttft }, { final: true })) {
      verdict = 'slower';
      const xs = metric === 'ttft' ? ttft : lat;
      note = `on the calls it had not seen it took ${((pct(xs, 0.5) ?? 0) / 1000).toFixed(1)} s typically, more than your speed setting allows`;
    }
    await db.prepare(`UPDATE eval_results SET confirm_runs = ?, confirm_gap = ?, confirm_hi = ?, confirm_verdict = ?, confirm_floor = ?,
                confirm_note = ? WHERE id = ?`)
      .run(scores.length, round8(v.gap), round8(v.hi), verdict, round8(bar), note, r.id);
    // kept on the row this run holds too, so what it does next (markTrying, the page) reads the same
    Object.assign(r, { confirm_runs: scores.length, confirm_gap: round8(v.gap), confirm_hi: round8(v.hi), confirm_verdict: verdict,
      confirm_floor: round8(bar), confirm_note: note });
    return { verdict, runs: scores.length, gap: v.gap, hi: v.hi, floor: bar, note };
  };

  const confirmOn = async (r, freshCalls) => {
    const { cand, st } = stats.get(r.model_id) || {};
    if (!cand) return { verdict: 'unconfirmed', runs: 0, note: 'there was nothing to look again with' };
    /* Asked exactly the way a switch to it would serve it (servedRecipe): an open model from the providers that
       answered it the first time, and never with a cascade's leave to fall back on others. Asked the way it
       happened to be asked before, a second look could be answered by providers a switch would never use. */
    const served = servedRecipe(cand, st);
    /* its requests turned away at the longest wait in this whole test, its first look's included (see heldToKeepUp): the
       rule is three in a test, and counted afresh on each look, two and two never added up to it */
    let tooFast = Number(st?.tooFast) || 0;
    return lookAgain(r, freshCalls, {
      label: cand.label || cand.model,
      busy: () => (heldToKeepUp(cand) && keepUpFailed(tooFast) ? r.model_id : null),
      answer: async (c, body, seen) => {
        const got = await replayOnce({ body, callId: c.id, model: cand.model, recipe: served, slot: 0, workload });
        note(got);
        if (got.account) return { account: { ...got, model: cand.model } };
        tooFast += Number(got.refusedAtLongest) || 0;
        const s = await scoreReply(body, got, seen.refs);
        /* Kept like an answer to its first look, as the second look, so its page can show the calls this look was
           decided on: counted where it has a score, which is what the look's figure averages (lookAgain). */
        const read = got.ok ? extract(got.json, shape) : null;
        await keepReplay(run.id, c.id, r.model_id, 0, got, {
          score: s.score, scored: s.score !== null && s.score !== undefined, look: 2,
          failure: !got.ok ? 'refused' : !read.ok ? read.reason : null, readings: s.readings ?? null,
        });
        return { score: s.score, sent: 1 + s.judged, latency: got.ok ? got.latencyMs : null, ttft: got.ok ? (got.ttftMs ?? got.latencyMs) : null };
      },
    });
  };

  /* A strategy's second look, on the same fresh calls as any other: a cascade answers with its cheap model,
     its check reads the answer, and a doubtful one is sent on to the customer's model; a router picks
     before anything is sent. It used to have no second look before a switch at all, only its live rollout,
     so a strategy that was lucky on one sample was switched to on that sample alone. */
  const confirmStrategyOn = async (r, freshCalls) => {
    let spec = null;
    try { spec = JSON.parse(r.arm_json); } catch { spec = null; }
    if (!spec || !['cascade', 'router'].includes(spec.kind)) return { verdict: 'unconfirmed', runs: 0, note: 'there was nothing to look again with' };
    /* each of its models' requests turned away at the longest wait in this whole test, from its own first look on (the
       rule is three in a test), and the first of them that could not keep up */
    const tooFast = new Map();
    let busyPart = null;
    const ask = async (part, c, body) => {
      const got = await replayOnce({ body, callId: c.id, model: part.model, recipe: part.recipe ?? null, slot: 0, workload });
      note(got);
      const k = partKey(part);
      const had = tooFast.has(k) ? tooFast.get(k) : Number(stats.get(k)?.st?.tooFast) || 0;
      const n = had + (Number(got.refusedAtLongest) || 0);
      tooFast.set(k, n);
      if (!busyPart && heldToKeepUp({ model: part.model, key: k }) && keepUpFailed(n)) busyPart = k;
      return got;
    };
    // what the customer's own model gives the call: as far from its other answer as it is here, as long as it took
    const own = (seen, before = 0, sent = 0) => ({
      score: seen.noise ?? noiseMean, sent,
      latency: before + (seen.refLatency ?? 0), ttft: before + (seen.refTtft ?? seen.refLatency ?? 0),
    });
    return lookAgain(r, freshCalls, {
      label: labelOf(spec, reference),
      busy: () => busyPart,
      answer: async (c, body, seen) => {
        if (spec.kind === 'cascade') {
          const first = await ask(spec.first, c, body);
          if (first.account) return { account: { ...first, model: spec.first.model } };
          let pass = false;
          let ms = 0;
          let sent = 1;
          if (first.ok && structureOf(body, first.json, shape).ok) {
            try {
              const j = await jevCheck(body, first.json, shape, { scope: workload.workspace_id });
              addJudge(j.cost);
              if (j.cost > 0) sent += 1;
              ms = j.ms || 0;
              pass = Number(j.p) >= Number(spec.threshold);
            } catch { pass = false; }
          }
          const before = (first.latencyMs ?? 0) + ms;
          if (!pass) return own(seen, before, sent);
          const s = await scoreReply(body, first, seen.refs);
          return { score: s.score, sent: sent + s.judged, latency: before, ttft: before };
        }
        const part = Number(spec.version) === ROUTER_VERSION
          ? (() => { const rt = routeOf(spec, featuresRaw(body)); return rt.option < 0 ? null : spec.options[rt.option]; })()
          : (predict(spec, featuresOf(body)) >= spec.threshold ? spec.cheap : null);
        if (!part || (part.model === reference && !part.recipe)) return own(seen);
        const got = await ask(part, c, body);
        if (got.account) return { account: { ...got, model: part.model } };
        const s = await scoreReply(body, got, seen.refs);
        return { score: s.score, sent: 1 + s.judged, latency: got.ok ? got.latencyMs : null, ttft: got.ok ? (got.ttftMs ?? got.latencyMs) : null };
      },
    });
  };
  let confirmLeft = 0;

  const insertResult = async (row) => {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict,
                gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at,
                latency_p50, latency_p90, ttft_p50, ttft_p90, errors, stopped, error_text, difference, reused,
                rank_json, recipe_json, cost_ratio, arm_json, escalated_pct, gap_lo, gap_hi, calls_needed, providers_json,
                chance, safe_saving, better_pct)
                VALUES (@id, @run_id, @model_id, @runs, @gap_pct, @cost_month_usd, @verdict,
                @gate_structure, @gate_accuracy, @gate_coverage, @gate_complete, @failures, @created_at,
                @latency_p50, @latency_p90, @ttft_p50, @ttft_p90, @errors, @stopped, @error_text, @difference, @reused,
                @rank_json, @recipe_json, @cost_ratio, @arm_json, @escalated_pct, @gap_lo, @gap_hi, @calls_needed, @providers_json,
                @chance, @safe_saving, @better_pct)`)
      .run({ gap_lo: null, gap_hi: null, calls_needed: null, providers_json: null, chance: null, safe_saving: null, better_pct: null, ...row });
    results.push(row);
  };

  /* A model found unable to keep up after its row was written (finished later for a strategy, or on its second look):
     its row says so from then on, as the failure it is, so its page shows why and no later test of this workload tries
     it again (cantKeepUpOn in src/eval/history.js). */
  const failBusy = async (modelKey) => {
    failedBusy.add(modelKey);
    await db.prepare(`UPDATE eval_results SET verdict = 'failed', stopped = 'busy' WHERE run_id = ? AND model_id = ?`).run(run.id, modelKey);
    for (const x of results) if (x.model_id === modelKey) Object.assign(x, { verdict: 'failed', stopped: 'busy' });
    await restBusyArms(modelKey);
  };
  /* A runner-up this workload's live experiments were trying that is, or sends calls to, a model found unable to keep up
     is set aside at once. The end of a measurement does that too (markTrying), but a measurement cut short never gets
     there, and live calls went on reaching a model this one had failed. */
  const restBusyArms = async (modelKey) => {
    const uses = (spec) => (spec?.kind === 'cascade' ? [spec.first] : spec?.kind === 'router' ? (spec.options || [spec.cheap]) : [spec])
      .some((p) => p?.model && (p.key || partKey(p)) === modelKey);
    for (const a of await armsFor(workloadId)) if (a.status === 'trying' && uses(a.spec)) await setStatus(a.id, 'resting');
  };
  // every model this run has found cannot keep up since its row was written (failBusy)
  const failedBusy = new Set();
  /* The models a row sends calls to, by the names their own rows carry: the model itself, or a strategy's parts, less the
     customer's own model, which is never held to keeping up. */
  const partsOfRow = (r) => {
    if (plainResult(r)) return [r.model_id];
    let spec = null;
    try { spec = JSON.parse(r.arm_json); } catch { spec = null; }
    const parts = spec?.kind === 'cascade' ? [spec.first]
      : spec?.kind === 'router' ? (Array.isArray(spec.options) ? spec.options : [spec.cheap, spec.strong]) : [];
    return parts.filter((p) => p?.model && p.model !== reference).map((p) => p.key || partKey(p));
  };

  /* The race. Several models at once, each in its own lane, the next in line starting as soon
     as a lane frees up, until enough have answered every call. A lane with nothing to start
     waits for a running model to end, because a model dropped part way through gives its place
     to the next in line. */
  let next = 0;
  let running = 0;
  let finished = 0;
  const answered = new Map();
  // each model's run, kept for the strategies worked out once the race is over
  const stats = new Map();
  let accountHit = null;
  let overQuote = false;
  const quote = Number(plan.estimateUsd) || 0;
  const softLimit = Math.min(quote > 0 ? quote * 1.5 : config.EVAL_MAX_USD_PER_RUN, capLimit);
  /* Never past the most this test may spend (capLimit, its quote's "at most" before our fee), which already allows for
     what one measurement of this workload may spend, the testing limit left and the balance free. */
  const hardLimit = capLimit;
  /* The second looks to come (see below), counted into what is left from the start of the race: without them the
     count grew by half again once the race ended, and the page's bar ran backwards or sat still. Up to
     EVAL_CONFIRM_TRIES of them where there are enough calls no measurement has looked at for one, each on as many
     calls as lookAgain takes: the first asks the customer's own model about each call as well, the ones after reuse
     those answers. When fewer are needed, or none, the measurement ends sooner than it said, which is the way round
     a count may be wrong. */
  const sampledIds = new Set(samples.map((x) => x.id));
  const unseenCalls = pool.filter((c) => !sampledIds.has(c.id) && !seenBefore.has(c.id)).length;
  const lookSize = Math.min(unseenCalls, Math.max(callsToClear(floor, confirmZ), config.EVAL_CONFIRM_MIN,
    Math.ceil(config.EVAL_CONFIRM_MULTIPLE * callsToClear(floor)), samples.length));
  looksAhead = unseenCalls >= callsToClear(floor, confirmZ) ? lookSize * (1 + Math.max(1, config.EVAL_CONFIRM_TRIES)) : 0;
  remaining = () => {
    let left = 0;
    for (const n of answered.values()) left += Math.max(0, kept.length - n) * perCall;
    const open = Math.max(0, want - finished - answered.size);
    return left + Math.min(open, Math.max(0, queue.length - next)) * kept.length * perCall + looksAhead;
  };
  const waiters = [];
  const wakeAll = () => { while (waiters.length) waiters.shift()(); };
  const lanes = Math.max(1, Math.min(config.EVAL_PARALLEL_MODELS, want, queue.length));
  let laneError = null;
  const lane = async () => {
    for (;;) {
      if (halt || finished >= want || next >= queue.length) return;
      /* The models asked for always start: the quote was for them. A replacement for one dropped
         part way does not start once half as much again as the quote has gone, and the ones
         running finish, because stopping them part way would waste what they have answered. */
      if (next >= want && spentTotal >= softLimit) { overQuote = true; return; }
      if (finished + running >= want) {
        await new Promise((r) => { waiters.push(r); });
        continue;
      }
      const cand = queue[next];
      next += 1;
      running += 1;
      try {
        const st = await tryModel(cand);
        if (st.stopped !== 'user' && st.stopped !== 'budget') {
          if (await record(cand, st)) finished += 1;
        }
      } finally {
        /* Its place is given up only once its result is written: given up before, another lane
           saw a free place while this one was still being recorded, and started a model more
           than was asked for, paid for on every call. */
        running -= 1;
      }
      answered.delete(keyOf(cand));
      /* Charged as each model ends, the way a measurement always settled: often enough that a
         balance running low stops the next model starting, without a charge in the middle of
         every model's calls. */
      if (!halt && !await settle(`Measuring ${workload.slug} on ${cand.model}`)) halt = 'balance';
      wakeAll();
    }
  };
  // one lane that throws stops the others from starting anything, and is dealt with once they end
  const guarded = async () => {
    try { await lane(); } catch (err) { laneError = laneError || err; halt = halt || 'error'; } finally { wakeAll(); }
  };
  await Promise.all(Array.from({ length: lanes }, guarded));
  wakeAll();
  // the next plan, for any workload, sees how fast these models were and whether any was busy
  forgetFleet();

  /* Our own account with the provider refused a call. That is nothing about any model and true of
     every model at once, so the measurement stops there, the alert goes out, and it ends interrupted
     in the provider's words, wherever it had got to: the race, the strategies, or the second look.
     Met after the race, it used to be left unread, and the run ended "compared" with nothing said. */
  const accountHalt = async () => {
    reportCallFailure({ kind: 'measurement replays', model: accountHit?.model ?? null, status: accountHit?.status, message: accountHit?.error });
    return await interrupt(accountProblem(accountHit));
  };
  if (halt === 'stopped') return await endStopped();
  if (laneError) {
    await interrupt(`Something went wrong here part way through: ${String(laneError?.message || laneError).slice(0, 160)}.`, { retryMs: 0 });
    throw laneError;
  }
  if (halt === 'account') return await accountHalt();

  /* Strategies, for the cheaper models that could not manage alone, and for routing by kind of request.
   *
   * A model wrong on a small share of calls misses the bar, and most of what it would save is
   * lost with it. A cascade keeps that saving on the calls it gets right: it answers first, a
   * quick check reads the answer, and a doubtful one is sent on to the customer's own model. A
   * router picks before the call is sent: the workload's calls are grouped into the kinds of request
   * they are, and each kind goes to the cheapest setup that does it well enough, or to the
   * customer's own model (src/learn/kinds.js). Both are worked out here from answers already paid
   * for, plus one check per answer for a cascade, and only what clears the bar on calls it did not
   * learn from, and then again on calls nobody has looked at (see lookAgain), can be switched to. */
  const noiseMean = mean(barScores);
  /* The customer's model on one call: what it cost, how long it took, and how far its answer was from
     its own other one. A recorded answer carries no timing of its own (its latency is not ours to
     measure), so the replay beside it is timed instead, and failing that the bar's typical time; read
     as nothing, a recorded answer made every call a strategy sent on look instant. */
  const refOfPair = (p) => {
    const timed = [p.ra, p.rb].find((r) => r?.ok && !r.recorded && Number.isFinite(r.latencyMs));
    const latency = timed?.latencyMs ?? refSpeed.latencyP50 ?? null;
    const ttft = timed ? (timed.ttftMs ?? timed.latencyMs) : (refSpeed.ttftP50 ?? latency);
    return { cost: p.refCost, latency, ttft, noise: p.noise ?? noiseMean };
  };
  const quickEnough = (xs) => {
    if (!limit) return true;
    return !tooSlow(metric === 'ttft' ? { ttft: xs, lat: xs } : { lat: xs, ttft: xs }, { final: true });
  };
  // a check's cost on a live call: what Jev reads, at its price per token
  const liveCheckCost = (p, json) => ((requestText(p.body).length + checkedText(json).length) / 4 + 350)
    * (config.JEV_PRICE_PER_MTOK / 1e6);
  const strategyRow = (cand, spec, reading, verdict, extra = {}) => {
    const costMonth = refMonthly !== null && reading.ratio !== null ? round8(refMonthly * reading.ratio) : null;
    const chance = reading.scores?.length ? chanceWithin(reading.scores, floor) : null;
    return {
      id: id('res'), run_id: run.id, model_id: keyOfSpec(spec, reference), runs: kept.length,
      gap_pct: round8(reading.gap), cost_month_usd: costMonth, verdict,
      gate_structure: 100, gate_accuracy: Math.round(100 - reading.gap), gate_coverage: 100, gate_complete: 100,
      failures: 0, created_at: now(),
      latency_p50: pct(reading.latency, 0.5), latency_p90: pct(reading.latency, 0.9),
      ttft_p50: pct(reading.ttft, 0.5), ttft_p90: pct(reading.ttft, 0.9),
      errors: 0, stopped: null, error_text: null, difference: extra.difference ?? null, reused: 0,
      rank_json: JSON.stringify({ chance: cand.chance, savingShare: cand.savingShare, parts: cand.parts, family: cand.family,
        ...(extra.rank || {}) }),
      recipe_json: cand.recipe ? JSON.stringify(cand.recipe) : null,
      cost_ratio: reading.ratio === null ? null : round8(reading.ratio),
      arm_json: JSON.stringify(spec), escalated_pct: round8(reading.escalated * 100),
      gap_lo: reading.read ? round8(reading.read.lo) : null, gap_hi: reading.read ? round8(reading.read.hi) : null,
      calls_needed: reading.read?.need ?? null,
      chance: chance === null ? null : round8(chance),
      safe_saving: reading.ratio === null || chance === null ? null : round8(safeSaving(reading.ratio, chance, config.ROUTING_FEE_PCT)),
      better_pct: null,
    };
  };
  /* A strategy's verdict comes from its held-out per-call scores (see crossFit), through the same
     interval rule as a plain model's. */
  const verdictOf = (reading) => {
    const read = verdictWith(reading.scores || [], floor, { reviewBand });
    reading.read = read;
    let v = read.verdict;
    if ((v === 'cleared' || v === 'review') && !quickEnough(metric === 'ttft' ? reading.ttft : reading.latency)) v = 'slower';
    if (reading.slow && (v === 'cleared' || v === 'review')) v = 'slower';
    /* A judge that got answers planted to test it wrong settles nothing on its own, and a strategy's scores are its
       readings too: a cascade over a model held back for exactly that cleared, and could have been switched to. What
       serves keeps serving on "review", as a plain model does. */
    if (judgeUnsure && v === 'cleared') v = 'review';
    return v;
  };
  const fastEnough = (r) => quickEnough(metric === 'ttft' ? r.ttft : r.latency);
  const plainResult = (r) => !r.arm_json || String(r.model_id).endsWith('#lighter') || String(r.model_id).endsWith('#cheapest');
  // what a result is called in the activity feed and in email: a strategy by its words, a model by its name
  const shown = (r) => (r && !plainResult(r) ? nameOfResult(r).label : r?.model_id);

  const cascadeFor = async (cand, st, { serving = false } = {}) => {
    /* Its cheap model is served the way it was measured, by the providers that answered it here first, but not
       only by them: a cascade sends a call on to the customer's model whenever its first step fails, so held to
       those providers alone, one that was busy sent every call on at the customer's model's price. Another
       provider answers instead, and the check reads that answer like any other. Left free altogether, it was
       served by providers never measured even while the measured ones were there. */
    const measured = servedRecipe(cand, st);
    // never for a model held to one provider on purpose (#cheapest): that one is served by it alone, however it is used
    const first = measured?.providers && !measured.pinned ? { ...measured, preferred: true } : (measured ?? null);
    const spec = { kind: 'cascade', first: { model: cand.model, recipe: first }, fallback: { model: reference, recipe: null } };
    const label = labelOf(spec, reference);
    const checks = [];
    let checked = 0;
    for (const c of st.calls) {
      const p = kept[c.i];
      if (!c.ok) { checks.push({ structureOk: false, p: 0, ms: 0, liveCost: 0 }); continue; }
      const shapeOk = structureOf(p.body, c.json, shape);
      if (!shapeOk.ok) { checks.push({ structureOk: false, p: 0, ms: 0, liveCost: 0 }); continue; }
      if (halt || spentTotal >= hardLimit || lowBalance) { if (lowBalance) halt = halt || 'balance'; return false; }
      if (await halted()) { halt = 'stopped'; return false; }
      let j;
      try { j = await jevCheck(p.body, c.json, shape, { scope: workload.workspace_id }); } catch { return false; }
      addJudge(j.cost);
      checked += 1;
      strategyLeft = Math.max(0, strategyLeft - 1);
      if (j.cost > 0 && await step(1, `Checking ${short(cand.model)}'s answers, ${checked} of ${kept.length}`)) { halt = 'stopped'; return false; }
      checks.push({ structureOk: true, p: j.p, ms: j.ms || 0, liveCost: liveCheckCost(p, c.json) });
    }
    /* The strictness is chosen on some calls and scored on the others (crossFit), so the gap reported
       is one the choice never saw; the strictness served is the one chosen on all of them. */
    const readingsOf = (cs) => simulateCascade(cs, { checkCost: (c) => c.liveCost, checkMs: (c) => c.ms });
    /* Judged with every difference counted, which is what its row says and how it ranks against the rest; the
       cascade serving now is judged as it serves as well, without the differences a reading left unsettled, and
       that alone decides whether it keeps serving (keepOf). Both from the checks above: nothing is asked twice. */
    const judgedAs = (lenient) => {
      const calls = st.calls.map((c, k) => ({ ok: c.ok, score: readingOf(c, lenient) ?? (kept[c.i].noise ?? noiseMean),
        cost: c.cost, latency: c.latency, ttft: c.ttft, check: checks[k], ref: refOfPair(kept[c.i]) }));
      const cf = crossFit(calls.map((c, k) => ({ ...c, liveCost: checks[k].liveCost, ms: checks[k].ms })), readingsOf,
        (rs) => bestOf(rs, { floor, reviewBand, fast: fastEnough }));
      const best = { ...cf.heldOut, threshold: cf.threshold, inside: cf.inSample.inside, near: cf.inSample.near, slow: cf.inSample.slow };
      /* How much of the cheap model's wrong answers the check catches, at the strictness served. A cascade
         is only as good as its check: one that clears the bar because the cheap model is rarely wrong, with
         a check that lets most of its mistakes through, fails the day the cheap model slips. Studies of
         cascades find they only pay while the check is wrong on under about one answer in ten, so a check
         that misses more than CASCADE_MIN_CATCH of the wrong answers it was shown does not clear, whatever
         the average says. Judged only on enough wrong answers to say. */
      const wrong = calls.filter((c, k) => c.ok && c.score > 0 && checks[k]?.structureOk);
      const caught = wrong.filter((c) => !(Number(c.check.p) >= best.threshold)).length;
      const catchRate = wrong.length ? caught / wrong.length : null;
      let verdict = verdictOf(best);
      if (verdict === 'cleared' && catchRate !== null && wrong.length >= 5 && catchRate < config.CASCADE_MIN_CATCH) verdict = 'review';
      return { best, verdict, catchRate, wrong: wrong.length };
    };
    const strict = judgedAs(false);
    const row = strategyRow(cand, { ...spec, threshold: strict.best.threshold }, strict.best, strict.verdict, {
      difference: label, rank: { checkCaught: strict.catchRate === null ? null : round8(strict.catchRate), checkWrong: strict.wrong },
    });
    if (serving) {
      const asServed = judgedAs(true);
      row.keep = { verdict: asServed.verdict, gap: round8(asServed.best.gap) };
    }
    await insertResult(row);
    return true;
  };

  /* A router of the older kind (one cheap model or the customer's own, picked by a small model of the call)
     serving this workload, re-checked exactly as it serves: its own weights and threshold on these calls.
     Worked out afresh, as it used to be, a re-check scored some other router than the one serving. No new
     one of this kind is made: routing by kind of request replaced it. */
  const frozenRouterFor = async (cand, st, spec) => {
    const picks = st.calls.map((c) => predict(spec, featuresOf(kept[c.i].body)));
    const readingAs = (lenient) => simulateRouter(st.calls.map((c, k) => ({ ok: c.ok, score: readingOf(c, lenient) ?? (kept[c.i].noise ?? noiseMean),
      cost: c.cost, latency: c.latency, ttft: c.ttft, p: picks[k], ref: refOfPair(kept[c.i]) })), { thresholds: [spec.threshold] })[0];
    // its row with every difference counted, like every other; as it serves, which alone decides whether it keeps serving (keepOf)
    const reading = readingAs(false);
    const row = strategyRow(cand, spec, reading, verdictOf(reading));
    const asServed = readingAs(true);
    row.keep = { verdict: verdictOf(asServed), gap: round8(asServed.gap) };
    await insertResult(row);
    return true;
  };

  /* The calls a router by kind of request learns from, as kinds.js reads them: each call's request, and
     each option's answer to it, scored, priced and timed. An answer that was not scored because its
     judgement never came back reads as the customer's model's own noise on that call, as it does for a
     cascade. With `unknown` given, an answer that says nothing about the setup (never asked, or asked while
     its provider was only busy) is that instead of a wrong one: a re-check leaves such calls out. */
  const MISSING = { ok: false, score: 1, cost: 0, latency: null, ttft: null };
  const routedCalls = (options, { unknown = MISSING, settled = false } = {}) => kept.map((p, i) => ({
    raw: featuresRaw(p.body),
    results: options.map((o) => {
      const c = o.st.calls.find((x) => x.i === i);
      if (!c) return unknown;
      if (unknown !== MISSING && c.transient) return unknown;
      // read as it serves (settled: the router serving now), a call whose every difference was left unsettled says nothing
      const s = readingOf(c, settled);
      if (s === null && c.scored && unknown !== MISSING) return unknown;
      return { ok: c.ok, score: s ?? (p.noise ?? noiseMean), cost: c.cost, latency: c.latency, ttft: c.ttft };
    }),
    ref: refOfPair(p),
  }));
  const routerOptions = () => {
    const feeCeiling = 1 / (1 + config.ROUTING_FEE_PCT / 100);
    const out = [];
    for (const r of results.filter((x) => x.verdict !== 'reference' && plainResult(x) && stats.has(x.model_id))) {
      if (['failed', 'slower'].includes(r.verdict)) continue;
      const { cand, st } = stats.get(r.model_id);
      // it answered every call: finished, or finished afterwards for a strategy
      if (st.runs < kept.length) continue;
      const ratio = st.refCost > 0 && st.candCost > 0 ? st.candCost / st.refCost : null;
      if (ratio === null || ratio >= feeCeiling) continue;
      out.push({ cand, st, ratio, key: keyOf(cand) });
    }
    return out.sort((a, b) => a.ratio - b.ratio).slice(0, config.ROUTER_OPTIONS_MAX);
  };
  const specOfRouter = (options, learned, reference) => {
    /* Only the setups its table gives a kind to, numbered afresh: one it never uses would be in its name,
       measured again at every re-check and paid for, for nothing. */
    const used = [...new Set(learned.table.filter((t) => t >= 0))].sort((a, b) => a - b);
    const renumber = new Map(used.map((j, i) => [j, i]));
    const table = learned.table.map((t) => (t < 0 ? -1 : renumber.get(t)));
    const kept = used.map((j) => options[j]);
    // the setup that answers most of the calls leads it, which is what the rest of the app calls serving
    const shares = kept.map((_, i) => table.reduce((a, t, k) => a + (t === i ? learned.sizes[k] : 0), 0));
    const lead = kept[shares.indexOf(Math.max(...shares))];
    // each setup served the way it was measured: an open-weights model from the providers that answered it (servedRecipe)
    const recipeOf = (o) => servedRecipe(o.cand, o.st) ?? null;
    return {
      lead,
      spec: {
        kind: 'router', version: ROUTER_VERSION,
        options: kept.map((o) => ({ model: o.cand.model, recipe: recipeOf(o), key: o.key })),
        cheap: { model: lead.cand.model, recipe: recipeOf(lead) },
        strong: { model: reference, recipe: null },
        centroids: learned.centroids, minSim: learned.minSim, idf: learned.idf, table,
        sizes: learned.sizes, silhouette: learned.silhouette,
      },
    };
  };
  /* The router by kind of request: over every setup that answered every call and costs less than the
     customer's own model. Kept only when its kinds matter (the calls it sends to cheaper setups had clearly
     fewer worse answers than those setups give at random, see crossFitRouter), it clears the bar on calls
     it did not learn from, costs no more than 95% of the customer's model, and saves at least
     ROUTER_MIN_EXTRA_SAVING more than the best single setup that cleared: a router that does no better
     than one model is one more moving part for nothing. */
  /* How many calls the second look will read, worked out as lookAgain does, so a router's table is chosen
     for the two looks it still has to pass: these calls, held out, and then that many it has never seen. */
  const secondLookSize = () => {
    const sampled = new Set(samples.map((x) => x.id));
    const from = pool.filter((c) => !sampled.has(c.id) && !seenBefore.has(c.id)).length;
    const least = callsToClear(floor, confirmZ);
    return Math.max(least, Math.min(from, Math.max(config.EVAL_CONFIRM_MIN, Math.ceil(config.EVAL_CONFIRM_MULTIPLE * callsToClear(floor)), samples.length)));
  };
  const kindsRouter = async () => {
    const options = routerOptions();
    if (!options.length || kept.length < Math.max(2 * config.ROUTER_KIND_MIN_CALLS, callsToClear(floor))) return false;
    const cf = crossFitRouter(routedCalls(options), options, {
      floorPct: floor, margin: config.ROUTER_KIND_MARGIN, shrink: config.ROUTER_KIND_SHRINK, kMax: config.ROUTER_KINDS_MAX,
      minSize: config.ROUTER_KIND_MIN_CALLS, minSilhouette: config.ROUTER_KINDS_MIN_SILHOUETTE, seed: 7,
      feePct: config.ROUTING_FEE_PCT, prior: config.ROUTER_KIND_PRIOR, sureShrink: config.ROUTER_KIND_PULL,
      looks: [{ n: kept.length }, { n: secondLookSize(), z: confirmZ ?? 1.6449 }],
    });
    if (!cf) return false;
    if (!(cf.heldOut.kindsZ >= config.ROUTER_KIND_LIFT_Z)) return false;
    const reading = { ...cf.heldOut };
    const v = verdictOf(reading);
    const singles = results.filter((r) => plainResult(r) && r.verdict === 'cleared' && r.cost_ratio !== null).map((r) => Number(r.cost_ratio));
    const bestSingle = singles.length ? Math.min(...singles) : null;
    if (v !== 'cleared' || reading.ratio === null || reading.ratio > 0.95) return false;
    if (bestSingle !== null && reading.ratio > bestSingle * (1 - config.ROUTER_MIN_EXTRA_SAVING)) return false;
    const { spec, lead } = specOfRouter(options, cf.spec, reference);
    /* The router serving now over these same setups was worked out already, exactly as it serves
       (frozenKindsRouter), under this same name: written again, the run failed on a result it already
       had, and was paid for again on every retry. What serves is only replaced by a router over other
       setups; one over the same setups that slipped is switched back, and learned afresh later. */
    if (results.some((r) => r.model_id === keyOfSpec(spec, reference))) return false;
    await insertResult(strategyRow(lead.cand, spec, reading, v, {
      difference: labelOf(spec, reference),
      rank: { kinds: cf.spec.sizes.length, silhouette: cf.spec.silhouette, toYours: round8(reading.escalated),
        kindsZ: round8(reading.kindsZ), worseKept: round8(reading.worseKept), worseAtRandom: round8(reading.worseAtRandom) },
    }));
    return true;
  };
  /* A router by kind of request serving now, re-checked exactly as it serves: its kinds and its table on
     these calls, with each of its setups answering them afresh (see servingParts). Never learned again
     here: a re-check that learned a new router scored something other than what serves.
     A call routed to a setup that could not answer it this time (never asked, or its provider only busy)
     is left out, the way a busy call never counts against a model on its own: counted as wrong, one busy
     setup switched a healthy router back. What is left is read as ever, so a router clearly worse on the
     calls that were answered is still found out; one that looks fine on too few of them is not said to
     clear ('insufficient', which switches nothing). A setup its provider refused is the same fact about
     the router as about a model on its own. Always written down, so a measurement can switch it back. */
  const frozenKindsRouter = async (spec) => {
    const options = spec.options.map((o) => {
      const k = o.key || partKey(o);
      const got = stats.get(k);
      return got ? { cand: got.cand, st: got.st, key: k } : { cand: { model: o.model, recipe: o.recipe ?? null }, st: { calls: [] }, key: k };
    });
    /* Read two ways: with every difference counted, which is what its row says and how it ranks against the
       rest; and as it serves, without the differences a reading left unsettled, which alone decides whether it
       keeps serving (keepOf). A call whose every difference was unsettled says nothing that second way. */
    const all = routedCalls(options, { unknown: null });
    const allAsServed = routedCalls(options, { unknown: null, settled: true });
    const routes = all.map((c) => routeOf(spec, c.raw).option);
    const knownOf = (cs) => cs.filter((c, i) => routes[i] < 0 || c.results[routes[i]] !== null);
    const known = knownOf(all);
    const knownAsServed = knownOf(allAsServed);
    const lead = options.find((o) => o.cand.model === spec.cheap?.model) || options[0];
    /* Refused on a call the router sends it: a refusal on a request of another kind says nothing about
       the ones it is sent, and failed a whole router for a request it would never have seen. The calls a
       refused setup did not get to afterwards are left out like any other it could not answer. */
    const refused = options.find((o, j) => o.st.stopped === 'refused'
      && o.st.calls.some((x) => !x.answered && !x.transient && routes[x.i] === j));
    // on too few of its calls, a router that looks fine is not said to clear: 'insufficient' switches nothing
    const judge = (calls) => {
      const reading = simulateRoutes(spec, calls);
      let verdict = verdictOf(reading);
      if (refused) verdict = 'failed';
      else if (calls.length < all.length * 0.9 && verdict === 'cleared') verdict = 'insufficient';
      return { reading, verdict };
    };
    const strict = judge(known);
    const asServed = judge(knownAsServed);
    const row = strategyRow(lead.cand, spec, strict.reading, strict.verdict, { difference: labelOf(spec, reference) });
    row.runs = known.length;
    row.keep = { verdict: asServed.verdict, gap: round8(asServed.reading.gap) };
    if (refused) {
      row.stopped = 'refused';
      row.error_text = refused.st.errorText ?? null;
    } else {
      // what could not be answered, and apart from it, what could not be judged: said as two things, which they are
      const unanswered = all.length - known.length;
      const unjudged = known.length - knownAsServed.length;
      const said = [unanswered ? `${unanswered} of ${all.length} calls could not be answered by the setup they were routed to` : null,
        unjudged ? `${unjudged} of ${all.length} could not be judged, because the reading of which answer serves better did not come back` : null]
        .filter(Boolean);
      if (said.length) row.error_text = said.join(', and ');
    }
    await insertResult(row);
    return true;
  };

  let strategyLeft = 0;
  /* The strategy serving this workload now is always worked out again, from its lead model's run
     (see leadKey), whatever that model did on its own: otherwise a cascade or router whose answers
     had slipped was never written down, and so never switched back. */
  if (!halt) {
    const cheaper = (r) => r.cost_month_usd !== null && (refMonthly === null || r.cost_month_usd < refMonthly);
    // one model, or the customer's own thinking less; never a strategy built on a strategy
    const plain = results.filter((r) => r.verdict !== 'reference' && stats.has(r.model_id) && plainResult(r));
    // answered every call, and could not manage alone
    const pool = plain.filter((r) => ['missed', 'review'].includes(r.verdict) && !r.stopped && cheaper(r));
    /* Dropped part way for its answers, but it could still save something with the calls it gets
       wrong sent on: its own price, plus the customer's model on the share it got wrong, has to
       leave room under the customer's price. Judged on the saving rather than on how far it
       missed, because a model dropped after a few calls has a rough reading of how often it is
       wrong, and a cheap model wrong one time in eight is exactly what a cascade is for. It is
       finished for a router too: a model wrong on one kind of request can be right on the others. */
    const roomLeft = (r) => (r.cost_ratio === null ? 0 : 1 - (Number(r.cost_ratio) + Math.min(1, Number(r.gap_pct) / 100)));
    const close = plain.filter((r) => r.stopped === 'bar' && cheaper(r) && roomLeft(r) >= 0.25)
      .sort((a, b) => a.cost_month_usd - b.cost_month_usd).slice(0, 2);
    const forced = leadKey && !servingKinds ? plain.find((r) => r.model_id === leadKey) : null;
    const worth = [...(forced ? [forced] : []),
      ...[...pool, ...close].filter((r) => r !== forced).sort((a, b) => a.cost_month_usd - b.cost_month_usd).slice(0, 3)];
    /* A router is only worked out on calls enough for one to clear at all: a perfect run needs
       callsToClear of them, and with fewer, finishing dropped models for a router was money for nothing. */
    const routing = config.ROUTER_V2 && kept.length >= Math.max(2 * config.ROUTER_KIND_MIN_CALLS, callsToClear(floor));
    if (worth.length && (jevUsable() || routing || forced)) {
      strategyLeft = worth.length * kept.length;
      remaining = () => strategyLeft + looksAhead;
      try {
        for (const r of worth) {
          if (halt) break;
          let { cand, st } = stats.get(r.model_id);
          if (st.runs < kept.length) {
            // finishes the calls it was dropped before, going on from where it stopped
            const more = await tryModel(cand, { noDrop: true, resume: st });
            answered.delete(keyOf(cand));
            // found unable to keep up only now: its row, written before, says so from here on
            if (more.stopped === 'busy') await failBusy(r.model_id);
            if (more.runs < kept.length || more.stopped) continue;
            st = more;
          }
          // the serving strategy's own kind for its lead model; a cascade for everything else
          const isServing = r === forced;
          // the cascade serving now is read as it serves; a cascade that could be switched to, with every difference
          if (jevUsable() && (!isServing || servingKind === 'cascade')) await cascadeFor(cand, st, { serving: isServing });
          if (!halt && isServing && servingKind === 'router') await frozenRouterFor(cand, st, servingArmNow.spec);
        }
      } catch (err) {
        await interrupt(`Something went wrong here while trying strategies: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
        throw err;
      }
      strategyLeft = 0;
    }
    try {
      if (!halt && servingKinds) await frozenKindsRouter(servingKinds);
      if (!halt && routing) await kindsRouter();
    } catch (err) {
      await interrupt(`Something went wrong here while working out a router: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
      throw err;
    }
  }
  if (halt === 'stopped') return await endStopped();
  if (halt === 'account') return await accountHalt();

  /* Which cleared models could be switched to at all: priced, and cheaper than the customer's own
     model on these very calls once the fee is added. A customer's model with no known price used to
     switch the "cheaper" check off, and a model ten times dearer was switched to. */
  const feeCeiling = 1 / (1 + config.ROUTING_FEE_PCT / 100);
  const priced = (r) => r.cost_month_usd !== null && refMonthly !== null && r.cost_month_usd < refMonthly
    && r.cost_ratio !== null && Number(r.cost_ratio) < feeCeiling;
  const clearedAll = results.filter((r) => r.verdict === 'cleared' && priced(r));
  const unpriced = results.filter((r) => r.verdict === 'cleared' && !priced(r));
  const cleared = [];
  for (const r of clearedAll) if (!await everReverted(workloadId, r.model_id)) cleared.push(r);

  /* In what order the setups that cleared are looked at again and switched to: the workload's routing
     priority (src/eval/confidence.js). Balanced, where nobody chose, is the biggest saving we can be
     sure of, and within a point of each other the faster; savings is the cheapest; cautious leaves out
     what we are not sure enough of. The order, and why, is kept with the run, so the page can say why
     the one switched to was chosen. */
  const ranked = rankCleared(cleared, { mode: routingMode, metric, cautiousChance: config.CAUTIOUS_MIN_CHANCE });
  /* What serves now is only ever replaced by something cheaper: a setup ranked above it on a slightly
     surer reading of one sample, and dearer, would switch a workload back and forth for nothing. */
  // read as it serves (keepOf): whether it still clears decides that only something cheaper takes its place
  const servingCleared = results.find((r) => r.model_id === servingNow && keepOf(r) === 'cleared' && priced(r)) || null;
  /* One that could not be judged this time (setups too busy to answer) still serves, and is held to the same
     rule: only something cheaper is looked at in its place. */
  const servingUnread = results.find((r) => r.model_id === servingNow && keepOf(r) === 'insufficient') || null;
  const holding = servingCleared || servingUnread;
  let order = holding
    ? ranked.order.filter((r) => r === servingCleared || Number(r.cost_month_usd) < Number(holding.cost_month_usd))
    : ranked.order;
  /* What serves and still clears keeps serving, even where a cautious priority would not switch to it
     afresh: that priority is about what to switch to. Left out of the order, it was reported as "nothing
     cleared your bar" while it went on serving. */
  if (servingCleared && !order.includes(servingCleared)) order = [...order, servingCleared];
  for (const [k, r] of ranked.order.entries()) {
    r.choice_rank = k + 1;
    await db.prepare('UPDATE eval_results SET choice_rank = ? WHERE id = ?').run(k + 1, r.id);
  }
  /* What a cautious workload leaves out, as not sure enough: never looked at again, never offered as the
     candidate, never tried on live calls. Marked "not reached", it was all three. */
  const leftOut = ranked.left.map((x) => x.row).filter((r) => r !== servingCleared);
  for (const r of leftOut) {
    r.confirm_verdict = 'left_out';
    await db.prepare(`UPDATE eval_results SET confirm_verdict = 'left_out' WHERE id = ?`).run(r.id);
  }
  const choiceOf = (r) => ({
    model: r.model_id, label: r.arm_json ? nameOfResult(r).label : r.model_id,
    saving: r.cost_ratio === null ? null : round8(Math.max(0, 1 - Number(r.cost_ratio) * (1 + config.ROUTING_FEE_PCT / 100))),
    chance: r.chance ?? null, safeSaving: r.safe_saving ?? null,
    p50: metric === 'ttft' ? (r.ttft_p50 ?? r.latency_p50 ?? null) : (r.latency_p50 ?? null), better: r.better_pct ?? null,
  });
  const choice = {
    mode: routingMode, metric, cautiousChance: config.CAUTIOUS_MIN_CHANCE,
    order: ranked.order.map(choiceOf), left: ranked.left.map((x) => ({ ...choiceOf(x.row), why: x.why })),
    servingKept: servingCleared ? servingCleared.model_id : null,
  };
  await db.prepare('UPDATE eval_runs SET routing_mode = ?, choice_json = ? WHERE id = ?').run(routingMode, JSON.stringify(choice), run.id);

  /* A second look before anything is switched. Up to ten models race and the first in line that cleared
     wins, which is ten chances to be lucky: in simulation, ten models each half as bad again as the bar
     allowed switched to a bad one nearly every time, and the certificate showed about half the true gap.
     So the first in line is measured again on calls it has never seen, held to the same rule and the
     speed rule, and only one that clears both times can be switched to; if it does not, the next in line
     is, up to EVAL_CONFIRM_TRIES of them. That brought false switches to about one in a thousand.
     A strategy (a checked cheap model, a router) has a second look of its own too, on the same calls. */
  let best = null;
  const confirmations = [];
  const sampled = new Set(samples.map((x) => x.id));
  const fresh = pool.filter((c) => !sampled.has(c.id));
  /* What serves the workload now is not looked at twice: its live calls are watched every hour, and a
     second look would pay again to learn what they already show. The ones in line before it are tried
     first, and the one serving ends the search when it is reached. */
  let tries = 0;
  try {
    for (const r of order) {
      if (halt) break;
      if (r.model_id === servingNow) { best = r; confirmations.push({ r, c: { verdict: 'cleared', runs: 0, serving: true } }); break; }
      /* One this run has since found cannot keep up, on another's look (a router's look asks each of its models), or one
         that sends calls to such a model, has failed: it is never looked at again, and never switched to, whatever order
         it was ranked in before any look. It takes none of the looks either. A strategy found out this way says so on its
         row: left as it was, it read as cleared and never reached, and live experiments went on trying it. */
      if (r.verdict !== 'cleared') continue;
      if (partsOfRow(r).some((k) => failedBusy.has(k))) { await failBusy(r.model_id); continue; }
      if (tries >= config.EVAL_CONFIRM_TRIES) continue;
      tries += 1;
      // the looks that could still come after this one, each reusing the customer's answers this one asks for
      looksAhead = Math.max(0, config.EVAL_CONFIRM_TRIES - tries) * lookSize;
      const c = plainResult(r) ? await confirmOn(r, fresh) : await confirmStrategyOn(r, fresh);
      confirmations.push({ r, c });
      if (c.verdict === 'cleared') { best = r; break; }
    }
  } catch (err) {
    await interrupt(`Something went wrong here while looking again: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
    throw err;
  }
  // no look comes after these
  looksAhead = 0;
  /* Every other result that cleared was never looked at twice: past the models a run looks at again,
     after one was confirmed, or after the run was cut short. It says so, and is never read as confirmed
     (see confirmed in src/eval/outcome.js). With nothing written, it sorted first, took "needs a second
     look" off its workload, and was what an approval with no model named switched to. */
  const reached = new Set(confirmations.map((x) => x.r.id));
  for (const r of results) {
    if (r.verdict !== 'cleared' || reached.has(r.id) || r.model_id === servingNow || r.confirm_verdict === 'left_out') continue;
    r.confirm_verdict = 'not_reached';
    await db.prepare(`UPDATE eval_results SET confirm_verdict = 'not_reached' WHERE id = ? AND confirm_verdict IS NULL`).run(r.id);
  }
  if (halt === 'stopped') return await endStopped();
  if (halt === 'account') return await accountHalt();

  await settle(`Measuring ${workload.slug}`);
  await keepSavings();
  const outcome = results.length ? 'compared' : 'no_balance';
  // a stop that arrived during that last settle wins: stopped, and nothing switched
  const why = halt === 'balance' ? 'balance ran out part way through'
    : halt === 'budget' || (overQuote && finished < want) ? `reached its limit of $${(Number(plan.atMostUsd) || capLimit).toFixed(2)}` : null;
  if (!await finish(outcome, why)) {
    return await endStopped();
  }
  await db.prepare('UPDATE eval_runs SET models_planned = ? WHERE id = ?').run(results.length, run.id);

  /* The reference is not a candidate, but every screen compares against what it costs and how
     fast it is, so it is recorded on the run alongside them. */
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd,
              verdict, gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at,
              latency_p50, latency_p90, ttft_p50, ttft_p90)
              VALUES (?, ?, ?, ?, 0, ?, 'reference', 100, 100, 100, 100, 0, ?, ?, ?, ?, ?)
              ON CONFLICT (run_id, model_id) DO UPDATE SET runs = excluded.runs,
                cost_month_usd = excluded.cost_month_usd, created_at = excluded.created_at`)
    .run(id('res'), run.id, reference, kept.length * 2, refMonthly, now(),
         refSpeed.latencyP50, refSpeed.latencyP90, refSpeed.ttftP50, refSpeed.ttftP90);

  /* A model already serving this workload that no longer holds up goes back to the customer's
     own model, whatever mode the workload is in. Only on what this measurement found or on a
     fact that makes it unusable, and only the model that was serving when the run started: one
     switched to while it ran is not undone on evidence about another.

     How long it stays out depends on what was found. Answers that no longer match are a lasting
     fact about the model, so that is for good. Everything else can change back: a provider that
     refused it, that was slower than the speed setting, that no longer keeps nothing, a price
     that went up, or needs of the workload's that moved. Those keep it out for a week, after
     which a measurement can find it again. A provider's uptime over the last day is not a
     reason at all on its own: that is one reading, and the live watch sees how it really does. */
  const serving = workload.routed_model;
  let switchedBack = false;
  /* Only "missed" switches back for good, and that verdict comes from the range of what serves on
     every call (see record): the range says the gap is past the review band. One that came close
     ("review") is not switched back: that is a sample straddling the bar, not a finding. */
  if (serving) {
    // the strategy serving it, by the name its result carries: a cascade's is its own row
    let mine = results.find((r) => r.model_id === servingNow);
    /* Never a router by kind of request: its setups answer the calls it sends them first, so its lead refused on
       a request of another kind is the usual place for a refusal, and says nothing about the router. With no
       reading of its own this time (a run cut short), the next measurement looks again. */
    if (!mine && servingKind && !servingKinds) {
      /* A strategy that could not be worked out again is judged by what its lead model did alone,
         where that says something about the strategy as well: a provider that refused it, or a model
         too slow on its own, which a check or a pick can only make slower. */
      const lead = results.find((r) => r.model_id === leadKey);
      if (lead && lead.verdict === 'failed') mine = lead;
      else if (lead && lead.verdict === 'slower') mine = { ...lead, stopped: null };
    }
    const ruled = plan.excluded.find((e) => e.model === serving);
    let why = null;
    let soft = true;
    // what serves is judged here as it serves (keepOf), never on differences a reading left unsettled
    if (mine && keepOf(mine) === 'missed') {
      why = `it no longer clears your bar: ${Number(keepGap(mine)).toFixed(1)}% against a ${floor.toFixed(1)}% bar`;
      /* For good, because answers that no longer match are a lasting fact about a model. Not so a router
         by kind of request: its setups are each measured on their own too, and what it may have lost is its
         table, when the kinds of request the workload gets have moved. Out for a while, and a later
         measurement can learn it afresh, and has to clear both looks again; after a few, for good. */
      soft = !!servingKinds && mine.model_id === servingNow;
    } else if (mine && keepOf(mine) === 'failed' && mine.stopped === 'refused') {
      why = `its provider refused it when it was re-checked${mine.error_text ? `, saying "${mine.error_text}"` : ''}`;
    } else if (mine && keepOf(mine) === 'slower' && !mine.stopped) {
      why = 'it is now slower than your speed setting allows';
    } else if (mine && ['cleared', 'review'].includes(keepOf(mine)) && refMonthly !== null
      && mine.cost_month_usd !== null && mine.cost_month_usd >= refMonthly) {
      why = `it now costs more than ${reference} on your calls`;
    } else if (!mine && ruled && ['private', 'retiring', 'features', 'thinking'].includes(ruled.step)) {
      why = `it ${ruled.reason}`;
    }
    if (why) {
      await revert(workload, {
        auto: true, soft, reason: `Measured again: ${why}. Switched back to ${reference}.`,
      });
      switchedBack = true;
    }
  }

  /* What cleared, was priced and was confirmed, and what we do about it. One switched back before is
     passed over rather than chosen and refused. */
  const dropped = results.filter((r) => r.stopped).length;
  if (unpriced.length) {
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `${unpriced.length === 1 ? shown(unpriced[0]) : `${unpriced.length} models`} cleared your bar on ${workload.slug}, but cannot be switched to`,
      detail: refMonthly === null
        ? `We could not price ${reference} on your calls, so nothing can be shown to be cheaper. Nothing was switched.`
        : 'Once our fee is added it would not cost less than your own model on your calls. Nothing was switched.',
      workloadId,
    });
  }
  // the model that serves it held up, and nothing cheaper did: nothing changes
  const stillServing = !!best && best.model_id === servingNow && !switchedBack;
  if (best && best.model_id === servingNow && switchedBack) best = null;
  /* What this test chose, written down as it was decided: the first in its order to pass its second look,
     or what serves, kept; nothing when neither. The workload's history names it from here rather than
     working it out again from the ranks, which could not tell one switched back since from one kept. */
  choice.chosen = best ? best.model_id : null;
  choice.chosenKept = stillServing;
  await db.prepare('UPDATE eval_runs SET choice_json = ? WHERE id = ?').run(JSON.stringify(choice), run.id);
  /* The first looked at again that did not hold up: never what serves, and never one that could not keep up, which has
     failed for good, is never looked at again, and is no candidate a person could approve. Taken as it was, such a one was
     reported as "cleared once and needs a second look", with a way to approve it that could not work. */
  const second = !best ? confirmations.find((x) => !x.c.serving && x.c.verdict !== 'busy') || null : null;
  // one that cleared, and that the run ended before it could look at again: never read as confirmed
  // one in the order the run looked at, that is: never one dearer than what serves, which was not in line at all
  const unlooked = !best && !second ? cleared.find((r) => r.model_id !== servingNow && r.confirm_verdict === 'not_reached' && order.includes(r)) : null;
  // what serves it came close to the bar on its re-check, and nothing cheaper cleared
  const servingRow = serving && !switchedBack ? results.find((r) => r.model_id === servingNow) : null;
  const servingClose = !best && !second && !unlooked && keepOf(servingRow) === 'review';
  // what serves could not be judged this time: some of the calls routed to its setups went unanswered
  const servingUnjudged = !best && !second && !unlooked && !servingClose && keepOf(servingRow) === 'insufficient' ? servingRow : null;
  // what cleared was all left out by a cautious priority, as not sure enough to switch to
  const leftOnly = !best && !second && !unlooked && !servingClose && !servingUnjudged && leftOut.length > 0 ? leftOut : null;
  /* How this workload switches: on its own ('auto'), when a person approves ('ask'), or never
     ('off': measured, never switched on its own and never asked about, though a person may still
     switch it by hand, and a switch back for safety still happens). Anything else is read as asking
     first, never as switching on its own. */
  const mode = ['auto', 'ask', 'off'].includes(workload.optimize_mode) ? workload.optimize_mode : 'ask';
  const nextStep = mode === 'off'
    ? 'This workload is set never to switch, and the next measurement looks again.'
    : 'Approve it on the workload page, or the next measurement looks again.';
  /* The status the run ends with, the way restingStatus reads it again later: a workload that still
     has a switch says so, whatever this run found about cheaper models, rather than "Ready to
     optimize" over a page that shows the switch serving. */
  const settleStatus = async (status, note) => db.prepare(
    `UPDATE workloads SET status = CASE WHEN routed_model IS NOT NULL THEN 'promoted' ELSE ?::text END,
            status_note = CASE WHEN routed_model IS NOT NULL THEN NULL ELSE ?::text END, updated_at = ?
      WHERE id = ?`).run(status, note, now(), workloadId);

  if (stillServing) {
    const failedLooks = confirmations.filter((x) => !x.c.serving && x.c.verdict !== 'cleared');
    await db.prepare(`UPDATE workloads SET status = 'promoted', status_note = NULL, updated_at = ? WHERE id = ? AND routed_model IS NOT NULL`)
      .run(now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${shown(best)} still clears your bar on ${workload.slug}`,
      detail: `${Number(keepGap(best)).toFixed(2)}% against a ${floor.toFixed(2)}% bar, on calls it had not answered before`
        + (failedLooks.length ? `. ${failedLooks.length === 1 ? failedLooks[0].r.model_id : `${failedLooks.length} cheaper models`} cleared once and did not hold up on a second look, so nothing changed` : ''),
      workloadId,
    });
  } else if (best) {
    const saving = refMonthly === null ? null : round8(refMonthly - best.cost_month_usd);
    // calls that reach us as copies cannot be switched by us, so for them this is advice
    const traffic = await trafficOf(workload);
    await settleStatus('certified', null);
    const conf = confirmations.find((x) => x.r === best)?.c;
    await addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${shown(best)} cleared your bar on ${workload.slug}`,
      detail: `${best.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar`
        + (conf?.runs ? `, and again on ${conf.runs} calls it had never seen (${conf.gap.toFixed(2)}%, at most ${conf.hi.toFixed(2)}%, against a ${conf.floor.toFixed(2)}% bar read from both)` : '')
        + (saving ? `, about $${saving.toFixed(2)} a month less` : '')
        + (reusedCount - recordedRefs > 0 ? `. ${reusedCount - recordedRefs} answers were reused from earlier measurements` : '')
        + (recordedRefs ? `. ${recordedRefs} of your own model's answers were read from your calls rather than paid for again` : '')
        + (traffic.carries ? '' : '. Your calls reach us as copies, so a switch starts with the first call that comes through Understudy')
        + (mode === 'off' ? '. This workload is set never to switch, so nothing was switched' : ''),
      workloadId,
    });
    if (mode === 'ask') {
      // waiting for somebody's say: worth an email, once for this measurement; never for a workload set never to switch
      await notify(workload.workspace_id, 'waiting', `${workloadId}:${run.id}`, {
        title: `${shown(best)} cleared your bar on ${workload.slug}`,
        lines: [
          `Its answers to your own calls were as good as ${reference}'s, checked twice`
            + (saving ? `, and would cost about $${saving.toFixed(2)} a month less.` : '.'),
          'Nothing changes until you approve it on the workload page.',
        ],
        path: `/workloads/${workloadId}`, linkText: 'Review and approve',
      });
    }
    if (mode === 'auto') {
      const recipe = best.recipe_json ? JSON.parse(best.recipe_json) : null;
      await promote(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId), best.model_id, {
        runId: run.id, reason: 'cleared your bar', auto: true, recipe,
      });
    }
  } else if (servingUnjudged) {
    /* Said as that, and never as "nothing cleared your bar" over a setup that goes on serving: it was not
       found wanting, it could not be looked at in full. */
    await settleStatus('certified', null);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `${shown(servingUnjudged)} could not be checked in full on ${workload.slug}`,
      detail: `${servingUnjudged.error_text ? `${servingUnjudged.error_text[0].toUpperCase()}${servingUnjudged.error_text.slice(1)}` : 'Too few of its answers could be judged this time'}, `
        + 'so it was not judged either way. It keeps serving, its live calls are still watched, and the next measurement looks again.',
      workloadId,
    });
  } else if (leftOnly) {
    /* Something cleared, and this workload's priority, cautious, would not switch to it: said as that. It
       used to read "the measurement ended before it could look at it again", and offered it as the candidate. */
    const r = [...leftOnly].sort((a, b) => (Number(b.chance) || 0) - (Number(a.chance) || 0))[0];
    await settleStatus('no_match', 'A candidate cleared, but not surely enough for a cautious workload');
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `${shown(r)} cleared your bar on ${workload.slug}, but not surely enough for a cautious workload`,
      detail: `${r.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar. We are ${r.chance === null || r.chance === undefined ? 'not'
        : `${(Math.floor(Number(r.chance) * 1000) / 10).toFixed(1)}%`} sure it keeps your bar, and this workload's routing priority, Cautious, `
        + `only switches at ${Math.round(config.CAUTIOUS_MIN_CHANCE * 100)}% or more. Nothing was switched. The next measurement looks again, `
        + 'and choosing Balanced on the workload page lets it be looked at again then.',
      workloadId,
    });
  } else if (second || unlooked) {
    /* It cleared once and did not hold up on fresh calls, there were not enough fresh calls to look
       again, or the run ended before it could look. Nothing is switched on one look; a person decides,
       or the next measurement does. */
    const r = second ? second.r : unlooked;
    const cut = halt === 'balance' ? 'your balance ran out' : `it reached its limit of $${(Number(plan.atMostUsd) || capLimit).toFixed(2)}`;
    const why = unlooked ? `the measurement ended before it could look at it again on calls it had never seen (${cut})`
      : second.c.note
        || `on ${second.c.runs} calls it had never seen it differed ${second.c.gap.toFixed(2)}% of the time, and could be as high as ${second.c.hi.toFixed(2)}% against a ${second.c.floor.toFixed(2)}% bar`;
    await settleStatus('certified', 'A candidate cleared once and needs a second look');
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `${shown(r)} cleared your bar on ${workload.slug} once`,
      detail: `${r.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar, but ${why}. Nothing was switched. ${nextStep}`,
      workloadId,
    });
  } else {
    const anyReview = results.some((r) => r.verdict === 'review');
    // matched and too slow, which only a model that answered every call can be said to have done
    const anySlower = results.some((r) => r.verdict === 'slower' && !r.stopped);
    await settleStatus(anyReview ? 'certified' : 'no_match',
      anyReview ? 'A candidate is close and needs a look'
        : anySlower ? 'A model matched, but is slower than yours' : 'Nothing cleared your bar yet');
    await addActivity(workload.workspace_id, servingClose ? {
      kind: 'floor', title: `${servingNow} came close to your bar on ${workload.slug}`,
      detail: `${servingRow.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar on calls it answered afresh, which is too close `
        + 'to call either way, so it keeps serving. Its live calls are still watched, and the next measurement looks again.',
      workloadId,
    } : {
      kind: 'floor', title: `Nothing cleared your bar on ${workload.slug}`,
      detail: `${results.length} models tried against a ${floor.toFixed(2)}% bar`
        + (dropped ? `, ${dropped} of them stopped early once they could not win` : ''),
      workloadId,
    });
  }
  /* What cleared or came close, and costs less than the customer's own model, is kept as a runner-up
     live experiments can try; what this measurement no longer vouches for is set aside. */
  await markTrying(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId),
    { runId: run.id, results, refMonthly, floor });
  /* The next measurement: the workspace's rhythm when this one changed something or somebody asked for
     it, further out when it only found what the last one did. */
  await scheduleNext(workloadId, {
    changed: !automatic || switchedBack || !!second || !!unlooked || servingClose || !!servingUnjudged || !!leftOnly || (!!best && !stillServing),
  });
  /* A measurement on too few calls for its own bar, as a person's Measure now on a new workload can be, could not
     have switched anything, even to a model that matched every answer. Booked a whole rhythm out like one that
     could, the measurement that can was a month away however soon its calls came. It waits for them instead
     (waitForCalls), so the call that brings them starts it, with the rhythm kept as the fallback. Never in a
     workspace that measures only when asked, and never for a bar no sample could clear. */
  const need = callsToClear(floor);
  if (kept.length < need && need <= config.EVAL_SAMPLE_MAX && (await cadenceOf(workload.workspace_id)) > 0) {
    await waitForCalls(workloadId, barNeed(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId)).calls);
  }
  return { ok: true, runId: run.id, floor, results: results.length, partial: halt === 'balance', reused: reusedCount };
}

/* Whether anything is still running a measurement.
 *
 * A live run writes a heartbeat just before every call it sends, so one that has gone quiet
 * for longer than the slowest single call could take has nothing running it: the process that
 * was went away, usually in a deploy or a restart.
 *
 * A run started by the code before this has no heartbeat at all, and during a deploy the old
 * process may still be running it while this one boots. Such a run is only judged once this
 * process has been up longer than the same window, by which time the old one is certainly
 * gone; judged earlier, a run still being worked on could be closed from under it. */
export function isAbandoned(run, at = now()) {
  const stale = config.EVAL_STALE_MIN * 60000;
  if (run.heartbeat_at == null) {
    return process.uptime() * 1000 > stale && at - (run.started_at ?? run.created_at) > stale;
  }
  return at - run.heartbeat_at > stale;
}

/* Every finished run says what it found. The migration filled this in for runs before it, but
   during a deploy the old process can still finish one afterwards, without the word; read as
   "compared", a run that ran out of balance would then stand in for the last real measurement.
   Run at boot and hourly, and it only ever touches rows that have no outcome yet. */
export async function settleOutcomes() {
  return (await db.prepare(`UPDATE eval_runs SET outcome = ${OUTCOME_CASE()}
    WHERE outcome IS NULL AND status IN ('done', 'failed', 'stopped')`).run()).changes;
}

/* What a workload's status should say while nothing is measuring it: what the last measurement
 * that found anything found. A run that ended without finding anything, because it was
 * stopped, interrupted or ran out of balance, changes nothing, so stopping a measurement can
 * never make a workload forget a candidate an earlier one found. The same reading the end of a
 * finished run makes. */
export async function restingStatus(workloadId) {
  const w = await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(workloadId);
  const routed = w?.routed_model ?? null;
  if (routed) return { status: 'promoted', note: null, routed };
  const last = await db.prepare(
    `SELECT id, ${OUTCOME_OF()} AS outcome FROM eval_runs WHERE workload_id = ?
        AND status = 'done' AND ${OUTCOME_OF()} IN ('compared', 'unmeasurable', 'refused')
      ORDER BY created_at DESC LIMIT 1`).get(workloadId);
  if (!last) return { status: 'new', note: null, routed };
  if (last.outcome === 'unmeasurable') return { status: 'no_match', note: 'We could not measure this workload', routed };
  if (last.outcome === 'refused') return { status: 'no_match', note: 'Your own model could not answer these calls', routed };
  const results = await db.prepare(
    `SELECT verdict, cost_month_usd, stopped, cost_ratio, confirm_verdict, choice_rank FROM eval_results WHERE run_id = ?`).all(last.id);
  // the run's own rule, so a status read again always says what the run said at its end
  const ready = cheaperCleared(results);
  if (ready.length) {
    return { status: 'certified', note: confirmed(ready[0]) ? null : 'A candidate cleared once and needs a second look', routed };
  }
  // cleared, and left out by a cautious priority as not sure enough: what the run itself said at its end
  if (results.some((r) => r.verdict === 'cleared' && r.confirm_verdict === 'left_out')) {
    return { status: 'no_match', note: 'A candidate cleared, but not surely enough for a cautious workload', routed };
  }
  if (results.some((r) => r.verdict === 'review')) {
    return { status: 'certified', note: 'A candidate is close and needs a look', routed };
  }
  if (results.some((r) => r.verdict === 'slower' && !r.stopped)) {
    return { status: 'no_match', note: 'A model matched, but is slower than yours', routed };
  }
  return { status: 'no_match', note: 'Nothing cleared your bar yet', routed };
}

/* Put a workload back to its resting status, unless it is about to be measured anyway: another
   run of it is going, or one is waiting in the queue. A claimed job does not count, because the
   one asking is usually that very job, and an abandoned run's job stays claimed for ever. */
export async function rest(workloadId) {
  const readAt = now();
  const { status, note, routed } = await restingStatus(workloadId);
  /* The check and the write are one statement, and the write only lands if nothing it was read
     from has moved since: no run is going or waiting, none has finished since the reading, and
     the model serving it is the one it was read with. As separate steps, a run starting in
     between had its "Measuring" overwritten, and one finishing in between, or a switch, had its
     ending replaced by the older reading. */
  const r = await db.prepare(
    `UPDATE workloads SET status = ?, status_note = ?, updated_at = ?
      WHERE id = ? AND routed_model IS NOT DISTINCT FROM ?
        AND NOT EXISTS (SELECT 1 FROM eval_runs WHERE workload_id = ?
                          AND (status = 'running' OR COALESCE(finished_at, 0) > ?))
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'eval_run' AND status = 'queued'
                          AND (payload::jsonb ->> 'workloadId') = ?)`)
    .run(status, note, now(), workloadId, routed, workloadId, readAt, workloadId);
  return r.changes > 0;
}

/* Close a run that nothing is running any more: stopped when somebody asked for that, and
   interrupted otherwise. Nothing is switched and nothing more is charged. What it spent up to
   its last settle is already on the ledger; the calls after that were never charged, which
   leaves that difference with us rather than with the customer. The next measurement nobody asks
   for is put off the way a run's own ending puts it off (see deferAfterStop and deferAfterFailure),
   so the hourly pass does not start the workload again straight away. `release: false` is for the
   job that is itself closing its own earlier run, which it still holds. */
async function closeRun(run, how, { release = true } = {}) {
  const closed = await db.prepare(
    `UPDATE eval_runs SET status = ?, outcome = ?, finished_at = ?, phase = NULL,
            error = COALESCE(error, ?) WHERE id = ? AND status = 'running' RETURNING id`)
    .run(how === 'stopped' ? 'stopped' : 'failed', how, now(),
         how === 'stopped' ? null : 'interrupted', run.id);
  if (!closed.rows.length) return false;
  // the money it set aside, which nothing will charge against now
  if (run.hold_id) await releaseHold(run.hold_id).catch(() => {});
  if (how === 'stopped') await deferAfterStop(run.workload_id);
  else await deferAfterFailure(run.workload_id);
  /* and let go of the job that started it. Left claimed, the job still counted as open, so
     Measure now was answered with it and started nothing, and a later boot revived it and ran
     a measurement nobody had asked for then. */
  if (run.job_id && release) {
    /* Unless another run holds it now. A restart puts a dead run's job back in the queue, and a
       new run takes it under the same id; releasing it from under that run would leave its
       ending unwritten and its retry skipped. */
    await db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'claimed'
                AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id AND r.status = 'running')`)
      .run(how === 'stopped' ? 'stopped by you' : 'interrupted', run.job_id);
  }
  await rest(run.workload_id);
  const slug = (await db.prepare('SELECT slug FROM workloads WHERE id = ?').get(run.workload_id))?.slug
    ?? 'a workload';
  await addActivity(run.workspace_id, {
    kind: 'floor',
    title: how === 'stopped' ? `Measuring ${slug} stopped` : `Measuring ${slug} was interrupted`,
    detail: how === 'stopped'
      ? `Stopped at ${run.steps_done} of ${run.steps_total} model calls, as you asked. You were charged only `
        + 'for the calls it made, and nothing was switched.'
      : 'It stopped moving part way through, usually because the service restarted. Nothing was '
        + 'switched, and it can be measured again.',
    workloadId: run.workload_id,
  });
  return true;
}

/** Close every measurement nothing is running any more, for one workload or for all of them. */
export async function closeAbandoned(workloadId = null) {
  const rows = workloadId
    ? await db.prepare(`SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'running'`).all(workloadId)
    : await db.prepare(`SELECT * FROM eval_runs WHERE status = 'running'`).all();
  let closed = 0;
  for (const r of rows) {
    if (isAbandoned(r) && await closeRun(r, r.stop_requested_at ? 'stopped' : 'interrupted')) closed += 1;
  }
  /* A job can be left claimed with no run at all: its process died between picking it up and
     starting. Claimed for longer than any run goes quiet, with no running run of its own, it is
     let go too, for the same reason a closed run's job is. */
  const since = now() - config.EVAL_STALE_MIN * 60000;
  await db.prepare(
    `UPDATE jobs SET status = 'failed', error = 'interrupted: nothing was running it'
      WHERE kind = 'eval_run' AND status = 'claimed' AND claimed_at < ?
        ${workloadId ? `AND (payload::jsonb ->> 'workloadId') = ?` : ''}
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id AND r.status = 'running')`)
    .run(...(workloadId ? [since, workloadId] : [since]));
  return closed;
}

/* Stop measuring a workload, whatever state that is in.
 *
 * One waiting in the queue is taken out of it. One running is asked to stop, and does at its
 * next step, once the call in flight has come back and been counted, which is usually a matter
 * of seconds. One that nothing is running any more is closed here and now, because nothing else
 * ever would: it would sit on the page as a bar that never moves and keep Measure now from
 * starting another. Its job leaves the queue as well, or the next restart would put it back and
 * start measuring again, which is the one thing somebody pressing Stop has said they do not
 * want. Answers with what happened: stopping, stopped, cancelled, or idle for nothing at all. */
export async function stopMeasuring(workload, { actorUserId = null } = {}) {
  /* Only the jobs no run belongs to yet: waiting in the queue, or picked up a moment ago and not
     started. Those really are stopped before they start. A job whose run exists is that run's,
     and the run is stopped through its own row below; cancelling it too made a stop in a run's
     last moments, after it had finished and while it was tidying up, answer "stopped before it
     started, so nothing was spent" about a measurement that had spent money and may have been
     switching a model. */
  const cancelled = (await db.prepare(
    `UPDATE jobs SET status = 'cancelled', error = 'stopped by you'
      WHERE kind = 'eval_run' AND status IN ('queued', 'claimed')
        AND (payload::jsonb ->> 'workloadId') = ?
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id)`).run(workload.id)).changes;
  /* A measurement taken out of the queue was stopped by a person as surely as a running one: the
     next one nobody asks for waits a whole rhythm. Otherwise a new workload's first measurement,
     booked an hour ahead, was started again by the hourly pass as soon as that hour was up. */
  if (cancelled) await deferAfterStop(workload.id);
  /* Every run of it, not only the newest: one asked for and one on schedule can be running at
     once, and stopping the workload means stopping both. */
  const runs = await db.prepare(
    `SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'running'`).all(workload.id);
  if (!runs.length) {
    await rest(workload.id);
    /* Nothing running. A measurement that was waiting and has been taken out of the queue was
       stopped before it started, whatever finished earlier. Only with nothing cancelled does a
       run that finished a moment ago mean the stop came too late. */
    if (cancelled) return { ok: true, state: 'cancelled' };
    const recent = await db.prepare(
      `SELECT status FROM eval_runs WHERE workload_id = ? AND finished_at > ?
        ORDER BY created_at DESC LIMIT 1`).get(workload.id, now() - 60000);
    if (recent?.status === 'done') return { ok: true, state: 'finished' };
    return { ok: true, state: 'idle' };
  }
  let live = 0;
  for (const run of runs) {
    await db.prepare(`UPDATE eval_runs SET stop_requested_at = COALESCE(stop_requested_at, ?),
                stopped_by = COALESCE(stopped_by, ?) WHERE id = ?`).run(now(), actorUserId, run.id);
    if (!(isAbandoned(run) && await closeRun(run, 'stopped'))) live += 1;
  }
  return { ok: true, state: live ? 'stopping' : 'stopped' };
}

/* A structured answer whose deciding fields match and whose written fields differ in wording: the
   written fields are read for meaning, the way free text is. With nobody able to read them, the call
   counts as the same, because every field that decides something matched. */
async function proseScore(body, x, y, shape, scope, { subject = 'a' } = {}) {
  const c = structuredCompare(x.value, y.value, shape);
  if (c.decision) return { score: 1, cost: 0 };
  if (!c.prose.length) return { score: 0, cost: 0 };
  /* `subject` is the side being judged: 'a' (x) when x is a candidate's answer held against the
     customer's, 'b' (y) when the customer's model is held against itself for the bar. A difference only
     in wording or in what is included is forgiven when that side is at least as good (see judgeBetter). */
  const j = await judgeBarPair(askOf(body), proseText(c.prose, 'a'), proseText(c.prose, 'b'), { scope, subject, bar: subject === 'b' });
  /* A judgement that did not come back is no reading at all. It used to count as "the same", which is
     the direction that lets a candidate through. */
  if (j.transient || !j.judgedBy) return { score: null, cost: j.cost || 0, judgedBy: null, transient: true };
  return { score: j.score, cost: j.cost || 0, judgedBy: j.judgedBy, better: j.detail?.better ? 1 : 0, unsettled: !!j.unsettled };
}

/* The judge on pairs whose answer is known (see where it is called). An answer against itself with
   only its spacing changed must read the same; one call's answer held against a different call's
   request must read different. Only calls whose requests differ are paired, because a workload that
   sends the same request again and again (a poem about rain) has interchangeable answers by design. */
async function plantChecks(kept, scope, addJudge) {
  const out = { errors: 0, same: 0, different: 0, cases: [] };
  const texts = kept.filter((p) => p.a?.ok && typeof p.a.value === 'string' && p.a.value.trim().length > 20);
  for (const p of texts.slice(0, 2)) {
    const t = p.a.value;
    const variant = t.replace(/\s+/, '  ');
    if (variant.trim() === t.trim()) continue;
    const j = await judgeBarPair(askOf(p.body), t, variant, { scope, bar: true });
    addJudge(j.cost);
    if (j.transient || !j.judgedBy) continue;
    out.same += 1;
    if (j.score !== 0) { out.errors += 1; out.cases.push('an answer with only its spacing changed read as different'); }
  }
  const lastAsk = (p) => String(askOf(p.body)).split('\n').pop().trim().toLowerCase();
  for (let k = 0; k + 1 < texts.length && out.different < 2; k += 1) {
    const p = texts[k];
    const q = texts.slice(k + 1).find((x) => lastAsk(x) !== lastAsk(p)
      && x.a.value.trim().toLowerCase() !== p.a.value.trim().toLowerCase());
    if (!q) continue;
    const j = await judgeBarPair(askOf(p.body), p.a.value, q.a.value, { scope, bar: true });
    addJudge(j.cost);
    if (j.transient || !j.judgedBy) continue;
    out.different += 1;
    if (j.score !== 1) { out.errors += 1; out.cases.push("another call's answer read as the same"); }
  }
  return out;
}

/* Answers planted as clearly worse, or not, built from the customer's model's own answers to sampled calls, so they
   are about this workload (see chooseJudge). At most two of each:
   - its spacing changed, which is NOT worse, so a judge that leans against whichever answer it reads second is caught;
   - cut to its first third, which is worse;
   - another call's answer, to a request that asked something else, which is worse;
   - made to break a requirement of the workload's own instruction (repeated past its limit, stripped of what it must
     include, out of the shape it must have: see breakOne), which is worse;
   - put into another language, German or, where it is not English, English, which is worse, since the person asked
     in the language the real answer is in. Only prose is translated: code, JSON and figures read much the same in
     any language, and a structured answer never is. */
// what the person wrote in a request, its instruction left out, since every request of a workload shares that
const userText = (body) => (Array.isArray(body?.messages) ? body.messages : []).filter((m) => m?.role === 'user')
  .map((m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ') : '')).join('\n');
// how much two requests share: the words they have in common, of all the words either has
export const sharedAsk = (a, b) => {
  const of = (t) => new Set(String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const x = of(a);
  const y = of(b);
  if (!x.size || !y.size) return 1;
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return n / (x.size + y.size - n);
};
const sharedWords = (a, b) => {
  const of = (t) => new Set(String(t).toLowerCase().match(/\p{L}{4,}/gu) || []);
  const x = of(a);
  const y = of(b);
  if (!x.size) return 1;
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return n / x.size;
};
async function plantedFor(kept, { checklist = [], shape, addJudge }) {
  const pool = kept.filter((p) => p.a?.ok && asText(p.a.value).trim().length > 20);
  const out = [];
  for (const p of pool.slice(0, 2)) {
    const t = asText(p.a.value);
    const variant = t.replace(/\s+/, '  ');
    if (variant.trim() !== t.trim()) out.push({ p, answer: variant, reference: t, expect: 0, kind: 'spacing' });
  }
  let cuts = 0;
  for (const p of pool) {
    if (cuts >= 2) break;
    const t = asText(p.a.value).trim();
    const words = t.split(/\s+/);
    const cut = words.length >= 30 ? words.slice(0, Math.ceil(words.length / 3)).join(' ')
      : t.length >= 120 ? t.slice(0, Math.ceil(t.length / 3)) : null;
    if (!cut) continue;
    out.push({ p, answer: cut, reference: t, expect: 1, kind: 'cut' });
    cuts += 1;
  }
  /* Only for a request that asked something else: two that share most of their words ("a poem about the sea, #3" and
     "#4") ask the same thing, and the other one's answer is as good an answer, so a judge saying so is right. */
  const sameAnswer = (x, y) => asText(x.a.value).trim().toLowerCase() === asText(y.a.value).trim().toLowerCase();
  const askedElse = (x, y) => sharedAsk(userText(x.body), userText(y.body)) < 0.5;
  let others = 0;
  for (let k = 0; k + 1 < pool.length && others < 2; k += 1) {
    const p = pool[k];
    const q = pool.slice(k + 1).find((x) => askedElse(x, p) && !sameAnswer(x, p));
    if (!q) continue;
    out.push({ p, answer: asText(q.a.value), reference: asText(p.a.value), expect: 1, kind: 'another request' });
    others += 1;
  }
  if (shape !== 'free_text') return out;
  let broken = 0;
  for (const p of pool) {
    if (broken >= 2) break;
    const b = breakOne(checklist, p.a.value);
    if (!b) continue;
    out.push({ p, answer: b.text, reference: p.a.value, expect: 1, kind: 'ignored instruction', note: b.item.say });
    broken += 1;
  }
  let langs = 0;
  let tries = 0;
  for (const p of pool) {
    if (langs >= 2 || tries >= 3) break;
    const t = p.a.value;
    if (t.trim().split(/\s+/).length < 8 || t.includes('```') || /^\s*[[{<]/.test(t)) continue;
    tries += 1;
    const tr = await translated(t);
    addJudge(tr.cost);
    // a translation that kept most of the words is not in another language
    if (!tr.text || sharedWords(t, tr.text) > 0.5) continue;
    out.push({ p, answer: tr.text, reference: t, expect: 1, kind: 'wrong language', note: tr.to });
    langs += 1;
  }
  return out;
}

const PLANTED_WORDS = {
  spacing: () => 'an answer with only its spacing changed read as worse',
  cut: () => 'an answer cut to its first third read as at least as good',
  'another request': () => "another request's answer read as at least as good",
  'ignored instruction': (x) => `an answer that ignores the instruction (${String(x.note).toLowerCase()}) read as at least as good`,
  'wrong language': (x) => `the answer put into ${x.note} read as at least as good`,
};

/* One judge on the planted answers: how many it read, and which it got wrong, in words. */
async function readPlanted(planted, { scope, addJudge, prefer }) {
  const out = { judge: prefer, read: 0, errors: 0, same: 0, different: 0, cases: [] };
  await inParallel(planted, 4, async (x) => {
    const j = await judgeQuality(askOf(x.p.body), x.answer, x.reference, { scope, prefer });
    addJudge(j.cost);
    if (j.transient || j.score === null || j.score === undefined) return;
    out.read += 1;
    if (x.expect === 0) out.same += 1; else out.different += 1;
    if (j.score !== x.expect) { out.errors += 1; out.cases.push(PLANTED_WORDS[x.kind](x)); }
  });
  return out;
}

/* Which judge reads "at least as good" on this workload: the one that gets the planted answers right (plantedFor).
   Jev is tried first, being faster and cheaper; where it misses one, or answered on too few to say, the language
   model reads the same answers, and whichever missed fewer reads the run (Jev where they missed as many and read
   as many). Where the one chosen missed any, nothing it settles is switched to on its word alone (unsure). Answers
   { prefer: null for Jev with the language model behind it, or 'llm', unsure, check: what the page and the record
   say of it }. */
async function chooseJudge(kept, { scope, addJudge, checklist, shape }) {
  const planted = await plantedFor(kept, { checklist, shape, addJudge });
  const kinds = [...new Set(planted.map((x) => x.kind))];
  const record = (best, tried, extra = {}) => ({
    errors: best?.errors ?? 0, same: best?.same ?? 0, different: best?.different ?? 0, cases: best?.cases ?? [],
    planted: planted.length, kinds, judge: best ? (best.judge === 'llm' ? 'llm' : 'jev') : null,
    tried: tried.map((t) => ({ judge: t.judge === 'llm' ? 'llm' : 'jev', read: t.read, errors: t.errors })), ...extra,
  });
  if (!planted.length) return { prefer: null, unsure: false, check: record(null, []) };
  const tried = [];
  if (jevUsable()) tried.push(await readPlanted(planted, { scope, addJudge, prefer: 'jev' }));
  const jevRight = tried.length && tried[0].errors === 0 && tried[0].read * 2 >= planted.length;
  if (!jevRight && config.EVAL_JUDGE_MODEL) tried.push(await readPlanted(planted, { scope, addJudge, prefer: 'llm' }));
  const usable = tried.filter((t) => t.read > 0);
  // no judge answered on any of them: nobody's word was tested, so nothing is switched to on it alone
  if (!usable.length) return { prefer: null, unsure: true, check: record(null, tried, { cases: ['no judge answered on the planted answers'] }) };
  const best = usable.reduce((a, b) => (b.errors < a.errors || (b.errors === a.errors && b.read > a.read) ? b : a));
  return { prefer: best.judge === 'llm' ? 'llm' : null, unsure: best.errors > 0, check: record(best, tried) };
}
