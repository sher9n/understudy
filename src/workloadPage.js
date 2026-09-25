import { db, now, round8 } from './db/index.js';
import config from './config.js';
import { withFee } from './billing.js';
import { barNeed, usableCalls, sampleSizeFor } from './eval/plan.js';
import { valueOf, optimizingSince } from './eval/value.js';
import { routedSavings } from './eval/actual.js';
import { cadenceOf } from './eval/schedule.js';
import { outcomeOf } from './eval/outcome.js';
import { canJudge } from './eval/judge.js';
import { servingKey } from './eval/promote.js';
import { controlRecord, barOf } from './learn/control.js';
import { nameOfResult, armById, labelOf } from './learn/arms.js';

/* A workload's page, as the four questions it answers at a glance (web/src/screens/WorkloadPage.jsx):
 *   enough        is there enough of its traffic to optimize it, counted the way a test counts it, and if not,
 *                 how the rest can arrive (at most EVAL_POOL_PER_DAY count from any one day) and so the earliest
 *                 a test can start;
 *   measurements  every measurement it has had, each with what it found in a word;
 *   calls         its calls, newest first, and who answered each;
 * and once it is switched,
 *   doing         what Understudy does with each of its requests now, and what that saves, costs, keeps and
 *                 risks, read from the record (src/eval/value.js, the daily checks in src/learn/control.js).
 * One measurement opened (runPageOf) is the sentence of what it found and every setup it tried, placed by what
 * it costs a call against how often it answered differently from the customer's own model, or worse.
 * The page only draws: every figure is worked out here, the way the rest of the app counts it. */

const DAY = 86400000;
const IST = 5.5 * 3600000;
const short = (m) => String(m || '').split('/').pop();
// a try that failed and was answered another way: not one of the customer's requests (see src/eval/value.js)
const TRY = `COALESCE(check_json LIKE '%"by":"fell back"%' OR check_json LIKE '%"by":"experiment failed"%', FALSE)`;

/* Requests a day over the last thirty days, by the day a test counts them in (created_at / DAY, which is UTC):
   every request, and the ones a test counts, which are the customer's own with their text kept and not failed,
   at most EVAL_POOL_PER_DAY from a day (eligible in src/eval/plan.js). */
async function dailyOf(w, t) {
  const today = Math.floor(t / DAY);
  const rows = await db.prepare(
    `SELECT (created_at / 86400000) AS d,
            COUNT(*) FILTER (WHERE NOT ${TRY}) AS n,
            COUNT(*) FILTER (WHERE request_json IS NOT NULL AND (status_code IS NULL OR status_code < 400)) AS usable
       FROM calls WHERE workload_id = ? AND source NOT IN ('replay', 'test') AND created_at >= ?
      GROUP BY 1`).all(w.id, (today - 29) * DAY);
  const by = new Map(rows.map((r) => [Number(r.d), r]));
  return Array.from({ length: 30 }, (_, k) => {
    const d = today - 29 + k;
    const r = by.get(d);
    return { d, n: Number(r?.n || 0), counted: Math.min(Number(r?.usable || 0), config.EVAL_POOL_PER_DAY) };
  });
}

/* How the rest of the requests a test needs can arrive, at most `perDay` a day: what today can still add, then
   each day after it. The last step's day is the earliest the test can start. */
export function stepsTo(have, need, today, perDay) {
  const steps = [];
  let at = have;
  let d = today.d;
  let room = Math.max(0, perDay - today.counted);
  for (let k = 0; k < 60 && at < need; k += 1) {
    if (room > 0) {
      const to = Math.min(need, at + room);
      steps.push({ from: at, to, d, today: d === today.d });
      at = to;
    }
    d += 1;
    room = perDay;
  }
  return steps;
}

