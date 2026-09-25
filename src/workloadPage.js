import { db, now, round8 } from './db/index.js';
import config from './config.js';
import { withFee } from './billing.js';
import { barNeed, usableCalls, sampleSizeFor } from './eval/plan.js';
import { callsToClear } from './eval/compare.js';
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
 * One test opened (runPageOf) is the sentence of what it found and every model it tried, placed by what a request
 * costs on it against how often it answered differently from the original model, or worse.
 * The page only draws: every figure is worked out here, the way the rest of the app counts it. Its words keep one
 * noun for each thing, as the page does: requests (never calls), a test (never a measurement), a model (whatever
 * way of serving it is), the original model (the customer's own), and the allowed difference (never the bar). */

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
    return spec.options.length === 1 ? short(spec.options[0].model) : `${spec.options.length} models`;
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

// how many of the answers planted to test a test's judge it got wrong
const judgeErrors = (run) => {
  try { return Number(JSON.parse(run.judge_check_json || 'null')?.errors) || 0; } catch { return 0; }
};

// a test whose requests were too few for any model to be shown close enough, however well it matched
const tooSmall = (run) => {
  const n = Number(run.sample_size) || 0;
  const bar = Number(run.floor_pct) || 0;
  return n > 0 && bar > 0 && (z2 / (n + z2)) * 100 > bar;
};

/* A test as a line in the list: what it found, in a few words, and what that means, said when the tag is hovered.
   A test that ends without comparing anything says which way it ended, rather than "could not measure". */
function tagOf(r, sum, w) {
  const outcome = outcomeOf(r);
  const tag = (tone, text, why) => ({ tone, text, why });
  if (r.status === 'running') return tag('brand', 'Testing now', 'This test is running now.');
  if (r.status === 'queued') return tag('brand', 'Waiting to start', 'This test is waiting for its turn to start.');
  if (outcome === 'stopped') return tag('mut', 'Stopped', 'This test was stopped before it finished, so nothing was switched.');
  if (outcome === 'interrupted') {
    return tag('mut', 'Test incomplete', 'This test stopped partway, because a provider was too busy or something failed on our side. '
      + 'It tries again by itself, and nothing was switched.');
  }
  if (outcome === 'unmeasurable') {
    return tag('bad', "Couldn't compare models", 'The original model gave a different answer to the same request so often that there was '
      + 'no steady standard to compare other models with.');
  }
  if (outcome === 'refused') {
    return tag('bad', 'Not enough valid results', "The original model couldn't answer most of this test's requests when they were run "
      + 'again, so there were too few valid answers to compare other models with.');
  }
  if (outcome === 'no_balance') return tag('warn', 'Balance ran out', "The balance ran out partway, so the test couldn't finish. Add credit and it can run again.");
  if (w.routed_model && w.promoted_run_id === r.id) return tag('brand', 'Passed, switched', 'A cheaper model passed, and Understudy switched to it.');
  if (Number(sum?.kept) > 0) return tag('ok', 'Still passing', 'The model in use was tested again and is still within the allowed difference.');
  if (Number(sum?.twice) > 0) {
    return tag('ok', 'Passed twice', "A cheaper model passed on this test's requests, and again on new requests it had never seen.");
  }
  const cleared = Number(sum?.cleared) || 0;
  if (cleared > 0) {
    return tag('ok', `${cleared} ${cleared === 1 ? 'model' : 'models'} passed`,
      'A model that passes is tested again on new requests before anything switches.');
  }
  // held back only because the judge got answers planted to test it wrong (see candOf)
  if (Number(sum?.within) > 0 && judgeErrors(r) > 0) {
    return tag('warn', 'Passed, judge unsure', 'A model passed as the judge read it, but the judge got some answers wrong when it was '
      + 'checked, so nothing switches on its word.');
  }
  if (Number(sum?.close) > 0) return tag('warn', 'Close match', "A model came close, but the test isn't yet sure it stays within the allowed difference.");
  if (tooSmall(r)) {
    return tag('warn', 'Too few to decide', 'This test had too few requests to show that any model is close enough. The full test '
      + 'starts by itself once there are enough.');
  }
  return tag('mut', 'No match yet', 'No cheaper model came close enough to the original model in this test.');
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
      what: r.trigger === 'manual' ? 'Started manually' : (r.trigger === 'first' || r.id === first?.id) ? 'First test' : 'Regular re-test',
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

/* One model in a test, as its row: what it is called, how many requests it answered, how often it answered differently
   (or worse), what a request costs on it, how fast it answered, and its outcome, in the words of why it did or did not
   qualify, with a sentence that says so (why). `said` is how a sentence names it: a model by the name people know it by. */
const TOO_FEW = "It answered too few requests for the test to be sure whether it stays within the allowed difference. It's tested again once there are more.";
function candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure = false, floorPct = null, quality = false, names = new Map() }) {
  const name = nameOfResult(r);
  const n = Number(r.runs) || 0;
  const isServing = !!serving && r.model_id === serving;
  const differs = quality ? "gave clearly worse answers than the original model's" : 'answered differently from the original model';
  let out;
  if (r.verdict === 'failed') {
    out = ['bad', 'Failed requests', "The model's provider refused or failed some of this test's requests, so it can't be relied on for this workload."];
  } else if (r.verdict === 'slower') {
    out = ['warn', 'Slower than original', 'It answered more slowly than the original model, by more than this workload allows.'];
  } else if (isServing && !switchRun && r.verdict === 'cleared') {
    // what serves, checked again; in the test that switched to it, it was a model like the rest
    out = ['ok', 'Still passing', 'This is the model answering this workload now. It was tested again and is still within the allowed difference.'];
  } else if (r.stopped && n < sample) {
    out = r.stopped === 'bar'
      ? ['bad', 'Clearly not a match', 'Testing stopped early because the model was already different enough that more requests were very unlikely to change the result.']
      : r.stopped === 'budget'
        ? ['mut', 'Stopped early', 'The test reached the most it may spend before this model had answered every request.']
        : ['mut', 'Stopped early', 'The test was stopped before this model had answered every request.'];
  } else if (r.verdict === 'cleared' && (r.confirm_verdict === 'cleared' || r.confirm_verdict === 'live')) {
    out = ['ok', 'Passed twice', "It stayed within the allowed difference on this test's requests, and again on new requests it had never seen."];
  } else if (r.verdict === 'cleared') {
    out = ['ok', 'Passed once', "It stayed within the allowed difference on this test's requests. It's tested again on new requests before anything switches."];
  } else if (r.verdict === 'review' && unsure && floorPct !== null && Number(r.gap_hi ?? r.gap_pct) <= floorPct) {
    /* Held back only because the judge missed an answer planted as clearly worse (see chooseJudge in src/eval/run.js):
       it stayed within the allowed difference as the judge read it, which is not "close". */
    out = ['warn', 'Passed, judge unsure', 'It stayed within the allowed difference as the judge read it, but the judge got some answers wrong when it was checked, so nothing switches on its word.'];
  } else if (r.verdict === 'review' && Number(r.calls_needed) > n) {
    out = ['warn', 'Too few to be sure', TOO_FEW];
  } else if (r.verdict === 'review') {
    out = ['warn', isServing && !switchRun ? 'Close match, still in use' : 'Close match',
      "This model came closest to meeting the requirement, but the test isn't yet confident that it stays within the allowed difference."];
  } else if (r.verdict === 'insufficient') {
    out = ['warn', 'Too few to be sure', TOO_FEW];
  } else {
    out = ['bad', 'Not a match', `It ${differs} more often than allowed.`];
  }
  const [tone, verdict, why] = out;
  const ratio = r.cost_ratio === null || r.cost_ratio === undefined ? null : Number(r.cost_ratio);
  const perCall = ratio !== null && refPer ? ratio * refPer : (name.kind === 'model' ? avg.get(r.model_id) ?? null : null);
  const ms = metric === 'ttft' ? Number(r.ttft_p50) || null : Number(r.latency_p50) || null;
  const pct = (x) => (x === null || x === undefined ? null : round8(Number(x) / 100));
  const judged = r.verdict !== 'failed' && r.gap_pct !== null && r.gap_pct !== undefined && n > 0;
  const label = name.kind === 'model' ? r.model_id
    : name.kind === 'cascade' ? `${name.first}, checked`
      : name.kind === 'router' && name.version === 2 ? name.short
        : name.kind === 'router' ? `${name.first}, picked per request` : name.label;
  const known = (id) => names.get(id) || String(id).split('/').pop();
  // how a sentence names it: a model the way people know it, a way of serving by what it does
  const opts = Array.isArray(name.options) ? name.options : [];
  const said = name.kind === 'model' ? known(r.model_id)
    : name.kind === 'cascade' ? `${known(name.first)} (with a check on each answer)`
      : name.kind === 'router' && name.version === 2
        ? `${known(opts[0] ?? name.first)}${opts.length > 1 ? ` and ${opts.length - 1} more` : ''} (by kind of request)`
        : name.kind === 'router' ? `${known(name.first)} (picked for each request)`
          : name.kind === 'lighter' ? `${known(name.first)} with lighter thinking`
            : name.kind === 'cheapest' ? `${known(name.first)} from its cheapest provider` : label;
  return {
    key: r.model_id,
    // a model by its full name, a way of serving by what it does
    label,
    said,
    kind: name.kind,
    n,
    gap: judged ? pct(r.gap_pct) : null,
    lo: judged ? pct(r.gap_lo ?? r.gap_pct) : null,
    hi: judged ? pct(r.gap_hi ?? r.gap_pct) : null,
    perCall: perCall === null ? null : round8(perCall),
    p50: ms,
    tone, verdict, why,
    serving: isServing,
    twice: verdict === 'Passed twice',
    confirmRuns: Number(r.confirm_runs) || 0,
  };
}

