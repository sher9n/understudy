import { db, id, now, round8 } from '../db/index.js';
import config, { canRoute } from '../config.js';
import { priceCall } from '../openrouter.js';
import { addActivity } from '../traffic.js';
import { gateEval, chargeEval } from '../billing.js';
import { planFor } from './plan.js';
import { judgeBarPair, judgeCandidate, judgeQuality, canJudge } from './judge.js';
import { extract, disagreement, gates, floorFrom, verdictWith, sampleCalls, barIsMeaningful, structuredCompare, proseText, callsToClear } from './compare.js';
import { promote, revert, trafficOf, everReverted } from './promote.js';
import { replayOnce } from './replay.js';
import { thinkingFit } from './select.js';
import { loadFacts } from '../models/facts.js';
import { forgetFleet } from './history.js';
import { OUTCOME_OF, OUTCOME_CASE, cheaperCleared, confirmed } from './outcome.js';
import { reportCallFailure } from '../alerts.js';
import { jevUsable } from '../jev.js';
import { structureOf, jevCheck, requestText, answerText as checkedText } from '../learn/check.js';
import { simulateCascade, simulateRouter, bestOf, crossFit } from '../learn/simulate.js';
import { featuresOf, train, predict, leaveOneOutGently } from '../learn/router.js';
import { labelOf, armById, leadModel } from '../learn/arms.js';
import { servingKey, keyOfSpec } from './promote.js';
import { markTrying } from '../learn/explore.js';
import { scheduleNext, deferAutomatic } from './schedule.js';

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
const short = (m) => String(m || '').split('/').pop();
// strategies are only worked out with enough calls to learn from, and a router needs more than a cascade
const ROUTER_MIN_CALLS = 40;

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

/* The calls whose two answers from the customer's own model are already paid for and still young
   enough to use, so the sample can prefer them. */