/* 1. Enough data to optimize? */
async function enoughOf(w, t) {
  const perDay = config.EVAL_POOL_PER_DAY;
  const every = await cadenceOf(w.workspace_id);
  const daily = await dailyOf(w, t);
  const have = await usableCalls(w);
  // what it was left waiting for, where a test was turned down already, and otherwise what its bar takes
  const need = Number(w.measure_at_calls) > 0 ? Number(w.measure_at_calls) : barNeed(w).calls;
  const yes = have >= need;
  const last = await db.prepare('SELECT created_at FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(w.id);
  // when it is next tested by itself: its own booking, or the workspace's rhythm after its last test
  const nextAt = !every ? null : w.recheck_after ? Number(w.recheck_after)
    : last ? Number(last.created_at) + every * DAY : null;
  const steps = yes ? [] : stepsTo(have, need, daily[daily.length - 1], perDay);
  return {
    yes, have, need, perDay,
    total: daily.reduce((a, x) => a + x.n, 0),
    daily,
    steps,
    earliest: steps.length ? steps[steps.length - 1].d : null,
    // how many of them a test uses
    sample: sampleSizeFor(have),
    everyDays: every,
    nextAt,
  };
}

/* What a setup is called where there is room for a few words: the flow's box. */
function shortSetup(spec, reference) {
  if (!spec) return null;
  if (spec.kind === 'cascade') return short(spec.first?.model);
  if (spec.kind === 'router' && Array.isArray(spec.options)) {
    return spec.options.length === 1 ? short(spec.options[0].model) : `${spec.options.length} setups`;
  }
  if (spec.kind === 'router') return short(spec.cheap?.model);
  if (spec.model === reference && spec.recipe?.reasoning) return `${short(spec.model)}, lighter`;
  if (spec.model === reference && spec.recipe?.pinned) return `${short(spec.model)}, cheaper`;
  return short(spec.model);
}

/* What Understudy is doing for a switched workload: how its requests flow now, what that saved this month and
   is on track to save, what a request costs before and now, how its answers compare with the customer's own
   model's in the daily checks, how fast they come, and what happens if it slips. */
async function doingOf(w, v, t) {
  if (!w.routed_model) return null;
  const ref = w.reference_model;
  const arm = w.routed_arm_id ? await armById(w.routed_arm_id) : null;
  const spec = arm?.spec ?? { kind: 'model', model: w.routed_model, recipe: null };
  const kind = spec.kind === 'cascade' ? 'cascade'
    : spec.kind === 'router' ? (Array.isArray(spec.options) ? 'sorted' : 'router') : 'model';
  const at = Number(w.promoted_at) || t;

  // who answered its requests since the switch (the last week at most): the cheaper setup, or the customer's own model
  const since = Math.max(t - 7 * DAY, at);
  const served = await db.prepare(
    `SELECT COUNT(*) AS n,
            COUNT(*) FILTER (WHERE (arm_id = ? OR (arm_id IS NULL AND served_model = ? AND served_model <> ?))
                             AND COALESCE(escalated, 0) = 0 AND COALESCE(explored, 0) = 0) AS cheap
       FROM calls WHERE workload_id = ? AND source = 'routed' AND status_code = 200 AND created_at >= ? AND NOT ${TRY}`)
    .get(w.routed_arm_id ?? '', w.routed_model, ref ?? '', w.id, since);
  const n = Number(served?.n || 0);

  /* Saved this month, in India's calendar, testing taken off. And what a month comes to at the pace of the whole days
     since the switch (a week at most), less what testing cost over the last thirty days: testing comes in lumps, a
     measurement every few weeks, and a lump inside a week's window read as four of them a month. */
  const ist = new Date(t + IST);
  const monthStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST;
  const mdays = Math.max(1, Math.ceil((t - monthStart) / DAY));
  const month = await routedSavings({ workspaceId: w.workspace_id, workloadId: w.id, days: mdays, at: monthStart + mdays * DAY });
  const savedMonth = month.would - month.paid - await optimizingSince(w.id, monthStart);
  const pdays = Math.max(1, Math.min(7, Math.floor((t - at) / DAY)));
  const pace = await routedSavings({ workspaceId: w.workspace_id, workloadId: w.id, days: pdays, at: t });
  const onTrack = ((pace.would - pace.paid) / pdays) * 30 - await optimizingSince(w.id, t - 30 * DAY);

  // the daily checks against the customer's own model, a day at a time (India's days), by the yardstick of its bar
  const control = await controlRecord(w);
  const bar = await barOf(w);
  const from = Math.max(at, t - config.CONTROL_WINDOW_DAYS * DAY);
  const checks = w.routed_arm_id ? await db.prepare(
    `SELECT ((created_at + ${IST}) / 86400000) AS d, COUNT(*) AS n, COALESCE(SUM(score), 0) AS worse
       FROM control_checks WHERE workload_id = ? AND arm_id = ? AND created_at >= ? AND score IS NOT NULL AND yardstick = ?
      GROUP BY 1 ORDER BY 1`).all(w.id, w.routed_arm_id, from, bar.yardstick) : [];
  const checkedPerDay = checks.reduce((a, c) => a + Number(c.n), 0) / Math.max(1, (t - from) / DAY);
  const perDay = Number(v.paths.perDay) || 0;

  const before = v.paths.ownPerCall;
  const after = v.paths.perCall;
  return {
    kind,
    label: labelOf(spec, ref),
    cheap: shortSetup(spec, ref),
    reference: ref,
    switchedAt: Number(w.promoted_at) || null,
    // set up, and waiting for the first request that comes through Understudy: its requests reach us only as copies
    waiting: !!v.waiting,
    perDay: round8(perDay),
    share: n > 0 ? round8(Number(served.cheap) / n) : null,
    served: n,
    rollout: w.rollout_share === null || w.rollout_share === undefined ? null : Number(w.rollout_share),
    savedMonth: round8(savedMonth),
    onTrack: round8(onTrack),
    before, after,
    less: before > 0 && after !== null && after !== undefined ? round8(Math.max(0, 1 - after / before)) : null,
    checks: {
      yardstick: bar.yardstick,
      bar: round8(bar.floorPct / 100),
      n: control?.n ?? 0,
      rate: control ? round8(control.rate) : null,
      daily: checks.slice(-30).map((c) => round8(Number(c.worse) / Math.max(1, Number(c.n)))),
      share: perDay > 0 && checkedPerDay > 0 ? round8(Math.min(1, checkedPerDay / perDay)) : null,
      perDay: round8(checkedPerDay),
    },
    speed: { metric: v.speed.metric, now: v.speed.now?.ms ?? null, before: v.speed.before?.ms ?? null },
  };
}

// how many of the answers planted to test a measurement's judge it got wrong
const judgeErrors = (run) => {
  try { return Number(JSON.parse(run.judge_check_json || 'null')?.errors) || 0; } catch { return 0; }
};

/* A measurement as a line in the list: what started it, and what it found, in a word. */
function tagOf(r, sum, w) {
  const outcome = outcomeOf(r);
  if (r.status === 'running') return { tone: 'brand', text: 'Measuring now' };
  if (r.status === 'queued') return { tone: 'brand', text: 'Waiting to start' };
  if (outcome === 'stopped') return { tone: 'mut', text: 'Stopped' };
  if (outcome === 'interrupted') return { tone: 'mut', text: 'Interrupted' };
  if (outcome === 'unmeasurable') return { tone: 'bad', text: 'Could not measure' };
  if (outcome === 'refused') return { tone: 'bad', text: 'Your model could not answer' };
  if (outcome === 'no_balance') return { tone: 'warn', text: 'Balance ran out' };
  if (w.routed_model && w.promoted_run_id === r.id) return { tone: 'brand', text: 'Passed, switched' };
  if (Number(sum?.kept) > 0) return { tone: 'ok', text: 'Still as good' };
  if (Number(sum?.twice) > 0) return { tone: 'ok', text: 'Passed twice' };
  const cleared = Number(sum?.cleared) || 0;
  if (cleared > 0) return { tone: 'ok', text: `${cleared} ${cleared === 1 ? 'setup' : 'setups'} cleared` };
  // held back only because the judge got answers planted to test it wrong (see candOf)
  if (Number(sum?.within) > 0 && judgeErrors(r) > 0) return { tone: 'warn', text: 'Passed, judge unsure' };
  if (Number(sum?.close) > 0) return { tone: 'warn', text: 'Close' };
  return { tone: 'mut', text: 'Nothing cleared yet' };
}

/* 2. Every measurement, newest first. */
async function measurementsOf(w) {
  const runs = await db.prepare(
    `SELECT id, status, outcome, error, trigger, sample_size, spend_usd, created_at, started_at, finished_at, floor_pct, judge_check_json
       FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 30`).all(w.id);
  if (!runs.length) return [];
  const first = await db.prepare('SELECT id FROM eval_runs WHERE workload_id = ? ORDER BY created_at LIMIT 1').get(w.id);
  const serving = w.routed_model ? await servingKey(w) : null;
  const sums = await db.prepare(
    `SELECT e.run_id,
            COUNT(*) FILTER (WHERE e.verdict = 'cleared' AND e.model_id <> ?) AS cleared,
            COUNT(*) FILTER (WHERE e.verdict = 'review' AND e.model_id <> ?) AS close,
            COUNT(*) FILTER (WHERE e.verdict = 'cleared' AND e.confirm_verdict IN ('cleared', 'live') AND e.model_id <> ?) AS twice,
            COUNT(*) FILTER (WHERE e.verdict = 'cleared' AND e.model_id = ?) AS kept,
            COUNT(*) FILTER (WHERE e.verdict = 'review' AND e.model_id <> ? AND r.floor_pct IS NOT NULL
              AND COALESCE(e.gap_hi, e.gap_pct) <= r.floor_pct) AS within
       FROM eval_results e JOIN eval_runs r ON r.id = e.run_id
      WHERE e.run_id = ANY(?::text[]) AND e.verdict <> 'reference' GROUP BY e.run_id`)
    .all(serving ?? '', serving ?? '', serving ?? '', serving ?? '', serving ?? '', runs.map((r) => r.id));
  const sumOf = new Map(sums.map((s) => [s.run_id, s]));
  return runs.map((r) => {
    const start = Number(r.started_at || r.created_at);
    return {
      id: r.id,
      at: start,
      what: r.trigger === 'manual' ? 'Started by you' : (r.trigger === 'first' || r.id === first?.id) ? 'First test' : 'Regular re-test',
      n: Number(r.sample_size) || 0,
      mins: r.finished_at ? Math.max(1, Math.round((Number(r.finished_at) - start) / 60000)) : null,
      // what it cost the customer, our fee included, as they were charged for it (chargeEval)
      usd: withFee(Number(r.spend_usd) || 0),
      live: r.status === 'running' || r.status === 'queued',
      tag: tagOf(r, sumOf.get(r.id), w),
    };
  });
}

/* 3. The calls, newest first, `per` at a time: when, who answered, how long it took, what it cost, and how it went. */
export async function callsOf(w, { page = 1, per = 10 } = {}) {
  const t = now();
  const p = Math.max(1, Math.min(1000, Math.round(Number(page) || 1)));
  const ref = w.reference_model ?? '';
  const where = `workload_id = ? AND source IN ('routed', 'trace') AND NOT ${TRY}`;
  const from = t - 30 * DAY;
  // the share the cheaper setup answered is read since the switch: before it, nothing could have
  const since = Math.max(from, Number(w.promoted_at) || 0);
  const sum = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN charged_usd > 0 THEN charged_usd ELSE cost_usd END), 0) AS cost,
            COUNT(*) FILTER (WHERE served_model IS NOT NULL AND served_model <> ?) AS others,
            COUNT(*) FILTER (WHERE source = 'routed' AND status_code = 200 AND created_at >= ?) AS ok,
            COUNT(*) FILTER (WHERE source = 'routed' AND status_code = 200 AND created_at >= ? AND arm_id IS NOT NULL AND arm_id = ?
                             AND COALESCE(escalated, 0) = 0 AND COALESCE(explored, 0) = 0) AS cheap
       FROM calls WHERE ${where} AND created_at >= ?`).get(ref, since, since, w.routed_arm_id ?? '', w.id, from);
  const rows = await db.prepare(
    `SELECT id, created_at, source, served_model, requested_model, status_code, latency_ms, charged_usd, cost_usd,
            arm_id, escalated, explored
       FROM calls WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(w.id, per + 1, (p - 1) * per);
  return {
    total: Number(sum.n),
    cost: round8(Number(sum.cost)),
    // of the requests that came through us and were answered since the switch, the share the cheaper setup answered
    cheapShare: w.routed_model && Number(sum.ok) > 0 ? round8(Number(sum.cheap) / Number(sum.ok)) : 0,
    cheapSince: since > from ? since : null,
    // whether every one of them was answered by the customer's own model
    ownOnly: Number(sum.others) === 0,
    page: p,
    more: rows.length > per,
    rows: rows.slice(0, per).map((c) => {
      const model = c.served_model || c.requested_model || null;
      const cheap = !!w.routed_arm_id && c.arm_id === w.routed_arm_id && Number(c.escalated) !== 1 && Number(c.explored) !== 1;
      return {
        id: c.id,
        at: Number(c.created_at),
        model,
        who: cheap ? 'cheap' : (!model || model === ref) ? 'yours' : 'other',
        copy: c.source === 'trace',
        sentOn: Number(c.escalated) === 1,
        experiment: Number(c.explored) === 1,
        ms: c.latency_ms === null || c.latency_ms === undefined ? null : Number(c.latency_ms),
        cost: round8(Number(c.charged_usd) > 0 ? Number(c.charged_usd) : Number(c.cost_usd) || 0),
        status: c.status_code === null || c.status_code === undefined ? null : Number(c.status_code),
      };
    }),
  };
}