const TONE_ORDER = { ok: 0, warn: 1, bad: 2, mut: 3 };
const z2 = 1.6449 ** 2;
const pctWords = (x) => `${Math.round(x * 1000) / 10}%`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// a day as a test counts it (a UTC day), in words: "27 Sep"
const dayWords = (d) => { const x = new Date(Number(d) * DAY); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };

/* The sentences at the top of an opened test: what it found, and what happens because of it. Where answers were
   compared on "at least as good" rather than "the same", or the judge was not trusted, a sentence more says so. */
function takeOf(run, cands, w, opts) {
  const main = mainTake(run, cands, w, opts);
  const outcome = outcomeOf(run);
  const compared = !['unmeasurable', 'refused', 'no_balance'].includes(outcome) && !(run.status === 'running' || run.status === 'queued');
  const notes = [];
  const check = opts.check;
  if (compared && run.yardstick === 'quality' && cands.length) {
    notes.push('Because the original model answers the same request differently each time, each model was checked for answers at '
      + "least as good as the original model's, rather than the same answers.");
  }
  if (compared && Number(check?.errors) > 0 && cands.length) {
    const planted = Number(check.planted) || Number(check.errors);
    notes.push(`The judge was first tested on ${planted} answers whose right verdict is already known, and it got ${check.errors} wrong, `
      + 'so nothing is switched on its word. The next test checks the judge again.');
  }
  return [main, ...notes].join(' ');
}