async function paidForCalls(model, callIds) {
  if (!callIds.length) return new Set();
  const rows = await db.prepare(
    `SELECT call_id FROM replay_cache WHERE model_id = ? AND status = 200 AND created_at >= ? AND recipe_json IS NULL
        AND call_id = ANY(?) GROUP BY call_id HAVING COUNT(DISTINCT slot) >= 2`)
    .all(model, now() - config.REPLAY_REUSE_DAYS * DAY, callIds);
  return new Set(rows.map((r) => r.call_id));
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

async function keepReplay(runId, callId, model, slot, r, { score = null, judged = null, failure = null } = {}) {
  await db.prepare(
    `INSERT INTO eval_replays (id, run_id, call_id, model_id, slot, cache_key, reused, status, error, failure, answer,
            latency_ms, ttft_ms, completion_tokens, reasoning_tokens, cost_usd, score, judged_by, difference, created_at)
     VALUES (@id, @run_id, @call_id, @model_id, @slot, @cache_key, @reused, @status, @error, @failure, @answer,
            @latency_ms, @ttft_ms, @completion_tokens, @reasoning_tokens, @cost_usd, @score, @judged_by, @difference,
            @created_at)`).run({
    id: id('rpl'), run_id: runId, call_id: callId, model_id: model, slot, cache_key: r.key ?? null,
    reused: r.reused ? 1 : 0, status: r.status ?? null, error: r.error ?? null, failure,
    answer: answerText(r.json), latency_ms: r.latencyMs ?? null, ttft_ms: r.ttftMs ?? null,
    completion_tokens: r.completionTokens ?? null, reasoning_tokens: r.reasoningTokens ?? null,
    cost_usd: round8(r.cost || 0), score, judged_by: judged?.judgedBy ?? null,
    difference: score > 0 ? (judged?.detail?.kind ?? failure ?? null) : null, created_at: now(),
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
  empty: 'answers nothing', 'unparseable json': 'returns broken JSON', 'no tool call': 'calls no tool',
  'unparseable arguments': 'returns broken tool arguments', refused: 'is refused by its provider',
};

export async function runEvaluation(workloadId, { trigger = 'manual', jobId = null } = {}) {
  const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);
  if (!workload) return { ok: false, reason: 'gone' };
  if (!canRoute()) return { snoozeMs: 15 * 60000, note: 'no OPENROUTER_API_KEY' };

  const reference = workload.reference_model;
  if (!reference) return { ok: false, reason: 'no reference model' };

  /* The same plan the page showed, with whatever the page had to go without asked for now: the
     page never waits on Jev, a measurement does. */
  // nobody asked for it: the schedule, a change in the catalogue, or a new workload's first calls
  const automatic = trigger === 'automatic' || trigger === 'first';
  const plan = await planFor(workload, { canRoute: canRoute(), forRun: true, automatic });
  if (!plan.canRun) {
    /* Looked at again when it is due rather than on every hourly pass, which would work the plan out
       over and over to reach the same answer. */
    if (automatic) await deferAutomatic(workloadId, { waitMs: plan.waitMs ?? (plan.notWorth ? null : 6 * 3600000) });
    /* Back to what its last measurement found, not to "new": a workload that has been measured
       before still has that result, and forgetting it here would put "Not optimized yet" over a
       page that shows a candidate. */
    if (workload.status === 'measuring') await rest(workloadId);
    return { ok: false, reason: plan.reason };
  }

  /* The calls a measurement can draw on: this workload's own traffic over thirty days, spread across
     those days. It used to be the newest six hundred, which on a busy workload is its last few hours.
     Calls that failed when they were made are left out: replaying them measures nothing. */
  const pool = await db.prepare(
    `SELECT id, request_json, response_json, served_model, source, cost_usd, created_at FROM calls
      WHERE id IN (SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY (created_at / 86400000) ORDER BY md5(id || ?)) AS rn
            FROM calls WHERE workload_id = ? AND request_json IS NOT NULL AND created_at >= ?
             AND source NOT IN ('replay', 'test') AND (status_code IS NULL OR status_code < 400)) x
        WHERE rn <= ?)`).all(String(now()), workloadId, now() - 30 * DAY, config.EVAL_POOL_PER_DAY);
  /* A re-check measures calls no earlier measurement of this workload used, so a lucky sample is not
     simply measured again: the same twelve calls, the same cached answers and the same verdict, at
     no cost, was what a re-measure used to be. */
  const usedBefore = new Set((await db.prepare(
    `SELECT DISTINCT s.call_id FROM eval_samples s JOIN eval_runs r ON r.id = s.run_id WHERE r.workload_id = ?`)
    .all(workloadId)).map((r) => r.call_id));
  const freshSet = new Set(pool.filter((c) => !usedBefore.has(c.id)).map((c) => c.id));
  const recheckRun = usedBefore.size > 0;
  const samples = sampleCalls(pool, plan.sample, now() % 100003,
    recheckRun ? null : await paidForCalls(reference, pool.map((p) => p.id)),
    { fresh: recheckRun ? freshSet : null });
  const shape = workload.shape_kind;
  const want = plan.models;
  /* A call's recorded answer, when the customer's own model gave it and it can be read, used as if it
     had been replayed: nothing is paid for it, and its own timing is never used for speed. */
  const recorded = (c) => {
    if (!config.EVAL_USE_RECORDED || !c?.response_json || !c.served_model || String(c.served_model) !== String(reference)) return null;
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
  const queue = plan.order;
  const speed = plan.speed || { factor: null };

  const gate = await gateEval(workload.workspace_id, { estimatedUsd: plan.estimateUsd });
  if (!gate.ok) {
    await addActivity(workload.workspace_id, {
      kind: 'floor', title: `Measuring ${workload.slug} is waiting`, detail: gate.message, workloadId,
    });
    return { snoozeMs: 30 * 60000, note: gate.code };
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
    steps_total: nominal, steps_done: 0, phase: `Setting your bar on ${reference}`,
    trigger: automatic ? 'automatic' : 'manual',
    models_planned: Math.min(want, queue.length), heartbeat_at: now(),
    plan_json: JSON.stringify(planRecord), judge: plan.judge, job_id: jobId,
  };
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, steps_total, steps_done, phase, trigger, models_planned,
              heartbeat_at, plan_json, judge, job_id)
              VALUES (@id, @workspace_id, @workload_id, @status, @shape_kind, @reference_model,
              @sample_size, @created_at, @started_at, @steps_total, @steps_done, @phase, @trigger,
              @models_planned, @heartbeat_at, @plan_json, @judge, @job_id)`).run(run);
  /* Whatever started it, a workload being measured says so from the moment the run exists. */
  await db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), workloadId);
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
    return ended(r.rows[0]);
  };
  /* The run's ending is written only while it is still running and nobody has asked it to stop.
     A stop can arrive while the last charge is being settled; unguarded, the run then wrote
     "done" and switched the model while the page said nothing had been switched. Answers false
     when the stop won, and the run ends stopped. */
  const finish = async (outcome, error) => (await db.prepare(
    `UPDATE eval_runs SET status = 'done', outcome = ?, finished_at = ?, error = ?, phase = NULL,
            steps_done = GREATEST(steps_done, ?), steps_total = GREATEST(steps_done, ?)
      WHERE id = ? AND status = 'running' AND stop_requested_at IS NULL RETURNING id`)
    .run(outcome, now(), error, done, done, run.id)).rows.length > 0;

  let spend = 0;
  // everything this run has spent, settled or not: what the spending limits are held to
  let spentTotal = 0;
  let reusedCount = 0;
  let savedUsd = 0;
  // Jev's reading of the models to try, taken for this measurement, is paid for with it
  if (plan.fitCost > 0) { spend += plan.fitCost; spentTotal += plan.fitCost; }

  /* Charge what has run so far, and say whether there is anything left. */
  const settle = async (note) => {
    if (spend <= 0) return true;
    const amount = spend;
    spend = 0;
    await chargeEval(workload.workspace_id, amount, note);
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
     keeps its result, and nothing is switched. */
  const endStopped = async () => {
    await settle(`Measuring ${workload.slug}, stopped`);
    await keepSavings();
    const closed = await db.prepare(`UPDATE eval_runs SET status = 'stopped', outcome = 'stopped',
                  finished_at = ?, phase = NULL, steps_done = ? WHERE id = ? AND status = 'running' RETURNING id`)
      .run(now(), done, run.id);
    await db.prepare('UPDATE eval_runs SET phase = NULL WHERE id = ?').run(run.id);
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
     will most likely go through once the problem has passed. */
  const interrupt = async (why, { title, retryMs = 30 * 60000 } = {}) => {
    await settle(`Measuring ${workload.slug}, interrupted`);
    await keepSavings();
    const closed = await db.prepare(`UPDATE eval_runs SET status = 'failed', outcome = 'interrupted', error = ?,
                  finished_at = ?, phase = NULL WHERE id = ? AND status = 'running' RETURNING id`)
      .run(why, now(), run.id);
    if (!closed.rows.length) return await endStopped();
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
  /* Every answer asked for now (a recorded one was not) came back unusable: refused, busy, or not
     the shape the call asks for. */
  const deadNow = (p) => {
    const asked = [[p.ra, p.a], [p.rb, p.b]].filter(([r]) => !r.recorded);
    return asked.length > 0 && asked.every(([r, x]) => !r.ok || !x.ok);
  };

  // the bar: the customer's own model against itself, reusing what is already paid for
  const bar = [];
  let stopped = false;
  let cantAnswer = false;
  let account = null;
  try {
  await inParallel(samples, 3, async (s, i) => {
    if (stopped || cantAnswer || account) return;
    if (await halted()) { stopped = true; return; }
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
    if (await step(had ? 1 : 2, `Setting your bar on ${reference}, ${bar.length} of ${samples.length} calls`)) stopped = true;
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
  try {
  await inParallel(kept, 6, async (p) => {
    if (stopped) return;
    let score;
    /* One of the two answers missing because the provider was busy says nothing about whether the
       model agrees with itself, so the pair is left out of the noise. Counted as a disagreement,
       one busy moment in ten calls read as the model disagreeing with itself one time in ten,
       and loosened the bar every candidate is then held to. */
    if (p.ra.transient || p.rb.transient) return;
    if (!p.a.ok || !p.b.ok) score = 1;
    else if (shape === 'free_text') {
      if (await halted()) { stopped = true; return; }
      const j = await judgeBarPair(askOf(p.body), p.a.value, p.b.value, { scope: workload.workspace_id });
      addJudge(j.cost);
      if (j.cost > 0 && await step(1, `Comparing ${reference}'s answers with each other`)) stopped = true;
      /* A judge that could not judge says nothing about whether the model agrees with itself. Counted
         as a disagreement, one failed judgement in ten raised a 3% bar to 11% and let a model that was
         wrong one time in ten clear it. */
      if (j.transient || !j.judgedBy) { judgeMisses += 1; return; }
      score = j.score;
      judgedWith.add(j.judgedBy);
    } else {
      const d = disagreement(p.a, p.b, shape);
      if (d === null) {
        const r = await proseScore(p.body, p.a, p.b, shape, workload.workspace_id);
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
  /* Written work with no one right answer: the customer's own model gives a different, equally good
     answer nearly every time, so "the same answer" is no bar at all. Rather than give up, the bar
     becomes "at least as good": how often the customer's model gives a clearly worse answer than its
     own other one. Only when that is steady too is the workload measured on it. */
  const agreementNoise = noise;
  let qualityNoise = null;
  if (shape === 'free_text' && config.EVAL_QUALITY_YARDSTICK && canJudge() && config.EVAL_JUDGE_MODEL
    && !barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT)) {
    if (await step(0, `Asking whether ${reference}'s answers are at least as good as each other`)) return await endStopped();
    const worse = [];
    await inParallel(kept.filter((p) => p.a.ok && p.b.ok), 6, async (p) => {
      if (stopped) return;
      if (await halted()) { stopped = true; return; }
      const j = await judgeQuality(askOf(p.body), p.b.value, p.a.value, { scope: workload.workspace_id });
      addJudge(j.cost);
      if (j.transient || j.score === null) { judgeMisses += 1; return; }
      judgedWith.add(j.judgedBy);
      worse.push(j.score);
    });
    if (stopped) return await endStopped();
    if (worse.length >= Math.min(10, kept.length)) qualityNoise = mean(worse);
    if (qualityNoise !== null && barIsMeaningful(qualityNoise * 100, config.EVAL_NOISE_MAX_PCT)) {
      yardstick = 'quality';
      noise = mean(worse);
      planRecord.yardstick = { kind: 'quality', agreementNoisePct: round8(agreementNoise * 100), qualityNoisePct: round8(noise * 100) };
      await db.prepare('UPDATE eval_runs SET plan_json = ?, yardstick = ? WHERE id = ?').run(JSON.stringify(planRecord), 'quality', run.id);
    }
  }
  let judgeCheck = null;
  if (shape === 'free_text') {
    judgeCheck = yardstick === 'quality'
      ? await qualityChecks(kept, workload.workspace_id, addJudge)
      : await plantChecks(kept, workload.workspace_id, addJudge);
    judgeUnsure = judgeCheck.errors > 0;
    judgeCheckRecord = { ...judgeCheck, misses: judgeMisses, yardstick };
  }
  const floor = floorFrom(noise * 100, {
    multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT,
  });

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

  /* If the reference model cannot answer its own calls consistently, the bar it produces is
     not a quality standard, it is noise. Stop here and say so. */
  if (!barIsMeaningful(noise * 100, config.EVAL_NOISE_MAX_PCT)) {
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
      detail: `${reference} gave a different answer to the same call ${(noise * 100).toFixed(0)}% of the time`
        + (qualityNoise !== null ? `, and a clearly worse one than its own other answer ${(qualityNoise * 100).toFixed(0)}% of the time` : '')
        + ', so there is no steady bar to hold a cheaper model to. Nothing has been switched.',
      workloadId,
    });
    await scheduleNext(workloadId, { changed: !automatic });
    return { ok: true, runId: run.id, floor: null, results: 0, unmeasurable: true };
  }

  if (!await settle(`Measuring ${workload.slug}, setting the bar`)) {
    await keepSavings();
    if (!await finish('no_balance', 'balance ran out after the bar was set')) return await endStopped();
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
  let reasked = false;
  if (refThinks !== plan.refThinks) {
    const facts = await loadFacts();
    // the customer's model thinking less only means something when it thinks at all
    if (refThinks === false) {
      for (let k = queue.length - 1; k >= 0; k -= 1) if (queue[k].key) queue.splice(k, 1);
    }
    for (const cand of queue) {
      if (cand.model === workload.routed_model || cand.key) continue;
      const m = facts.models.get(cand.model);
      const t = m ? thinkingFit(m, plan.profile, config.EVAL_THINKING_ROOM_TOKENS, refThinks) : null;
      if (t?.ok) { cand.recipe = t.recipe; cand.note = t.note || null; reasked = true; }
    }
  }
  for (const cand of queue) {
    if (cand.model === workload.routed_model) cand.recipe = served;
  }
  if (reasked) {
    planRecord.refThinks = { planned: plan.refThinks, measured: refThinks };
    planRecord.order = planRecord.order.map((o) => {
      const c = queue.find((q) => q.model === o.model);
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
  const results = [];
  let halt = null;

  /* One model's run through the calls, until it finishes or cannot win. With `noDrop` it answers
     every call whatever its answers are like: a model a cascade might rescue is only worth
     judging on all of them. */
  const tryModel = async (cand, { noDrop = false } = {}) => {
    const st = {
      runs: 0, counted: 0, sum: 0, failures: 0, errors: 0, errorText: null, lat: [], ttft: [], reused: 0,
      candCost: 0, refCost: 0, kinds: new Map(), pairs: [], stopped: null, calls: [],
    };
    const key = keyOf(cand);
    // a model already serving this workload is re-checked on fresh answers, so a change in it shows
    /* A model already serving this workload is re-checked on fresh answers, so a change in it shows:
       it answers every call afresh, and when it is finished after being dropped, only the answers it
       gave in this very run are used again, never ones from an earlier measurement. */
    const recheck = cand.model === workload.routed_model && !cand.key;
    const reuse = noDrop || !recheck;
    const reuseSince = recheck ? runStartedAt : 0;
    answered.set(key, 0);
    for (const [i, p] of kept.entries()) {
      if (halt) { st.stopped = halt === 'budget' ? 'budget' : 'user'; break; }
      /* Never past the most one measurement may spend, whatever it was quoted at: the quote counts
         a few calls for each model dropped early, and a model can be dropped late. */
      if (spentTotal >= hardLimit) { halt = 'budget'; st.stopped = 'budget'; break; }
      if (await halted()) { halt = halt || 'stopped'; st.stopped = 'user'; break; }
      const r = await replayOnce({ body: p.body, callId: p.s.id, model: cand.model, recipe: cand.recipe, slot: 0, workload, reuse, reuseSince });
      note(r);
      // our own account, not this model: the whole measurement stops, and nothing is held against anybody
      if (r.account) { halt = 'account'; accountHit = accountHit || { ...r, model: cand.model }; st.stopped = 'user'; break; }
      if (r.reused) st.reused += 1;
      st.runs += 1;
      let score = 1;
      let judged = null;
      let failure = null;
      let counted = false;
      // whether this call says anything about the model's answers
      let scored = true;
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
        if (!r.transient || st.errors >= 2) st.stopped = r.transient ? 'errors' : 'refused';
      } else {
        if (r.latencyMs) st.lat.push(r.latencyMs);
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
        } else if (shape === 'free_text') {
          /* The replay has come back and is counted before the judgement is asked for, so a stop
             that lands between the two still counts the call that ran and was paid for. */
          answered.set(key, st.runs);
          if (await step(1, `Trying ${cand.label || cand.model}, ${st.runs} of ${kept.length} calls`)) {
            counted = true;
            halt = halt || 'stopped';
            st.stopped = 'user';
          }
          if (!st.stopped && await halted()) { halt = halt || 'stopped'; st.stopped = 'user'; }
          counted = true;
          if (st.stopped === 'user') {
            await keepReplay(run.id, p.s.id, key, 0, r, { score: null, judged: null, failure: null });
            break;
          }
          judged = yardstick === 'quality'
            ? await judgeQuality(askOf(p.body), got.value, p.a.ok ? p.a.value : p.b.value, { scope: workload.workspace_id })
            : await judgeCandidate(askOf(p.body), got.value, p.a.ok ? p.a.value : null, p.b.ok ? p.b.value : null,
              { scope: workload.workspace_id });
          addJudge(judged.cost);
          score = judged.score;
          if (judged.judgedBy) judgedWith.add(judged.judgedBy);
          // a judgement that did not come back says nothing about this model's answer either
          if (judged.transient) { scored = false; judgeMisses += 1; }
        } else {
          /* Held to each of the customer's two answers and averaged, the way the bar is set: the
             bar is how often the customer's model differs from one of its own answers, so a copy
             of it scores the noise exactly. Its better match gave every candidate two chances. */
          /* A deciding field that differs makes the call different; written fields that differ only in
             wording are read for meaning, never counted as a difference on their own. */
          const both = [];
          let missed = false;
          for (const ref of [p.a, p.b].filter((x) => x.ok)) {
            const d = disagreement(got, ref, shape);
            if (d !== null) { both.push(d); continue; }
            const r = await proseScore(p.body, got, ref, shape, workload.workspace_id);
            addJudge(r.cost);
            if (r.transient) { missed = true; continue; }
            if (r.judgedBy) judgedWith.add(r.judgedBy);
            both.push(r.score);
          }
          // a written field nobody could read says nothing either way, unless a deciding one already differed
          if (!both.length && missed) { scored = false; judgeMisses += 1; score = 0; } else {
            score = both.length ? both.reduce((x, y) => x + y, 0) / both.length : 1;
          }
        }
        st.pairs.push({ cand: got, ref: p.a.ok ? p.a : p.b, score, i });
      }
      const kind = score > 0 && scored ? (judged?.detail?.kind || failure || null) : null;
      if (kind) st.kinds.set(kind, (st.kinds.get(kind) || 0) + 1);
      if (scored) { st.sum += score; st.counted += 1; }
      // everything about this call a strategy built on this model would need to be worked out later
      st.calls.push({
        i, ok: !!r.ok && !failure, answered: !!r.ok, transient: !r.ok && !!r.transient, scored, score,
        json: r.ok ? r.json : null, cost: r.ok ? paid(r) : 0, latency: r.latencyMs ?? null, ttft: r.ttftMs ?? r.latencyMs ?? null,
      });
      await keepReplay(run.id, p.s.id, key, 0, r, { score, judged, failure });
      /* The best it could still do is get every remaining call right. When even that leaves it
         outside the review band, it cannot win, and every further call would be money spent on
         nothing. */
      if (!noDrop && !st.stopped && (st.sum / kept.length) * 100 > floor * reviewBand) st.stopped = 'bar';
      /* The model serving the workload is timed on every call before anything is decided about its
         speed: a few slow calls early would otherwise switch a customer back on the least evidence. */
      if (!noDrop && !st.stopped && cand.model !== workload.routed_model && tooSlow(st)) st.stopped = 'speed';
      // a judgement that went out is a model call too, and is counted like one
      const judgeCalls = judged && judged.cost > 0 ? 1 : 0;
      answered.set(key, st.stopped ? kept.length : st.runs);
      if (await step((counted ? 0 : 1) + judgeCalls, `Trying ${cand.label || cand.model}, ${st.runs} of ${kept.length} calls`)) {
        halt = halt || 'stopped';
        if (!st.stopped) st.stopped = 'user';
        break;
      }
      if (st.stopped) break;
    }
    return st;
  };

  const record = async (cand, st) => {
    const gap = st.counted ? (st.sum / st.counted) * 100 : 100;
    const finished = st.runs === kept.length && (!st.stopped || st.stopped === 'speed' || st.stopped === 'bar');
    /* The verdict carries how sure the sample can make anybody (see verdictWith): cleared only when
       even the top of its range is inside the bar, and "not enough calls" when this many calls could
       never show it, whatever the answers. */
    const read = verdictWith(st.calls.filter((c) => c.scored).map((c) => c.score), floor, { reviewBand });
    let verdict;
    if (st.stopped === 'refused' || st.stopped === 'errors') verdict = 'failed';
    else if (st.stopped === 'speed') verdict = 'slower';
    else if (st.stopped === 'bar') verdict = 'missed';
    else {
      verdict = read.verdict;
      if ((verdict === 'cleared' || verdict === 'review') && tooSlow(st, { final: true })) verdict = 'slower';
      // one refusal along the way is worth a look before anything is switched
      if (verdict === 'cleared' && st.errors > 0) verdict = 'review';
      // a judge that failed its known pairs this run settles nothing on its own
      if (judgeUnsure && verdict === 'cleared') verdict = 'review';
    }
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
      rank_json: JSON.stringify({ chance: cand.chance, savingShare: cand.savingShare, parts: cand.parts, family: cand.family }),
      recipe_json: cand.recipe ? JSON.stringify(cand.recipe) : null,
      cost_ratio: ratio === null ? null : round8(ratio),
      // the customer's own model thinking less is a strategy of its own, served the way it was measured
      arm_json: cand.key ? JSON.stringify({ kind: 'model', model: cand.model, recipe: cand.recipe ?? null }) : null,
      escalated_pct: null,
      // where the true gap most likely is, and how many calls it would take to clear this bar
      gap_lo: round8(read.lo), gap_hi: round8(read.hi), calls_needed: read.need ?? null,
    };
    await insertResult(row);
    return finished;
  };

  /* The second look: the candidate on calls it has never seen, scored exactly as the first look scored
     it, against two of the customer's own model's answers to each call (the recorded one where there is
     one, and a replay), averaged. Scored against one answer instead, the second look was stricter than
     the first, and turned down models as good as the ones the first look let through.
     Enough calls that a model better than the bar can clear: EVAL_CONFIRM_MULTIPLE times what a perfect
     run needs, and never fewer than what a perfect run needs. */
  const confirmOn = async (r, freshCalls) => {
    const { cand } = stats.get(r.model_id) || {};
    if (!cand) return { verdict: 'unconfirmed', runs: 0, note: 'there was nothing to look again with' };
    const least = callsToClear(floor);
    const usable = freshCalls.filter((c) => !usedBefore.has(c.id));
    const from = usable.length >= least ? usable : freshCalls;
    if (from.length < least) {
      await db.prepare('UPDATE eval_results SET confirm_runs = 0, confirm_verdict = ? WHERE id = ?').run('insufficient', r.id);
      return { verdict: 'insufficient', runs: 0,
        note: `there are not yet enough calls it has not seen to look again (${from.length} of the ${least} needed)` };
    }
    // never thinner than the first look: a second look on fewer calls is a noisier one, not a stricter one
    const n = Math.min(from.length, Math.max(config.EVAL_CONFIRM_MIN, Math.ceil(config.EVAL_CONFIRM_MULTIPLE * least), samples.length));
    const picks = sampleCalls(from, n, (now() % 99991) + 13);
    // the calls it will send: one or two of the customer's model, and the candidate's one
    const sends = (c) => (recorded(c) ? 2 : 3);
    confirmLeft = picks.reduce((a, c) => a + sends(c), 0);
    remaining = () => confirmLeft;
    const scores = [];
    // the customer's own model against itself on these calls too, so the bar is read from both samples
    const freshNoise = [];
    for (const c of picks) {
      if (halt || spentTotal >= hardLimit) break;
      if (await halted()) { halt = 'stopped'; break; }
      const had = recorded(c);
      confirmLeft = Math.max(0, confirmLeft - sends(c));
      const body = JSON.parse(c.request_json);
      const [ra, rb] = had ? [had, await replayOnce({ body, callId: c.id, model: reference, slot: 1, workload })]
        : await Promise.all([
          replayOnce({ body, callId: c.id, model: reference, slot: 0, workload }),
          replayOnce({ body, callId: c.id, model: reference, slot: 1, workload }),
        ]);
      if (had) recordedRefs += 1;
      note(ra);
      note(rb);
      const refHit = [ra, rb].find((x) => x.account);
      if (refHit) { halt = 'account'; accountHit = { ...refHit, model: reference }; break; }
      const refs = [extract(ra.json, shape), extract(rb.json, shape)].filter((x, k) => [ra, rb][k].ok && x.ok);
      let judged = 0;
      if (refs.length === 2) {
        if (shape === 'free_text') {
          const j = yardstick === 'quality'
            ? await judgeQuality(askOf(body), refs[1].value, refs[0].value, { scope: workload.workspace_id })
            : await judgeBarPair(askOf(body), refs[0].value, refs[1].value, { scope: workload.workspace_id });
          addJudge(j.cost);
          if (j.cost > 0) judged += 1;
          if (!j.transient && j.score !== null && j.score !== undefined) freshNoise.push(j.score);
        } else {
          const d = disagreement(refs[0], refs[1], shape);
          if (d !== null) freshNoise.push(d);
          else {
            const pr = await proseScore(body, refs[0], refs[1], shape, workload.workspace_id);
            addJudge(pr.cost);
            if (pr.cost > 0) judged += 1;
            if (!pr.transient) freshNoise.push(pr.score);
          }
        }
      }
      const got = refs.length ? await replayOnce({ body, callId: c.id, model: cand.model, recipe: cand.recipe, slot: 0, workload }) : null;
      if (got) note(got);
      if (got?.account) { halt = 'account'; accountHit = { ...got, model: cand.model }; break; }
      let score = null;
      if (!refs.length) score = null;
      else if (!got.ok) score = got.transient ? null : 1;
      else {
        const g = extract(got.json, shape);
        if (!g.ok) score = 1;
        else if (shape === 'free_text') {
          const j = yardstick === 'quality'
            ? await judgeQuality(askOf(body), g.value, refs[0].value, { scope: workload.workspace_id })
            : await judgeCandidate(askOf(body), g.value, refs[0].value, refs[1]?.value ?? null, { scope: workload.workspace_id });
          addJudge(j.cost);
          if (j.cost > 0) judged += 1;
          score = j.transient || j.score === null ? null : j.score;
        } else {
          const each = [];
          for (const ref of refs) {
            const d = disagreement(g, ref, shape);
            if (d !== null) { each.push(d); continue; }
            const pr = await proseScore(body, g, ref, shape, workload.workspace_id);
            addJudge(pr.cost);
            if (pr.cost > 0) judged += 1;
            if (!pr.transient) each.push(pr.score);
          }
          score = each.length ? each.reduce((a, b) => a + b, 0) / each.length : null;
        }
      }
      if (score !== null) scores.push(score);
      const sent = (had ? 1 : 2) + (got ? 1 : 0) + judged;
      if (await step(sent, `Looking again at ${cand.label || cand.model} on calls it has not seen, ${scores.length} of ${picks.length}`)) {
        halt = 'stopped';
        break;
      }
    }
    confirmLeft = 0;
    /* The bar, read from both samples: how often the customer's model disagreed with itself on the first
       look's calls and on these. A bar read from one sample of a hundred moves a good deal by chance,
       and a second look held to the first sample's bar alone turned good models down whenever the two
       samples happened to differ. The candidate's own reading is from these calls only, as it must be. */
    const pooled = [...noiseScores, ...freshNoise];
    const bar = pooled.length ? floorFrom(mean(pooled) * 100, {
      multiple: config.EVAL_FLOOR_MULTIPLE, minPct: config.EVAL_FLOOR_MIN_PCT,
    }) : floor;
    const v = verdictWith(scores, bar, { reviewBand });
    const verdict = judgeUnsure && v.verdict === 'cleared' ? 'review' : v.verdict;
    await db.prepare(`UPDATE eval_results SET confirm_runs = ?, confirm_gap = ?, confirm_hi = ?, confirm_verdict = ?, confirm_floor = ? WHERE id = ?`)
      .run(scores.length, round8(v.gap), round8(v.hi), verdict, round8(bar), r.id);
    return { verdict, runs: scores.length, gap: v.gap, hi: v.hi, floor: bar };
  };
  let confirmLeft = 0;

  const insertResult = async (row) => {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict,
                gate_structure, gate_accuracy, gate_coverage, gate_complete, failures, created_at,
                latency_p50, latency_p90, ttft_p50, ttft_p90, errors, stopped, error_text, difference, reused,
                rank_json, recipe_json, cost_ratio, arm_json, escalated_pct, gap_lo, gap_hi, calls_needed)
                VALUES (@id, @run_id, @model_id, @runs, @gap_pct, @cost_month_usd, @verdict,
                @gate_structure, @gate_accuracy, @gate_coverage, @gate_complete, @failures, @created_at,
                @latency_p50, @latency_p90, @ttft_p50, @ttft_p90, @errors, @stopped, @error_text, @difference, @reused,
                @rank_json, @recipe_json, @cost_ratio, @arm_json, @escalated_pct, @gap_lo, @gap_hi, @calls_needed)`)
      .run({ gap_lo: null, gap_hi: null, calls_needed: null, ...row });
    results.push(row);
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
  const softLimit = quote > 0 ? quote * 1.5 : config.EVAL_MAX_USD_PER_RUN;
  /* Never past what one measurement of this workload may spend, nor past what is left of the
     workspace's own optimization budget, whatever it was quoted at. Spend here is counted before our
     fee, the budget after it. */
  let hardLimit = Math.max(Number(plan.ceilingUsd) || config.EVAL_MAX_USD_PER_RUN, quote);
  if (plan.optimizeBudget) hardLimit = Math.min(hardLimit, plan.optimizeBudget.leftUsd / (1 + config.ROUTING_FEE_PCT / 100));
  remaining = () => {
    let left = 0;
    for (const n of answered.values()) left += Math.max(0, kept.length - n) * perCall;
    const open = Math.max(0, want - finished - answered.size);
    return left + Math.min(open, Math.max(0, queue.length - next)) * kept.length * perCall;
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

  if (halt === 'stopped') return await endStopped();
  if (laneError) {
    await interrupt(`Something went wrong here part way through: ${String(laneError?.message || laneError).slice(0, 160)}.`, { retryMs: 0 });
    throw laneError;
  }
  if (halt === 'account') {
    reportCallFailure({ kind: 'measurement replays', model: accountHit?.model ?? null, status: accountHit?.status, message: accountHit?.error });
    return await interrupt(accountProblem(accountHit));
  }

  /* Strategies, for the cheaper models that could not manage alone.
   *
   * A model wrong on a small share of calls misses the bar, and most of what it would save is
   * lost with it. A cascade keeps that saving on the calls it gets right: it answers first, a
   * quick check reads the answer, and a doubtful one is sent on to the customer's own model. A
   * router does the same without the check, by picking the model before the call is sent, from a
   * small model of which calls it got right. Both are worked out here from answers already paid
   * for, plus one check per answer, and only what clears the bar can be switched to. */
  const noiseMean = mean(noiseScores);
  const refOfPair = (p) => {
    const r = p.ra?.ok ? p.ra : p.rb;
    return { cost: p.refCost, latency: r?.latencyMs ?? null, ttft: r?.ttftMs ?? r?.latencyMs ?? null,
      noise: p.noise ?? noiseMean };
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
    return {
      id: id('res'), run_id: run.id, model_id: keyOfSpec(spec, reference), runs: kept.length,
      gap_pct: round8(reading.gap), cost_month_usd: costMonth, verdict,
      gate_structure: 100, gate_accuracy: Math.round(100 - reading.gap), gate_coverage: 100, gate_complete: 100,
      failures: 0, created_at: now(),
      latency_p50: pct(reading.latency, 0.5), latency_p90: pct(reading.latency, 0.9),
      ttft_p50: pct(reading.ttft, 0.5), ttft_p90: pct(reading.ttft, 0.9),
      errors: 0, stopped: null, error_text: null, difference: extra.difference ?? null, reused: 0,
      rank_json: JSON.stringify({ chance: cand.chance, savingShare: cand.savingShare, parts: cand.parts, family: cand.family }),
      recipe_json: cand.recipe ? JSON.stringify(cand.recipe) : null,
      cost_ratio: reading.ratio === null ? null : round8(reading.ratio),
      arm_json: JSON.stringify(spec), escalated_pct: round8(reading.escalated * 100),
      gap_lo: reading.read ? round8(reading.read.lo) : null, gap_hi: reading.read ? round8(reading.read.hi) : null,
      calls_needed: reading.read?.need ?? null,
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
    return v;
  };
  const fastEnough = (r) => quickEnough(metric === 'ttft' ? r.ttft : r.latency);

  const cascadeFor = async (cand, st) => {
    const spec = { kind: 'cascade', first: { model: cand.model, recipe: cand.recipe ?? null }, fallback: { model: reference, recipe: null } };
    const label = labelOf(spec, reference);
    const checks = [];
    let checked = 0;
    for (const c of st.calls) {
      const p = kept[c.i];
      if (!c.ok) { checks.push({ structureOk: false, p: 0, ms: 0, liveCost: 0 }); continue; }
      const shapeOk = structureOf(p.body, c.json, shape);
      if (!shapeOk.ok) { checks.push({ structureOk: false, p: 0, ms: 0, liveCost: 0 }); continue; }
      if (halt || spentTotal >= hardLimit) return false;
      if (await halted()) { halt = 'stopped'; return false; }
      let j;
      try { j = await jevCheck(p.body, c.json, shape, { scope: workload.workspace_id }); } catch { return false; }
      addJudge(j.cost);
      checked += 1;
      strategyLeft = Math.max(0, strategyLeft - 1);
      if (j.cost > 0 && await step(1, `Checking ${short(cand.model)}'s answers, ${checked} of ${kept.length}`)) { halt = 'stopped'; return false; }
      checks.push({ structureOk: true, p: j.p, ms: j.ms || 0, liveCost: liveCheckCost(p, c.json) });
    }
    const calls = st.calls.map((c, k) => ({ ok: c.ok, score: c.scored ? c.score : (kept[c.i].noise ?? noiseMean),
      cost: c.cost, latency: c.latency, ttft: c.ttft, check: checks[k], ref: refOfPair(kept[c.i]) }));
    /* The strictness is chosen on some calls and scored on the others (crossFit), so the gap reported
       is one the choice never saw; the strictness served is the one chosen on all of them. */
    const readingsOf = (cs) => simulateCascade(cs, { checkCost: (c) => c.liveCost, checkMs: (c) => c.ms });
    const cf = crossFit(calls.map((c, k) => ({ ...c, liveCost: checks[k].liveCost, ms: checks[k].ms })), readingsOf,
      (rs) => bestOf(rs, { floor, reviewBand, fast: fastEnough }));
    const best = { ...cf.heldOut, threshold: cf.threshold, inside: cf.inSample.inside, near: cf.inSample.near, slow: cf.inSample.slow };
    await insertResult(strategyRow(cand, { ...spec, threshold: best.threshold }, best, verdictOf(best), { difference: label }));
    return true;
  };

  const routerFor = async (cand, st, { always = false } = {}) => {
    const usable = st.calls.filter((c) => c.ok && c.scored);
    const matched = usable.filter((c) => c.score === 0).length;
    // something to tell apart: some calls it gets right and some it does not
    if (usable.length < ROUTER_MIN_CALLS || matched < 5 || usable.length - matched < 5) return false;
    const samples = usable.map((c) => ({ x: featuresOf(kept[c.i].body), y: c.score === 0 ? 1 : 0, c }));
    const loo = await leaveOneOutGently(samples);
    const byCall = new Map(samples.map((s, k) => [s.c.i, loo[k]]));
    /* Every call is predicted, the ones the cheap model failed included: the router picks before it
       sends, so it meets those calls too, and one it sends to the cheap model gets the failure. Left
       out, they were always sent on in the sums and never charged, which is not what the router does. */
    const model = train(samples);
    const calls = st.calls.map((c) => ({ ok: c.ok, score: c.scored ? c.score : (kept[c.i].noise ?? noiseMean), cost: c.cost,
      latency: c.latency, ttft: c.ttft, p: byCall.get(c.i) ?? predict(model, featuresOf(kept[c.i].body)), ref: refOfPair(kept[c.i]) }));
    const cf = crossFit(calls, (cs) => simulateRouter(cs), (rs) => bestOf(rs, { floor, reviewBand, fast: fastEnough }));
    const best = { ...cf.heldOut, threshold: cf.threshold, inside: cf.inSample.inside, near: cf.inSample.near, slow: cf.inSample.slow };
    const v = verdictOf(best);
    /* A router is only worth keeping when it clears the bar on calls it did not learn from, and
       saves something doing it: one that sends every call to the customer's own model clears
       the bar at no saving, and is the customer's own model with extra steps. The router serving
       the workload is always written down, whatever it found, so a measurement can switch it back. */
    if (!always && (v !== 'cleared' || best.ratio === null || best.ratio > 0.95)) return false;
    const spec = { kind: 'router', cheap: { model: cand.model, recipe: cand.recipe ?? null }, strong: { model: reference, recipe: null },
      threshold: best.threshold, ...model };
    await insertResult(strategyRow(cand, spec, best, v));
    return true;
  };

  let strategyLeft = 0;
  /* The strategy serving this workload now is always worked out again, from its lead model's run,
     whatever that model did on its own: otherwise a cascade or router whose answers had slipped was
     never written down, and so never switched back. */
  const servingArmNow = workload.routed_arm_id ? await armById(workload.routed_arm_id) : null;
  const servingKind = ['cascade', 'router'].includes(servingArmNow?.spec?.kind) ? servingArmNow.spec.kind : null;
  const leadPart = servingKind ? leadModel(servingArmNow.spec) : null;
  const leadKey = leadPart ? (leadPart.model === reference && leadPart.recipe?.reasoning ? `${reference}#lighter` : leadPart.model) : null;
  if (!halt) {
    const cheaper = (r) => r.cost_month_usd !== null && (refMonthly === null || r.cost_month_usd < refMonthly);
    // one model, or the customer's own thinking less; never a strategy built on a strategy
    const plain = results.filter((r) => r.verdict !== 'reference' && stats.has(r.model_id)
      && (!r.arm_json || String(r.model_id).endsWith('#lighter')));
    // answered every call, and could not manage alone
    const pool = plain.filter((r) => ['missed', 'review'].includes(r.verdict) && !r.stopped && cheaper(r));
    /* Dropped part way for its answers, but it could still save something with the calls it gets
       wrong sent on: its own price, plus the customer's model on the share it got wrong, has to
       leave room under the customer's price. Judged on the saving rather than on how far it
       missed, because a model dropped after a few calls has a rough reading of how often it is
       wrong, and a cheap model wrong one time in eight is exactly what a cascade is for. */
    const roomLeft = (r) => (r.cost_ratio === null ? 0 : 1 - (Number(r.cost_ratio) + Math.min(1, Number(r.gap_pct) / 100)));
    const close = plain.filter((r) => r.stopped === 'bar' && cheaper(r) && roomLeft(r) >= 0.25)
      .sort((a, b) => a.cost_month_usd - b.cost_month_usd).slice(0, 2);
    const forced = leadKey ? plain.find((r) => r.model_id === leadKey) : null;
    const worth = [...(forced ? [forced] : []),
      ...[...pool, ...close].filter((r) => r !== forced).sort((a, b) => a.cost_month_usd - b.cost_month_usd).slice(0, 3)];
    if (worth.length && (jevUsable() || kept.length >= ROUTER_MIN_CALLS)) {
      strategyLeft = worth.length * kept.length;
      remaining = () => strategyLeft;
      try {
        for (const r of worth) {
          if (halt) break;
          let { cand, st } = stats.get(r.model_id);
          if (st.runs < kept.length) {
            // finishes the calls it was dropped before; the ones already answered cost nothing again
            const more = await tryModel(cand, { noDrop: true });
            answered.delete(keyOf(cand));
            if (more.runs < kept.length || more.stopped) continue;
            st = more;
          }
          // the serving strategy's own kind for its lead model; both kinds for everything else
          const isServing = r === forced;
          if (jevUsable() && (!isServing || servingKind === 'cascade')) await cascadeFor(cand, st);
          if (!halt && (!isServing || servingKind === 'router')) await routerFor(cand, st, { always: isServing });
        }
      } catch (err) {
        await interrupt(`Something went wrong here while trying strategies: ${String(err?.message || err).slice(0, 160)}.`, { retryMs: 0 });
        throw err;
      }
      strategyLeft = 0;
    }
  }
  if (halt === 'stopped') return await endStopped();

  /* Which cleared models could be switched to at all: priced, and cheaper than the customer's own
     model on these very calls once the fee is added. A customer's model with no known price used to
     switch the "cheaper" check off, and a model ten times dearer was switched to. */
  const feeCeiling = 1 / (1 + config.ROUTING_FEE_PCT / 100);
  const priced = (r) => r.cost_month_usd !== null && refMonthly !== null && r.cost_month_usd < refMonthly
    && r.cost_ratio !== null && Number(r.cost_ratio) < feeCeiling;
  const clearedAll = results.filter((r) => r.verdict === 'cleared' && priced(r))
    .sort((a, b) => a.cost_month_usd - b.cost_month_usd);
  const unpriced = results.filter((r) => r.verdict === 'cleared' && !priced(r));
  const cleared = [];
  for (const r of clearedAll) if (!await everReverted(workloadId, r.model_id)) cleared.push(r);

  /* A second look before anything is switched. Up to ten models race and the cheapest that cleared
     wins, which is ten chances to be lucky: in simulation, ten models each half as bad again as the
     bar allowed switched to a bad one nearly every time, and the certificate showed about half the
     true gap. The winner is measured again on calls it has never seen, held to the same rule, and only
     a model that clears both times can be switched to. That brought false switches to about one in a
     thousand. A strategy (a checked cheap model, a pick made call by call) has its second look on live
     calls instead, a small share at a time. */
  let best = null;
  const confirmations = [];
  const sampled = new Set(samples.map((x) => x.id));
  const fresh = pool.filter((c) => !sampled.has(c.id));
  /* What serves the workload now is not looked at twice: its live calls are watched every hour, and a
     second look would pay again to learn what they already show. Cheaper ones are tried first, at most
     EVAL_CONFIRM_TRIES of them, and the one serving ends the search when it is reached. */
  const servingNow = workload.routed_model ? await servingKey(workload) : null;
  let tries = 0;
  for (const r of cleared) {
    if (halt) break;
    if (r.model_id === servingNow) { best = r; confirmations.push({ r, c: { verdict: 'cleared', runs: 0, serving: true } }); break; }
    if (tries >= config.EVAL_CONFIRM_TRIES) continue;
    tries += 1;
    const plainModel = !r.arm_json || String(r.model_id).endsWith('#lighter');
    const c = plainModel ? await confirmOn(r, fresh) : { verdict: 'cleared', runs: 0, live: true };
    confirmations.push({ r, c });
    if (c.verdict === 'cleared') { best = r; break; }
  }
  if (halt === 'stopped') return await endStopped();

  await settle(`Measuring ${workload.slug}`);
  await keepSavings();
  const outcome = results.length ? 'compared' : 'no_balance';
  // a stop that arrived during that last settle wins: stopped, and nothing switched
  const why = halt === 'balance' ? 'balance ran out part way through'
    : halt === 'budget' || (overQuote && finished < want) ? 'reached the most one measurement may spend' : null;
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
  if (serving) {
    // the strategy serving it, by the name its result carries: a cascade's is its own row
    const servingAs = await servingKey(workload);
    let mine = results.find((r) => r.model_id === servingAs);
    if (!mine && servingKind) {
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
    if (mine && mine.verdict === 'missed') {
      why = `it no longer clears your bar: ${mine.gap_pct.toFixed(1)}% against a ${floor.toFixed(1)}% bar`;
      soft = false;
    } else if (mine && mine.verdict === 'failed' && mine.stopped === 'refused') {
      why = `its provider refused it when it was re-checked${mine.error_text ? `, saying "${mine.error_text}"` : ''}`;
    } else if (mine && mine.verdict === 'slower' && !mine.stopped) {
      why = 'it is now slower than your speed setting allows';
    } else if (mine && ['cleared', 'review'].includes(mine.verdict) && refMonthly !== null
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
      title: `${unpriced.length === 1 ? unpriced[0].model_id : `${unpriced.length} models`} cleared your bar on ${workload.slug}, but cannot be switched to`,
      detail: refMonthly === null
        ? `We could not price ${reference} on your calls, so nothing can be shown to be cheaper. Nothing was switched.`
        : 'Once our fee is added it would not cost less than your own model on your calls. Nothing was switched.',
      workloadId,
    });
  }
  // the model that serves it held up, and nothing cheaper did: nothing changes
  const stillServing = !!best && best.model_id === servingNow && !switchedBack;
  if (best && best.model_id === servingNow && switchedBack) best = null;
  const second = !best && confirmations.length && !confirmations[0].c.serving ? confirmations[0] : null;

  if (stillServing) {
    const failedLooks = confirmations.filter((x) => !x.c.serving && x.c.verdict !== 'cleared');
    await db.prepare(`UPDATE workloads SET status = 'promoted', status_note = NULL, updated_at = ? WHERE id = ? AND routed_model IS NOT NULL`)
      .run(now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${best.model_id} still clears your bar on ${workload.slug}`,
      detail: `${best.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar, on calls it had not answered before`
        + (failedLooks.length ? `. ${failedLooks.length === 1 ? failedLooks[0].r.model_id : `${failedLooks.length} cheaper models`} cleared once and did not hold up on a second look, so nothing changed` : ''),
      workloadId,
    });
  } else if (best) {
    const saving = refMonthly === null ? null : round8(refMonthly - best.cost_month_usd);
    // calls that reach us as copies cannot be switched by us, so for them this is advice
    const traffic = await trafficOf(workload);
    await db.prepare(`UPDATE workloads SET status = 'certified', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), workloadId);
    const conf = confirmations.find((x) => x.r === best)?.c;
    await addActivity(workload.workspace_id, {
      kind: 'ok',
      title: `${best.model_id} cleared your bar on ${workload.slug}`,
      detail: `${best.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar`
        + (conf?.runs ? `, and again on ${conf.runs} calls it had never seen (${conf.gap.toFixed(2)}%, at most ${conf.hi.toFixed(2)}%, against a ${conf.floor.toFixed(2)}% bar read from both)` : '')
        + (saving ? `, about $${saving.toFixed(2)} a month less` : '')
        + (reusedCount - recordedRefs > 0 ? `. ${reusedCount - recordedRefs} answers were reused from earlier measurements` : '')
        + (recordedRefs ? `. ${recordedRefs} of your own model's answers were read from your calls rather than paid for again` : '')
        + (traffic.carries ? '' : '. Your calls reach us as copies, so a switch starts with the first call that comes through Understudy'),
      workloadId,
    });
    if (workload.optimize_mode === 'auto') {
      const recipe = best.recipe_json ? JSON.parse(best.recipe_json) : null;
      await promote(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId), best.model_id, {
        runId: run.id, reason: 'cleared your bar', auto: true, recipe,
      });
    }
  } else if (second) {
    /* It cleared once and did not hold up on fresh calls, or there were not enough fresh calls to
       look again. Nothing is switched on one look; a person decides, or the next measurement does. */
    const why = second.c.note
      || `on ${second.c.runs} calls it had never seen it differed ${second.c.gap.toFixed(2)}% of the time, and could be as high as ${second.c.hi.toFixed(2)}% against a ${second.c.floor.toFixed(2)}% bar`;
    await db.prepare(`UPDATE workloads SET status = 'certified', status_note = ?, updated_at = ? WHERE id = ?`)
      .run('A candidate cleared once and needs a second look', now(), workloadId);
    await addActivity(workload.workspace_id, {
      kind: 'floor',
      title: `${second.r.model_id} cleared your bar on ${workload.slug} once`,
      detail: `${second.r.gap_pct.toFixed(2)}% against a ${floor.toFixed(2)}% bar, but ${why}. Nothing was switched: `
        + 'approve it on the workload page, or the next measurement looks again.',
      workloadId,
    });
  } else {
    const anyReview = results.some((r) => r.verdict === 'review');
    // matched and too slow, which only a model that answered every call can be said to have done
    const anySlower = results.some((r) => r.verdict === 'slower' && !r.stopped);
    await db.prepare(`UPDATE workloads SET status = ?, status_note = ?, updated_at = ? WHERE id = ?`)
      .run(anyReview ? 'certified' : 'no_match',
           anyReview ? 'A candidate is close and needs a look'
             : anySlower ? 'A model matched, but is slower than yours' : 'Nothing cleared your bar yet',
           now(), workloadId);
    await addActivity(workload.workspace_id, {
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
  await scheduleNext(workloadId, { changed: !automatic || switchedBack || !!second || (!!best && !stillServing) });
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
    `SELECT verdict, cost_month_usd, stopped, cost_ratio, confirm_verdict FROM eval_results WHERE run_id = ?`).all(last.id);
  // the run's own rule, so a status read again always says what the run said at its end
  const ready = cheaperCleared(results);
  if (ready.length) {
    return { status: 'certified', note: confirmed(ready[0]) ? null : 'A candidate cleared once and needs a second look', routed };
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
   leaves that difference with us rather than with the customer. */
async function closeRun(run, how) {
  const closed = await db.prepare(
    `UPDATE eval_runs SET status = ?, outcome = ?, finished_at = ?, phase = NULL,
            error = COALESCE(error, ?) WHERE id = ? AND status = 'running' RETURNING id`)
    .run(how === 'stopped' ? 'stopped' : 'failed', how, now(),
         how === 'stopped' ? null : 'interrupted', run.id);
  if (!closed.rows.length) return false;
  /* and let go of the job that started it. Left claimed, the job still counted as open, so
     Measure now was answered with it and started nothing, and a later boot revived it and ran
     a measurement nobody had asked for then. */
  if (run.job_id) {
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
async function proseScore(body, x, y, shape, scope) {
  const c = structuredCompare(x.value, y.value, shape);
  if (c.decision) return { score: 1, cost: 0 };
  if (!c.prose.length) return { score: 0, cost: 0 };
  const j = await judgeBarPair(askOf(body), proseText(c.prose, 'a'), proseText(c.prose, 'b'), { scope });
  /* A judgement that did not come back is no reading at all. It used to count as "the same", which is
     the direction that lets a candidate through. */
  if (j.transient || !j.judgedBy) return { score: null, cost: j.cost || 0, judgedBy: null, transient: true };
  return { score: j.score, cost: j.cost || 0, judgedBy: j.judgedBy };
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
    const j = await judgeBarPair(askOf(p.body), t, variant, { scope });
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
    const j = await judgeBarPair(askOf(p.body), p.a.value, q.a.value, { scope });
    addJudge(j.cost);
    if (j.transient || !j.judgedBy) continue;
    out.different += 1;
    if (j.score !== 1) { out.errors += 1; out.cases.push("another call's answer read as the same"); }
  }
  return out;
}

/* The quality judge on pairs whose answer is known: an answer against itself with only its spacing
   changed is not worse, and an answer cut to its first third is. */
async function qualityChecks(kept, scope, addJudge) {
  const out = { errors: 0, same: 0, different: 0, cases: [] };
  const texts = kept.filter((p) => p.a?.ok && typeof p.a.value === 'string' && p.a.value.trim().length > 60);
  for (const p of texts.slice(0, 2)) {
    const t = p.a.value;
    const variant = t.replace(/\s+/, '  ');
    if (variant.trim() !== t.trim()) {
      const j = await judgeQuality(askOf(p.body), variant, t, { scope });
      addJudge(j.cost);
      if (!j.transient && j.score !== null) {
        out.same += 1;
        if (j.score !== 0) { out.errors += 1; out.cases.push('an answer with only its spacing changed read as worse'); }
      }
    }
    const words = t.trim().split(/\s+/);
    if (words.length < 30) continue;
    const cut = words.slice(0, Math.ceil(words.length / 3)).join(' ');
    const k = await judgeQuality(askOf(p.body), cut, t, { scope });
    addJudge(k.cost);
    if (k.transient || k.score === null) continue;
    out.different += 1;
    if (k.score !== 1) { out.errors += 1; out.cases.push('an answer cut to its first third read as at least as good'); }
  }
  return out;
}

/* What the call asked, for the judge to weigh answers against. */
function askOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map((x) => x?.text || '').join(' ') : '');
    return `${m.role}: ${c}`;
  }).join('\n').slice(0, 4000);
}