/** Everything a workload's page draws, beside its detail (GET /api/workloads/:id). */
export async function pageOf(w) {
  const t = now();
  // what a switch does is only read for a workload that has one: the rest of the page never needs it
  const v = w.routed_model ? await valueOf(w) : null;
  return {
    kind: w.shape_kind,
    enough: await enoughOf(w, t),
    doing: v ? await doingOf(w, v, t) : null,
    measurements: await measurementsOf(w),
    calls: await callsOf(w),
    feePct: config.ROUTING_FEE_PCT,
    at: t,
  };
}

/* One setup in a measurement, as its row: what it is called, how many requests it answered, how often it answered
   differently (or worse), the range that could be, what a request costs on it, how fast it answered, and its result. */
function candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure = false, floorPct = null }) {
  const name = nameOfResult(r);
  const n = Number(r.runs) || 0;
  const isServing = !!serving && r.model_id === serving;
  let tone;
  let verdict;
  if (r.verdict === 'failed') [tone, verdict] = ['bad', 'Could not answer'];
  else if (r.verdict === 'slower') [tone, verdict] = ['warn', 'Slower than yours'];
  // what serves, checked again; in the measurement that switched to it, it was a candidate like the rest
  else if (isServing && !switchRun && r.verdict === 'cleared') [tone, verdict] = ['ok', 'Keeps serving'];
  else if (r.stopped && n < sample) [tone, verdict] = ['mut', 'Stopped early'];
  else if (r.verdict === 'cleared' && (r.confirm_verdict === 'cleared' || r.confirm_verdict === 'live')) [tone, verdict] = ['ok', 'Passed twice'];
  else if (r.verdict === 'cleared') [tone, verdict] = ['ok', 'Cleared'];
  /* Held back only because the judge missed an answer planted as clearly worse (see chooseJudge in src/eval/run.js):
     it kept the bar as the judge read it, which is not "close". */
  else if (r.verdict === 'review' && unsure && floorPct !== null && Number(r.gap_hi ?? r.gap_pct) <= floorPct) {
    [tone, verdict] = ['warn', 'Passed, judge unsure'];
  } else if (r.verdict === 'review') {
    [tone, verdict] = Number(r.calls_needed) > n ? ['warn', 'Too few to be sure'] : ['warn', isServing && !switchRun ? 'Close, still serving' : 'Close'];
  } else if (r.verdict === 'insufficient') [tone, verdict] = ['warn', 'Too few to be sure'];
  else [tone, verdict] = ['bad', 'Missed'];
  const ratio = r.cost_ratio === null || r.cost_ratio === undefined ? null : Number(r.cost_ratio);
  const perCall = ratio !== null && refPer ? ratio * refPer : (name.kind === 'model' ? avg.get(r.model_id) ?? null : null);
  const ms = metric === 'ttft' ? Number(r.ttft_p50) || null : Number(r.latency_p50) || null;
  const pct = (x) => (x === null || x === undefined ? null : round8(Number(x) / 100));
  const judged = r.verdict !== 'failed' && r.gap_pct !== null && r.gap_pct !== undefined && n > 0;
  return {
    key: r.model_id,
    // a model by its full name, a way of serving by what it does
    label: name.kind === 'model' ? r.model_id
      : name.kind === 'cascade' ? `${name.first}, checked`
        : name.kind === 'router' && name.version === 2 ? name.short
          : name.kind === 'router' ? `${name.first}, picked per call` : name.label,
    kind: name.kind,
    n,
    gap: judged ? pct(r.gap_pct) : null,
    lo: judged ? pct(r.gap_lo ?? r.gap_pct) : null,
    hi: judged ? pct(r.gap_hi ?? r.gap_pct) : null,
    perCall: perCall === null ? null : round8(perCall),
    p50: ms,
    tone, verdict,
    serving: isServing,
    twice: verdict === 'Passed twice',
    confirmRuns: Number(r.confirm_runs) || 0,
  };
}