function mainTake(run, cands, w, { small = null, refName }) {
  const outcome = outcomeOf(run);
  const n = Number(run.sample_size) || 0;
  const quality = run.yardstick === 'quality';
  if (run.status === 'running' || run.status === 'queued') return 'Still running. Each model appears here once it has answered its requests.';
  if (outcome === 'unmeasurable') {
    return `The original model, ${refName}, gave a different answer to the same request ${Math.round(Number(run.noise_pct) || 0)}% of the time `
      + `when each of ${n} requests was run twice, so there was no steady standard to compare other models with. `
      + 'No other model was tried, and nothing switched.'
      + (canJudge() && config.EVAL_QUALITY_YARDSTICK
        ? " Workloads like this are now compared on whether answers are at least as good as the original model's, so the next test compares models." : '');
  }
  if (outcome === 'refused') {
    return `The original model, ${refName}, couldn't answer most of this test's requests when they were run again, so there was `
      + 'nothing to compare other models with. Nothing switched.';
  }
  if (outcome === 'no_balance') return 'The balance ran out before any other model was tried. Add credit and the test can run again.';
  const stopped = outcome === 'stopped' || outcome === 'interrupted';
  if (stopped && !cands.length) {
    return outcome === 'stopped'
      ? 'This test was stopped before any model had answered all of its requests, so there is nothing to compare. Nothing switched.'
      : 'This test stopped partway, before any model had answered all of its requests, so there is nothing to compare. It tries again by itself, and nothing switched.';
  }
  const said = !stopped ? '' : outcome === 'stopped' ? 'This test was stopped before it finished, so nothing switched. '
    : 'This test stopped partway, so nothing switched. ';
  if (w.routed_model && w.promoted_run_id === run.id) {
    // the one it switched to is the one serving now, not merely the first that passed
    const won = cands.find((c) => c.serving) || cands.find((c) => c.twice) || cands.find((c) => c.tone === 'ok');
    if (won) {
      return won.confirmRuns
        ? `${won.said} passed, then passed again on ${won.confirmRuns} new requests it had never seen, so Understudy switched to it.`
        : `${won.said} passed, and Understudy switched to it.`;
    }
  }
  const kept = cands.find((c) => c.serving && c.tone === 'ok');
  if (kept) {
    const cheaper = cands.filter((c) => !c.serving && c.tone === 'ok').length;
    return `${said}The model in use is still within the allowed difference of the original model, ${refName}.`
      + (cheaper ? ` ${cheaper === 1 ? 'A cheaper model' : `${cheaper} cheaper models`} passed too.` : ' No cheaper model passed, so nothing changes.');
  }
  const twice = cands.find((c) => c.twice);
  if (twice) return `${said}${twice.said} passed twice: on this test's requests, and on new ones it had never seen.`;
  const cleared = cands.filter((c) => c.tone === 'ok');
  if (cleared.length) {
    return `${said}${cleared.length === 1 ? 'One model' : `${cleared.length} models`} passed. `
      + 'A model is tested again on new requests before anything switches.';
  }
  const bar = Number(run.floor_pct) || 0;
  const barWords = `${Math.round(bar * 10) / 10}%`;
  // too few requests for any model to be shown close enough, however well it matched
  if (small) {
    const what = quality ? "gives clearly worse answers than the original model's" : 'answers differently from the original model';
    const wait = small.calls
      ? ` The full test needs ${small.calls} recent requests, so the result can be checked again on new ones, and starts by itself when they're in`
        + (small.have !== null ? `: you have ${small.have} so far${small.earliest ? `, so the earliest is ${small.earliest}` : ''}` : '') + '.'
      : '';
    return `${said}This test used ${n} requests, too few to switch anything. Showing that a model ${what} on under ${barWords} of `
      + `requests takes at least ${small.need}.${wait}`;
  }
  // stayed within the allowed difference as the judge read it, and held back only because the judge was not trusted
  const unsure = cands.find((c) => c.verdict === 'Passed, judge unsure' && c.gap !== null);
  if (unsure) {
    return `${said}${unsure.said} stayed within the allowed difference as the judge read it: ${quality ? 'clearly worse' : 'different'} on `
      + `${pctWords(unsure.gap)} of the requests tested, where at most ${barWords} is allowed.`;
  }
  const close = cands.find((c) => c.tone === 'warn' && c.gap !== null);
  if (close) {
    const did = quality
      ? `Its answer was clearly worse than the original model's on ${pctWords(close.gap)} of the requests tested.`
      : `It answered differently from the original model on ${pctWords(close.gap)} of the requests tested.`;
    // the allowed difference, and where it comes from: the original model's own variation, and a little more
    const noise = run.noise_pct === null || run.noise_pct === undefined ? null : pctWords(Number(run.noise_pct) / 100);
    const allowed = noise === null ? `At most ${barWords} is allowed`
      : quality ? `The original model's own answers are clearly worse than each other on ${noise} of requests, so at most ${barWords} is allowed`
        : `The original model answers differently from itself on ${noise} of requests, so at most ${barWords} is allowed`;
    const within = close.gap * 100 <= bar;
    const but = !within ? ", and this model wasn't close enough to replace it yet"
      : close.verdict === 'Slower than original' ? ', but it answered more slowly than this workload allows'
        : close.verdict === 'Too few to be sure' ? ', but it answered too few requests for the test to be sure'
          : ", but the test isn't yet sure it stays within that";
    return `${said}${close.said} was the closest match. ${did} ${allowed}${but}. It will be tested again next time.`;
  }
  return `${said}No cheaper model came close enough to the original model, ${refName}, on these ${n} requests.`;
}