const TONE_ORDER = { ok: 0, warn: 1, bad: 2, mut: 3 };
const z2 = 1.6449 ** 2;
const pctWords = (x) => `${Math.round(x * 1000) / 10}%`;

/* The sentence at the top of an opened measurement: what it found, and what happens because of it. Where answers were
   held to "at least as good" rather than "the same", or the judge was not trusted, a sentence more says so. */
function takeOf(run, cands, w, { reachNeed, check }) {
  const main = mainTake(run, cands, w, { reachNeed });
  const outcome = outcomeOf(run);
  const compared = !['unmeasurable', 'refused', 'no_balance'].includes(outcome) && !(run.status === 'running' || run.status === 'queued');
  const notes = [];
  if (compared && run.yardstick === 'quality' && cands.length) {
    notes.push(`Because ${short(run.reference_model)} answers the same request differently each time, each setup was held to answers `
      + 'at least as good as yours rather than to the same answers.');
  }
  if (compared && Number(check?.errors) > 0 && cands.length) {
    const planted = Number(check.planted) || Number(check.errors);
    notes.push(`The judge was first tested on ${planted} answers whose right verdict is already known, and it got ${check.errors} wrong, `
      + 'so nothing is switched on its word. The next measurement tests the judge again.');
  }
  return [main, ...notes].join(' ');
}

function mainTake(run, cands, w, { reachNeed }) {
  const ref = short(run.reference_model);
  const outcome = outcomeOf(run);
  const n = Number(run.sample_size) || 0;
  if (run.status === 'running' || run.status === 'queued') return 'Still running. Each setup appears here once it has answered its requests.';
  if (outcome === 'unmeasurable') {
    return `${ref} gave a different answer to the same request ${Math.round(Number(run.noise_pct) || 0)}% of the time when asked each of ${n} twice, `
      + 'so there was no steady bar to hold a cheaper setup to. Nothing was tried, and nothing switched.'
      + (canJudge() && config.EVAL_QUALITY_YARDSTICK
        ? ' Workloads like this are now held to answers at least as good as yours instead, so the next measurement compares setups.' : '');
  }
  if (outcome === 'refused') return `${ref} could not answer most of these requests, so there was no bar to hold a cheaper setup to. Nothing switched.`;
  if (outcome === 'no_balance') return 'The balance ran out once the bar was set, so nothing was tried. Add credit and it can run again.';
  const stopped = outcome === 'stopped' || outcome === 'interrupted';
  if (stopped && !cands.length) {
    return `${outcome === 'stopped' ? 'Stopped' : 'Interrupted'} before any setup had answered all of its requests, so there is nothing to compare. Nothing switched.`;
  }
  const said = stopped ? `${outcome === 'stopped' ? 'Stopped' : 'Interrupted'} before it finished, so nothing switched. ` : '';
  if (w.routed_model && w.promoted_run_id === run.id) {
    // the one it switched to is the one serving now, not merely the first that passed
    const won = cands.find((c) => c.serving) || cands.find((c) => c.twice) || cands.find((c) => c.tone === 'ok');
    if (won) {
      return won.confirmRuns
        ? `Asked again on ${won.confirmRuns} requests it had never seen, ${won.label} held up. Understudy switched to it.`
        : `${won.label} cleared the bar, and Understudy switched to it.`;
    }
  }
  const kept = cands.find((c) => c.serving && c.tone === 'ok');
  if (kept) {
    const cheaper = cands.filter((c) => !c.serving && c.tone === 'ok').length;
    return `${said}The setup serving still answers at least as well as ${ref}.`
      + (cheaper ? ` ${cheaper === 1 ? 'A cheaper one' : `${cheaper} cheaper ones`} cleared too.` : ' Nothing cheaper passed, so nothing changes.');
  }
  const twice = cands.find((c) => c.twice);
  if (twice) return `${said}${twice.label} passed twice, on these requests and on new ones it had never seen.`;
  const cleared = cands.filter((c) => c.tone === 'ok');
  if (cleared.length) {
    return `${said}${cleared.length === 1 ? 'One setup' : `${cleared.length} setups`} cleared the bar. `
      + 'A setup is asked again on new requests before anything switches.';
  }
  const bar = Number(run.floor_pct) || 0;
  // the closest a count this size can get a setup to showing it keeps the bar, with every answer matching
  const reach = n > 0 ? (z2 / (n + z2)) * 100 : 100;
  if (n > 0 && bar > 0 && reach > bar) {
    return `${said}${n} requests can show a setup is within about ${Math.round(reach)}% of yours, not within ${Math.round(bar)}%.`
      + (reachNeed ? ` The full test starts by itself at ${reachNeed}.` : '');
  }
  // kept the bar as the judge read it, and held back only because the judge was not trusted (see candOf)
  const unsure = cands.find((c) => c.verdict === 'Passed, judge unsure' && c.gap !== null);
  if (unsure) {
    return `${said}${unsure.label} kept the bar as the judge read it: ${run.yardstick === 'quality' ? 'worse' : 'different'} on `
      + `${pctWords(unsure.gap)} of them, against a bar of ${Math.round(bar * 10) / 10}%.`;
  }
  const close = cands.find((c) => c.tone === 'warn' && c.gap !== null);
  if (close) {
    const how = run.yardstick === 'quality' ? 'gave a worse answer' : 'answered differently';
    return `${said}The closest, ${close.label}, ${how} on ${pctWords(close.gap)} of them, against a bar of ${Math.round(bar * 10) / 10}%.`
      + ' It is looked at again next time.';
  }
  return `${said}No cheaper setup answered as well as ${ref} on these ${n} requests.`;
}