/** One test opened: what it found, in a few sentences, and every model it tried. */
export async function runPageOf(w, run) {
  const results = await db.prepare(`SELECT * FROM eval_results WHERE run_id = ? AND verdict <> 'reference'`).all(run.id);
  /* The names people know models by, from the catalogue without its maker ("ByteDance Seed: Seed 2.0 Mini" is "Seed 2.0
     Mini"), for the sentences; the table keeps each model's full id. */
  const ids = new Set([run.reference_model]);
  for (const r of results) {
    const nm = nameOfResult(r);
    ids.add(r.model_id);
    if (nm.first) ids.add(nm.first);
    for (const o of Array.isArray(nm.options) ? nm.options : []) ids.add(o);
  }
  const named = await db.prepare('SELECT model_id, name FROM models_catalog WHERE model_id = ANY(?::text[])').all([...ids].filter(Boolean));
  const names = new Map(named.filter((x) => x.name).map((x) => [x.model_id, String(x.name).replace(/^[^:]{1,40}:\s*/, '').trim()]));
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
  const quality = run.yardstick === 'quality';
  const cands = results.map((r) => candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure, floorPct, quality, names }))
    .sort((a, b) => (TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
      || ((a.gap ?? 2) - (b.gap ?? 2)) || ((a.perCall ?? 1) - (b.perCall ?? 1)));
  /* A test too small to show anything: what it would have taken, the count the full test waits for where the workload
     still waits for it, and how many it has and the earliest they can be in (card 1's figures). */
  let small = null;
  if (floorPct && sample && (z2 / (sample + z2)) * 100 > floorPct) {
    const calls = !w.routed_model && Number(w.measure_at_calls) > 0 ? Number(w.measure_at_calls) : null;
    const e = calls ? await enoughOf(w, now()) : null;
    small = { need: callsToClear(floorPct), calls, have: e ? e.have : null, earliest: e?.earliest !== null && e?.earliest !== undefined ? dayWords(e.earliest) : null };
  }
  const refName = names.get(run.reference_model) || short(run.reference_model);
  return {
    id: run.id,
    take: takeOf(run, cands, w, { small, refName, check }),
    bar: round8((Number(run.floor_pct) || 0) / 100),
    yardstick: run.yardstick === 'quality' ? 'quality' : 'agreement',
    metric,
    reference: run.reference_model,
    yours: {
      perCall: refPer === null ? null : round8(refPer),
      p50: metric === 'ttft' ? Number(run.ref_ttft_p50) || null : Number(run.ref_latency_p50) || null,
    },
    cands: cands.map(({ twice, confirmRuns, said, ...c }) => c),
    // how often the original model differed from itself (or was clearly worse than itself): the allowed difference is set from it
    noise: run.noise_pct === null || run.noise_pct === undefined ? null : round8(Number(run.noise_pct) / 100),
    self: selfOf(run, plan),
  };
}

/* What a test that compared nothing can still be drawn from: how often the customer's own model's two answers
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