/** One measurement opened: what it found, in a sentence, and every setup it tried. */
export async function runPageOf(w, run) {
  const results = await db.prepare(`SELECT * FROM eval_results WHERE run_id = ? AND verdict <> 'reference'`).all(run.id);
  // what a request cost on each model in this measurement, from its own answers, reused ones left out
  const costs = await db.prepare(
    `SELECT model_id, AVG(cost_usd) AS per FROM eval_replays WHERE run_id = ? AND reused = 0 AND cost_usd > 0
        AND (status IS NULL OR status < 400) GROUP BY model_id`).all(run.id);
  const avg = new Map(costs.map((c) => [c.model_id, Number(c.per)]));
  // the customer's own model's, from this measurement, or from its real requests in the month before it
  let refPer = avg.get(run.reference_model) ?? null;
  if (!refPer) {
    const own = await db.prepare(
      `SELECT AVG(cost_usd) AS per FROM calls WHERE workload_id = ? AND served_model = ? AND status_code = 200 AND cost_usd > 0
          AND source IN ('routed', 'trace') AND created_at >= ? AND created_at <= ?`)
      .get(w.id, run.reference_model, Number(run.created_at) - 30 * DAY, Number(run.finished_at || run.created_at));
    refPer = Number(own?.per) > 0 ? Number(own.per) : null;
  }
  let plan = null;
  try { plan = run.plan_json ? JSON.parse(run.plan_json) : null; } catch { plan = null; }
  const metric = plan?.speed?.metric === 'ttft' && Number(run.ref_ttft_p50) > 0 ? 'ttft' : 'latency';
  const serving = w.routed_model ? await servingKey(w) : null;
  const sample = Number(run.sample_size) || 0;
  const switchRun = !!w.routed_model && w.promoted_run_id === run.id;
  let check = null;
  try { check = run.judge_check_json ? JSON.parse(run.judge_check_json) : null; } catch { check = null; }
  const unsure = Number(check?.errors) > 0;
  const floorPct = run.floor_pct === null || run.floor_pct === undefined ? null : Number(run.floor_pct);
  const cands = results.map((r) => candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure, floorPct }))
    .sort((a, b) => (TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
      || ((a.gap ?? 2) - (b.gap ?? 2)) || ((a.perCall ?? 1) - (b.perCall ?? 1)));
  // for a measurement too small to show anything, the count the full test waits for
  const reachNeed = !w.routed_model && Number(w.measure_at_calls) > 0 ? Number(w.measure_at_calls) : null;
  return {
    id: run.id,
    take: takeOf(run, cands, w, { reachNeed, check }),
    bar: round8((Number(run.floor_pct) || 0) / 100),
    yardstick: run.yardstick === 'quality' ? 'quality' : 'agreement',
    metric,
    reference: run.reference_model,
    yours: {
      perCall: refPer === null ? null : round8(refPer),
      p50: metric === 'ttft' ? Number(run.ref_ttft_p50) || null : Number(run.ref_latency_p50) || null,
    },
    cands: cands.map(({ twice, confirmRuns, ...c }) => c),
    self: selfOf(run, plan),
  };
}

/* What a measurement that compared nothing can still be drawn from: how often the customer's own model's two answers
   to one request differed (or, held to "at least as good", how often one was clearly worse), against the pass mark it
   set, or against the most a bar could be set from where it could not set one; and how far it got. */
function selfOf(run, plan) {
  const share = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : round8(Number(x) / 100));
  const outcome = outcomeOf(run);
  return {
    outcome,
    n: Number(run.sample_size) || 0,
    noise: share(run.noise_pct),
    agreement: share(plan?.yardstick?.agreementNoisePct),
    bar: outcome === 'unmeasurable' ? null : share(run.floor_pct),
    most: outcome === 'unmeasurable' ? round8(config.EVAL_NOISE_MAX_PCT / 100) : null,
    done: Number(run.steps_done) || 0,
    total: Number(run.steps_total) || 0,
  };
}
