import { db, now, round8 } from './db/index.js';
import config from './config.js';
import { withFee } from './billing.js';
import { barNeed, usableCalls, sampleSizeFor } from './eval/plan.js';
import { callsToClear, extract, differingFields } from './eval/compare.js';
import { LASTING_STATUSES } from './eval/replay.js';
import { lastAsked, messagesText, responseText } from './callText.js';
import { valueOf, optimizingSince, paceOf } from './eval/value.js';
import { routedSavings } from './eval/actual.js';
import { cadenceOf, waitOf } from './eval/schedule.js';
import { HANDED_OVER } from './jobs.js';
import { outcomeOf, failedSecondLook, DID_NOT_HOLD_UP } from './eval/outcome.js';
import { canJudge } from './eval/judge.js';
import { servingKey } from './eval/promote.js';
import { controlRecord, barOf } from './learn/control.js';
import { nameOfResult, armById, labelOf } from './learn/arms.js';

/* A workload's page, as the four questions it answers at a glance (web/src/screens/WorkloadPage.jsx):
 *   enough        is there enough of its traffic to optimize it, counted the way a test counts it: by count alone,
 *                 however many arrive in a day, so the request that brings the count to what a test needs starts it;
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

/* Requests a day over the last thirty days (created_at / DAY, which is UTC): every request, and the ones a test
   counts, which are the customer's own with their text kept and not failed, however many a day (eligible in
   src/eval/plan.js). */
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
    return { d, n: Number(r?.n || 0), counted: Number(r?.usable || 0) };
  });
}

/* 1. Enough data to optimize? By count alone: how many a test can use, and how many it needs. */
async function enoughOf(w, t) {
  const every = await cadenceOf(w.workspace_id);
  const daily = await dailyOf(w, t);
  const usable = await usableCalls(w);
  /* what it was left waiting for, where a test was turned down already or a model waits for its second test, and otherwise
     what its bar takes; a second test's wait is for requests no test has drawn, counted as what starts it counts them
     (waitOf), and said as those ("after 12 more requests") */
  const wait = await waitOf(w);
  const need = wait ? wait.need : barNeed(w).calls;
  const have = wait?.secondLook ? wait.have : usable;
  const yes = have >= need;
  const last = await db.prepare('SELECT created_at FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(w.id);
  // when it is next tested by itself: its own booking, or the workspace's rhythm after its last test
  const nextAt = !every ? null : w.recheck_after ? Number(w.recheck_after)
    : last ? Number(last.created_at) + every * DAY : null;
  return {
    yes, have, need,
    total: daily.reduce((a, x) => a + x.n, 0),
    daily,
    // how many of them a test uses
    sample: sampleSizeFor(usable),
    everyDays: every,
    nextAt,
  };
}

/* Where a workload's requests go now, for the drawing at the top of its page, whatever its state: how many come a day
   (paceOf, the way what a switch is worth counts them), and when the last one came, routed through Understudy or as a
   copy. The drawing moves only while they are arriving, the last within LIVE_MS; otherwise it stands still and says when
   the last one came, so a page never shows requests flowing that are not. */
const LIVE_MS = 15 * 60000;
async function flowOf(w, t) {
  const pace = await paceOf(w.id, t);
  const last = await db.prepare(`SELECT MAX(created_at) AS at FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') AND NOT ${TRY}`).get(w.id);
  return { perDay: pace.perDay, copiesPerDay: pace.copiesPerDay, lastAt: last?.at ? Number(last.at) : null, liveMs: LIVE_MS };
}

// the first moment of this month, as India's calendar has it
const monthStartIST = (t) => {
  const ist = new Date(t + IST);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST;
};

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
  const monthStart = monthStartIST(t);
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
  /* What the test that switched it found a month would cost at this workload's volume, on the original model and on what
     serves it now: the saving it expected. Before any request has come through since the switch, what a request costs on
     it is read from that same test, as its share of what one costs on the original model. */
  const serving = await servingKey(w);
  const months = w.promoted_run_id ? await db.prepare(`SELECT model_id, verdict, cost_month_usd FROM eval_results
      WHERE run_id = ? AND (verdict = 'reference' OR model_id = ?)`).all(w.promoted_run_id, serving ?? '') : [];
  const refRow = months.find((r) => r.verdict === 'reference');
  const itsRow = months.find((r) => r.verdict !== 'reference' && r.model_id === serving);
  const refMonth = refRow && Number(refRow.cost_month_usd) > 0 ? Number(refRow.cost_month_usd) : null;
  const itsMonth = itsRow && itsRow.cost_month_usd !== null && itsRow.cost_month_usd !== undefined ? Number(itsRow.cost_month_usd) : null;
  const seen = v.paths.perCall === null || v.paths.perCall === undefined ? null : v.paths.perCall;
  const after = seen ?? (refMonth !== null && itsMonth !== null && before > 0 ? round8(before * (itsMonth / refMonth)) : null);
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
    // where what a request costs on it now was read: its own requests since the switch, or the test that switched it
    afterFrom: seen !== null ? 'requests' : after !== null ? 'test' : null,
    less: before > 0 && after !== null && after !== undefined ? round8(Math.max(0, 1 - after / before)) : null,
    // what that test expected a month to save at this workload's volume
    expectedMonth: refMonth !== null && itsMonth !== null ? round8(refMonth - itsMonth) : null,
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

// a test a restart handed over (src/jobs.js HANDED_OVER), which started again at once as the next test
const handedOver = (r) => String(r?.error || '').startsWith(HANDED_OVER);

/* A test as a line in the list: what it found, in a few words, and what that means, said when the tag is hovered.
   A test that ends without comparing anything says which way it ended, rather than "could not measure". */
function tagOf(r, sum, w) {
  const outcome = outcomeOf(r);
  const tag = (tone, text, why) => ({ tone, text, why });
  if (r.status === 'running') return tag('brand', 'Testing now', 'This test is running now.');
  if (r.status === 'queued') return tag('brand', 'Waiting to start', 'This test is waiting for its turn to start.');
  if (outcome === 'stopped') return tag('mut', 'Stopped', 'This test was stopped before it finished, so nothing was switched.');
  if (outcome === 'interrupted' && handedOver(r)) {
    return tag('mut', 'Restarted', 'Understudy restarted while this test ran, usually for an update, so it started again straight '
      + 'away, using again the answers it had already paid for. Nothing was switched.');
  }
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
  if (outcome === 'capped') {
    return tag('warn', 'Reached its limit', 'It stopped at the most its quote said it may spend, before any cheaper model was compared. '
      + 'You were charged only for what it ran, and nothing was switched.');
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
  // passed once and not on the new requests of its second test: never switched to or offered (failedSecondLook)
  if (Number(sum?.fell) > 0) {
    return tag('warn', 'Passed once, not again', "A cheaper model passed on this test's requests, but not again on new requests it had never "
      + 'seen, so nothing switches.');
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
    `SELECT id, status, outcome, error, trigger, sample_size, spend_usd, created_at, started_at, finished_at, floor_pct, judge_check_json,
            quote_about_usd, cap_usd
       FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 30`).all(w.id);
  if (!runs.length) return [];
  const first = await db.prepare('SELECT id FROM eval_runs WHERE workload_id = ? ORDER BY created_at LIMIT 1').get(w.id);
  const serving = w.routed_model ? await servingKey(w) : null;
  // the second looks that did not hold up, by the rule every screen reads (failedSecondLook in src/eval/outcome.js)
  const fell = `e.confirm_verdict IN (${DID_NOT_HOLD_UP.map((v) => `'${v}'`).join(', ')})`;
  const sums = await db.prepare(
    `SELECT e.run_id,
            COUNT(*) FILTER (WHERE e.verdict = 'cleared' AND e.model_id <> ? AND NOT COALESCE(${fell}, false)) AS cleared,
            COUNT(*) FILTER (WHERE e.verdict = 'cleared' AND ${fell}) AS fell,
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
      what: r.trigger === 'manual' ? 'Started manually' : r.trigger === 'second_look' ? 'Second test, on new requests'
        : (r.trigger === 'first' || r.id === first?.id) ? 'First test' : 'Regular re-test',
      n: Number(r.sample_size) || 0,
      mins: r.finished_at ? Math.max(1, Math.round((Number(r.finished_at) - start) / 60000)) : null,
      // what it cost the customer, our fee included, as they were charged for it (chargeEval)
      usd: withFee(Number(r.spend_usd) || 0),
      // what its quote said before it ran, our fee included: about what it would cost, and the most it could (null before)
      quote: r.quote_about_usd === null || r.quote_about_usd === undefined ? null : Number(r.quote_about_usd),
      cap: r.cap_usd === null || r.cap_usd === undefined ? null : Number(r.cap_usd),
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
    // where its requests go now, for the drawing at the top of the page, whatever its state
    flow: await flowOf(w, t),
    /* why the last test nobody asked for did not run, where that is what the page should say instead of a date: paused at
       the testing limit, until credit is added, or over what one test may spend (noteSkip in src/eval/run.js) */
    skip: (() => {
      try {
        const s = JSON.parse(w.test_skip_json || 'null');
        return s && s.short ? { reason: s.reason, short: s.short, text: s.text ?? null, at: Number(s.at) || null } : null;
      } catch { return null; }
    })(),
    /* what testing it has cost this month, in India's calendar, our fee included: its tests, and the background answers,
       answers read in the background and daily checks against the original model (optimizingSince) */
    spentMonth: await optimizingSince(w.id, monthStartIST(t)),
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
const SLOWER = 'It answered more slowly than the original model, by more than this workload allows.';

// a time as the page writes it (secs in web/src/screens/WorkloadDetail.jsx): 870 ms under a tenth of a second, else 1.2 s
const secsWords = (ms) => (ms < 95 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
// the same time as a number, rounded as it is written, so a difference said beside two times is theirs: 5.4 less 2.0 is 3.4
const secsShown = (ms) => (ms < 95 ? Math.round(ms) : Math.round(ms / 100) * 100);
/* Two times that are compared, written so that they read as different where they are: a model just past the limit is
   never "3.3 s, where 3.3 s is allowed", but 3.30 s against 3.27 s. */
const secsPair = (a, b) => (a !== b && secsWords(a) === secsWords(b)
  ? [`${(a / 1000).toFixed(2)} s`, `${(b / 1000).toFixed(2)} s`] : [secsWords(a), secsWords(b)]);

/* Why a model was too slow, in the figures that decided it (tooSlow in src/eval/run.js): its typical time against the
   original model's and the most this workload allows; and where its typical time was allowed, the answers that ran
   past the looser limit on the slowest ones, where about 1 in 10 may. Null where the test kept no figures to say it. */
function slowerWhy(r, sp) {
  if (!sp?.limits) return null;
  const ttft = sp.metric === 'ttft';
  const m50 = Number(ttft ? r.ttft_p50 : r.latency_p50) || 0;
  if (!(m50 > 0) || !(sp.refP50 > 0)) return null;
  const how = ttft ? ' to start answering' : '';
  /* Decided on the times themselves (as tooSlow is), and said in the times as written: the difference is the one
     between them as they read, to a hundredth where they are written so (3.34 s less 2.0 s is 1.3 s), and how many
     times as long is worked out from the times themselves, so it never reads 1.6 beside 3.34 s and 2.0 s. */
  const [took, most] = secsPair(m50, sp.limits.p50);
  const fine = /\.\d\d s$/.test(took);
  const slower = (fine ? Math.round(m50 / 10) * 10 : secsShown(m50)) - secsShown(sp.refP50);
  const ratio = m50 / sp.refP50;
  const vs = `On a typical request this model took ${took}${how}, and the original model ${secsWords(sp.refP50)}.`;
  if (m50 > sp.limits.p50) {
    return `${vs} That's ${secsWords(slower)} slower, ${ratio.toFixed(1)} times as long, and this workload allows up to ${most}.`;
  }
  const allowed = `${vs} That's ${slower > 0 ? `${secsWords(slower)} slower, which this workload allows` : 'within what this workload allows'} `
    + `(up to ${most}).`;
  const over = sp.over?.get(r.model_id);
  if (over && over.over > 0) {
    return `${allowed} But ${over.over} of its ${over.n} answers took longer than ${secsWords(sp.limits.p90)}. This workload lets about 1 in 10 `
      + `answers take that long, and ${over.over} in ${over.n} is too many.`;
  }
  // a way of serving several models is timed as a whole, with no answer of its own to count: said by its slowest tenth
  const m90 = Number(ttft ? r.ttft_p90 : r.latency_p90) || 0;
  if (m90 > sp.limits.p90) {
    const [slowest, allows] = secsPair(m90, sp.limits.p90);
    return `${allowed} But its slowest answers were too slow: its slowest 1 in 10 took over ${slowest}, and this workload allows them `
      + `up to ${allows}.`;
  }
  return null;
}

/* Why a model that passed once did not pass again, in its second look's own figures (lookAgain in src/eval/run.js). */
function secondWhy(r, differs) {
  const n = Number(r.confirm_runs) || 0;
  const on = n ? `on ${n} new requests it had never seen` : 'on new requests it had never seen';
  const pct = (x) => `${Math.round(Number(x) * 10) / 10}%`;
  const first = "It stayed within the allowed difference on this test's requests, but";
  if (r.confirm_verdict === 'slower') return `${first} ${on} it was too slow, so it isn't switched to.`;
  if (r.confirm_verdict === 'busy') return `${first} ${on} its provider couldn't keep up, so it isn't switched to.`;
  const fig = r.confirm_gap === null || r.confirm_gap === undefined ? '' : ` on ${pct(r.confirm_gap)} of them`;
  const allowed = r.confirm_floor === null || r.confirm_floor === undefined ? '' : `, where ${pct(r.confirm_floor)} is allowed`;
  const close = r.confirm_verdict === 'review' ? ' it came too close to the limit to be sure:' : '';
  return `${first} ${on}${close} it ${differs}${fig}${allowed}. So it isn't switched to, and the next test looks again.`;
}

function candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure = false, floorPct = null, quality = false, names = new Map(), speed = null }) {
  const name = nameOfResult(r);
  const n = Number(r.runs) || 0;
  const isServing = !!serving && r.model_id === serving;
  const differs = quality ? "gave clearly worse answers than the original model's" : 'answered differently from the original model';
  let out;
  if (r.verdict === 'failed' && r.stopped === 'busy') {
    // its provider could not keep up (EVAL_KEEP_UP_REFUSALS): failed for good on this workload
    out = ['bad', "Couldn't keep up", `Its provider kept turning this test's requests away for coming too fast, even with Understudy waiting `
      + `${Math.round(config.MODEL_BACKOFF_MAX_MS / 1000)} seconds between them. A model that can't keep up can't handle this workload's `
      + "traffic, so it failed and won't be tested on this workload again."];
  } else if (r.verdict === 'failed') {
    out = ['bad', 'Failed requests', "The model's provider refused or failed some of this test's requests, so it can't be relied on for this workload."];
  } else if (r.verdict === 'slower') {
    out = ['warn', 'Slower than original', slowerWhy(r, speed) ?? SLOWER];
  } else if (isServing && !switchRun && r.verdict === 'cleared') {
    // what serves, checked again; in the test that switched to it, it was a model like the rest
    out = ['ok', 'Still passing', 'This is the model answering this workload now. It was tested again and is still within the allowed difference.'];
  } else if (r.stopped && n < sample) {
    out = r.stopped === 'bar'
      ? ['bad', 'Clearly not a match', 'Testing stopped early because the model was already different enough that more requests were very unlikely to change the result.']
      : r.stopped === 'budget'
        ? ['mut', 'Stopped early', 'The test reached its limit before this model had answered every request.']
        : ['mut', 'Stopped early', 'The test was stopped before this model had answered every request.'];
  } else if (r.verdict === 'cleared' && (r.confirm_verdict === 'cleared' || r.confirm_verdict === 'live')) {
    out = ['ok', 'Passed twice', "It stayed within the allowed difference on this test's requests, and again on new requests it had never seen."];
  } else if (r.verdict === 'cleared' && failedSecondLook(r)) {
    /* passed its first look and not its second, on new requests: never offered or switched to (failedSecondLook). Read as
       "Passed once" in green, it said it would be tested again, when it had been, and had not passed. */
    out = ['bad', 'Passed once, not again', secondWhy(r, differs)];
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
  /* A model failed as unable to keep up only once it had answered every request of this test (its provider gave out on its
     second look, or on another's) was judged on all of them, and its figure says how its answers compared. One stopped part
     way, or failed for errors, has no figure that means anything. */
  const judged = (r.verdict !== 'failed' || (r.stopped === 'busy' && n >= sample)) && r.gap_pct !== null && r.gap_pct !== undefined && n > 0;
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
    /* It failed whatever its answers were like (errors, or a provider that could not keep up). The chart leaves it out: it
       places models by how their answers compared, and its red is "not a match", which one that answered everything right
       and could not keep up is not. */
    failed: r.verdict === 'failed',
    serving: isServing,
    twice: verdict === 'Passed twice',
    confirmRuns: Number(r.confirm_runs) || 0,
    // the new requests its second look was read on, which decided its outcome as well (lookAgain in src/eval/run.js)
    second: Number(r.confirm_runs) || 0,
  };
}

const TONE_ORDER = { ok: 0, warn: 1, bad: 2, mut: 3 };
const z2 = 1.6449 ** 2;
const pctWords = (x) => `${Math.round(x * 1000) / 10}%`;

/* The sentences at the top of an opened test: what it found, and what happens because of it. Where answers were
   compared on "at least as good" rather than "the same", or the judge was not trusted, a sentence more says so. */
function takeOf(run, cands, w, opts) {
  const main = mainTake(run, cands, w, opts);
  const outcome = outcomeOf(run);
  const compared = !['unmeasurable', 'refused', 'no_balance', 'capped'].includes(outcome) && !(run.status === 'running' || run.status === 'queued');
  const notes = [];
  // cut short at the most its quote allowed, once some models had been compared: what it shows is what it got to
  if (compared && String(run.error || '').startsWith('reached its limit')) {
    notes.push(`It stopped at ${String(run.error).replace(/^reached /, '')}, the most its quote said it may spend, so not every model it planned was tried.`);
  }
  const check = opts.check;
  // why it was judged the way it was (planRecord.judging in src/eval/run.js)
  let plan = null;
  try { plan = run.plan_json ? JSON.parse(run.plan_json) : null; } catch { plan = null; }
  const why = plan?.judging?.reason ?? plan?.yardstick?.reason ?? null;
  if (compared && run.yardstick === 'quality' && cands.length) {
    notes.push(why === 'open-ended'
      ? 'These requests ask for open-ended writing, where many different answers are each as good, so each model was checked for '
        + "answers at least as good as the original model's, rather than the same answers."
      : why === 'chosen'
        ? "As this workload's setting asks, each model was checked for answers at least as good as the original model's, rather than "
          + 'the same answers.'
        : 'Because the original model answers the same request differently each time, each model was checked for answers at '
          + "least as good as the original model's, rather than the same answers.");
  } else if (compared && plan?.judging?.mode === 'same' && cands.length) {
    notes.push("As this workload's setting asks, each model was checked for the same answers as the original model's.");
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
    // held to the same answer by the workload's own setting (planRecord.judging in src/eval/run.js), which only a person changes
    let plan = null;
    try { plan = run.plan_json ? JSON.parse(run.plan_json) : null; } catch { plan = null; }
    const heldSame = plan?.judging?.mode === 'same';
    const judgeable = canJudge() && config.EVAL_QUALITY_YARDSTICK;
    return `The original model, ${refName}, gave a different answer to the same request ${Math.round(Number(run.noise_pct) || 0)}% of the time `
      + `when each of ${n} requests was run twice, so there was no steady standard to compare other models with. `
      + 'No other model was tried, and nothing switched.'
      + (!judgeable ? ''
        : heldSame && w?.judge_mode === 'same'
          ? " This workload's setting asks for the same answers as the original model's. Set Answers judged, at the top of this page, to "
            + "Automatically or At least as good, and the next test compares models on whether their answers are at least as good."
          : heldSame
            ? " With this workload's setting changed since, the next test compares models on whether their answers are at least as good."
            : " Workloads like this are now compared on whether answers are at least as good as the original model's, so the next test compares models.");
  }
  if (outcome === 'refused') {
    return `The original model, ${refName}, couldn't answer most of this test's requests when they were run again, so there was `
      + 'nothing to compare other models with. Nothing switched.';
  }
  if (outcome === 'no_balance') return 'The balance ran out before any other model was tried. Add credit and the test can run again.';
  if (outcome === 'capped') {
    const limit = Number(run.cap_usd) > 0 ? ` of $${Number(run.cap_usd).toFixed(2)}` : '';
    return `This test reached its limit${limit}, the most its quote said it may spend, before any other model was tried. `
      + 'You were charged only for what it ran, and nothing switched.';
  }
  const stopped = outcome === 'stopped' || outcome === 'interrupted';
  const restarted = outcome === 'interrupted' && handedOver(run);
  if (stopped && !cands.length) {
    return outcome === 'stopped'
      ? 'This test was stopped before any model had answered all of its requests, so there is nothing to compare. Nothing switched.'
      : restarted
        ? 'Understudy restarted while this test ran, usually for an update, so it started again straight away. Nothing switched.'
        : 'This test stopped partway, before any model had answered all of its requests, so there is nothing to compare. It tries again by itself, and nothing switched.';
  }
  const said = !stopped ? '' : outcome === 'stopped' ? 'This test was stopped before it finished, so nothing switched. '
    : restarted ? 'Understudy restarted while this test ran, so it started again straight away, and nothing switched. '
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
  // passed once and was tested again, and did not pass there (failedSecondLook)
  const fellBack = cands.find((c) => c.verdict === 'Passed once, not again');
  if (fellBack) {
    return `${said}${fellBack.said} passed once, but not again on ${fellBack.second ? `${fellBack.second} ` : ''}new requests it had never `
      + "seen, so it isn't switched to. The next test looks again.";
  }
  const bar = Number(run.floor_pct) || 0;
  const barWords = `${Math.round(bar * 10) / 10}%`;
  // too few requests for any model to be shown close enough, however well it matched
  if (small) {
    const what = quality ? "gives clearly worse answers than the original model's" : 'answers differently from the original model';
    const wait = small.calls
      ? ` The full test needs ${small.calls} recent requests, so the result can be checked again on new ones, and starts by itself when they're in`
        + (small.have !== null ? `: you have ${small.have} so far` : '') + '.'
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
  // what a request cost on each model in this measurement, from its own answers to its first look, reused ones left out
  const costs = await db.prepare(
    `SELECT model_id, AVG(cost_usd) AS per FROM eval_replays WHERE run_id = ? AND reused = 0 AND cost_usd > 0
        AND (status IS NULL OR status < 400) AND look IS DISTINCT FROM 2 GROUP BY model_id`).all(run.id);
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
  /* The speed this test held every model to (tooSlow in src/eval/run.js): at most `factor` times the original model's
     typical time, and on its slowest tenth `slowEnd` times the original model's, each with a little slack. For a model
     too slow, how many of its answers ran past the second, which its words give (slowerWhy). */
  const refP50 = Number(metric === 'ttft' ? run.ref_ttft_p50 : run.ref_latency_p50) || 0;
  const refP90 = Number(metric === 'ttft' ? run.ref_ttft_p90 : run.ref_latency_p90) || refP50;
  const rule = plan?.speed;
  const speed = rule?.factor > 0 && refP50 > 0 ? {
    metric, refP50, refP90, over: new Map(),
    limits: {
      p50: Number(rule.factor) * refP50 + config.SPEED_SLACK_MS,
      p90: (Number(rule.slowEnd) || Number(rule.factor) + config.SPEED_SLOW_END_EXTRA) * refP90 + config.SPEED_SLACK_MS,
    },
  } : null;
  const slow = results.filter((r) => r.verdict === 'slower').map((r) => r.model_id);
  if (speed && slow.length) {
    // timed as the test timed them: an answer's whole time, or its first word's, a whole answer counting as its first word
    const t = metric === 'ttft' ? 'COALESCE(ttft_ms, latency_ms)' : 'latency_ms';
    const rows = await db.prepare(
      `SELECT model_id, COUNT(*) AS n, COUNT(*) FILTER (WHERE ${t} > ?) AS over FROM eval_replays
        WHERE run_id = ? AND model_id = ANY(?::text[]) AND error IS NULL AND (status IS NULL OR status < 400) AND ${t} > 0
          AND look IS DISTINCT FROM 2
        GROUP BY model_id`).all(speed.limits.p90, run.id, slow);
    for (const x of rows) speed.over.set(x.model_id, { n: Number(x.n), over: Number(x.over) });
  }
  const cands = results.map((r) => candOf(r, { sample, serving, refPer, metric, avg, switchRun, unsure, floorPct, quality, names, speed }))
    .sort((a, b) => (TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
      || ((a.gap ?? 2) - (b.gap ?? 2)) || ((a.perCall ?? 1) - (b.perCall ?? 1)));
  /* A test too small to show anything: what it would have taken, the count the full test waits for where the workload
     still waits for it, and how many it has (card 1's figures). */
  let small = null;
  if (floorPct && sample && (z2 / (sample + z2)) * 100 > floorPct) {
    const calls = !w.routed_model && Number(w.measure_at_calls) > 0 ? Number(w.measure_at_calls) : null;
    const e = calls ? await enoughOf(w, now()) : null;
    small = { need: callsToClear(floorPct), calls, have: e ? e.have : null };
  }
  const refName = names.get(run.reference_model) || short(run.reference_model);
  return {
    id: run.id,
    // when it ran, and the original model by the name people know it, for a model's own page (src/workloadPage.js runAnswersOf)
    at: Number(run.created_at) || null,
    referenceName: refName,
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
    // how many requests the test sampled, which each model's count of answered ones is read against
    sample,
    // how often the original model differed from itself (or was clearly worse than itself): the allowed difference is set from it
    noise: run.noise_pct === null || run.noise_pct === undefined ? null : round8(Number(run.noise_pct) / 100),
    self: selfOf(run, plan),
  };
}

const ANSWERS_PER_PAGE = 10;
// the most requests one page of a model's answers holds (a model's own page asks for 20)
const ANSWERS_PER_PAGE_MAX = 50;
/* Which of a model's answers to show, by how each was read: the same answer counted in the model's figure, one that matched
   one of the original model's two, a different one, one that failed, one a busy provider refused (not counted), and one
   that could not be judged (not counted). The same readings as the counts runAnswersOf gives, over the same rows. */
const RESULT_FILTERS = {
  same: 'counts AND failure IS NULL AND error IS NULL AND score <= 0',
  partly: 'counts AND failure IS NULL AND error IS NULL AND score > 0 AND score < 0.999',
  different: 'counts AND failure IS NULL AND error IS NULL AND score >= 0.999',
  failed: 'counts AND (failure IS NOT NULL OR error IS NOT NULL)',
  busy: "NOT counts AND COALESCE(failure, '') = 'refused'",
  unjudged: "NOT counts AND COALESCE(failure, '') <> 'refused'",
};
const clip = (s, n) => (s === null || s === undefined ? null : String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* A model's answer kept by a test (keepReplay in src/eval/run.js keeps its words, or the tools it called as JSON), as a
   response again, so it is read exactly as the test read it (extract in src/eval/compare.js). */
function asResponse(answer, shape) {
  if (answer === null || answer === undefined) return null;
  if (shape === 'tool_call') {
    const calls = parse(answer);
    if (Array.isArray(calls)) return { choices: [{ message: { tool_calls: calls.map((c) => ({ function: { name: c?.name, arguments: c?.arguments } })) } }] };
  }
  return { choices: [{ message: { content: String(answer) } }] };
}

/* How an answer that was scored above 0 differed, as the judge said it did (the kinds keepReplay keeps; KIND_WORDS in
   src/eval/run.js says the same of a model's answers as a whole). */
const DIFF_WORDS = {
  wording: 'only the wording differs', omission: 'it leaves something out', fact: 'a fact or a figure differs',
  decision: 'it reaches a different decision', refusal: 'it refuses to answer', 'cut off': 'it stops part way through',
  worse: 'it is a worse answer', unrelated: 'it answers something else', truncated: 'it ran out of room',
  instruction: "it doesn't follow the instructions in the request", empty: 'it is empty',
  'unparseable json': "it isn't valid JSON", 'no tool call': 'it calls no tool', 'unparseable arguments': "its tool's arguments aren't valid JSON",
  refused: 'its provider refused or failed it',
};

// how a model's second look ended (confirm_verdict, written by lookAgain in src/eval/run.js)
const CONFIRM_WORDS = {
  cleared: 'it passed', missed: "it didn't pass", review: "it came close, but didn't pass", slower: 'it was too slow on them',
  insufficient: "there weren't yet enough new requests to look again", not_reached: "it wasn't reached, because another model passed first",
  live: 'it passed on live requests', busy: "its provider couldn't keep up with the requests",
};

/* Whether an answer counted towards the model's figure, as the test wrote down, or for an answer kept before it did,
   unless it is a refusal from a provider that was only busy (see LASTING_STATUSES), the one it can still be told from. */
const countedOf = (row) => (row.scored === null || row.scored === undefined
  ? row.score !== null && row.score !== undefined && !(row.failure === 'refused' && !LASTING_STATUSES.includes(Number(row.status) || 0))
  : Number(row.scored) === 1);

/* How the test compared an answer with the original model's, from what it wrote down: the same text, a field at a time
   (nothing to judge), a judge model reading them, or the rules in the request's own instructions. */
function comparedWords(by, shape, scored) {
  const b = String(by || '');
  if (b === 'same text') return 'The text was identical';
  if (b === 'checklist' || b.endsWith('+checklist')) return 'Checked against the instructions in the request';
  if (b === 'numbers' || b.endsWith('+numbers')) return "A figure in it differs from the original model's";
  if (b === 'fields') return 'A field the original model gave the same way twice differs in it';
  if (b === 'jev-quality' || b === 'llm-quality') return 'Read by a judge model twice, once each way round';
  if (b) return 'Read by a judge model';
  return scored && shape !== 'free_text' ? 'Compared field by field' : null;
}

/* The judge's two readings of one answer held to "at least as good", for its page: for each, which answer it found the
   better ('answer', this model's; 'original'; or 'equal'), what it leaned to where a lean too slight to count was read
   as a tie, and how sure it was; and a requirement of the instruction the answer broke, or a figure it changed. The
   answer judged is first in the first reading and second in the second (judgeQuality in src/eval/judge.js). */
function readingsWords(r) {
  if (!r || typeof r !== 'object') return null;
  const side = (pick, i) => (pick === 'equal' || !pick ? 'equal' : (pick === 'first') === (i === 0) ? 'answer' : 'original');
  const picks = Array.isArray(r.picks) ? r.picks : [];
  return {
    each: picks.map((p, i) => {
      const leaned = Array.isArray(r.seen) ? side(r.seen[i], i) : null;
      return { side: side(p, i), leaned: leaned && leaned !== side(p, i) ? leaned : null, sure: r.chances?.[i] ?? null };
    }),
    split: !!r.split, better: !!r.better, broke: r.broke || null, figures: !!r.figures,
    // the field of a structured answer it changed that the original model gave the same way both times (heldFieldChanged)
    field: r.field || null,
  };
}

/* How one request's answer was read, in words: the score the test gave it (0 the same as the original model, 1 a
   different answer, or clearly worse where answers are held to "at least as good"), or why there was none. */
function answerVerdict(row, quality) {
  const counted = countedOf(row);
  if (!counted && row.failure === 'refused') return { tone: 'mut', text: "Provider busy, so it doesn't count" };
  if (row.failure || row.error) {
    const why = row.failure === 'refused' ? 'the provider refused or failed it'
      : row.failure === 'truncated' ? 'the answer was cut off'
        : row.failure === 'unparseable json' ? "the answer wasn't valid JSON"
          : row.failure === 'unparseable arguments' ? "the tool's arguments weren't valid JSON"
            : row.failure === 'no tool call' ? 'it called no tool'
              : row.failure === 'empty' ? 'the answer was empty' : String(row.failure || row.error).slice(0, 80);
    return { tone: 'bad', text: `Failed: ${why}` };
  }
  if (row.score === null || row.score === undefined) return { tone: 'mut', text: "Not judged, so it doesn't count" };
  if (!counted) return { tone: 'mut', text: "Couldn't be judged, so it doesn't count" };
  const s = Number(row.score);
  if (s <= 0) return { tone: 'ok', text: quality ? 'At least as good' : 'Same answer' };
  if (s >= 0.999) return { tone: 'bad', text: quality ? 'Clearly worse' : 'Different' };
  // held to "the same answer": the same as one of the original model's two answers and not the other. Held to "at least
  // as good", a split between the two readings is a tie, so a score between 0 and 1 only comes from an older reading
  return { tone: 'warn', text: quality ? 'Partly worse' : 'Matched one of the two answers' };
}

/* One model in one test, request by request: what was asked, the original model's two answers (the two the test held
   this model's answer against), this model's answer, and how it was read: its score, the fields that differed, its
   time and its cost beside the original model's. A way of serving built on a model (a check on each answer, a model
   picked by kind of request) keeps no answers of its own, so its lead model's are shown and it says so. Content goes
   with the workspace's retention window, and then says so rather than showing nothing. Null for a model the test did
   not try. */
export async function runAnswersOf(w, run, key, { page = 1, per: perAsked = ANSWERS_PER_PAGE, look = 1, result = null } = {}) {
  const per = Math.max(1, Math.min(ANSWERS_PER_PAGE_MAX, Math.round(Number(perAsked) || ANSWERS_PER_PAGE)));
  // one kind of result only, or every answer; a request keeps its place among all of them either way
  const filter = Object.hasOwn(RESULT_FILTERS, String(result)) ? String(result) : null;
  const r = await db.prepare(`SELECT * FROM eval_results WHERE run_id = ? AND model_id = ? AND verdict <> 'reference'`).get(run.id, key);
  if (!r) return null;
  const name = nameOfResult(r);
  const built = name.kind === 'cascade' || name.kind === 'router';
  // whose answers: the model's own, or for a way of serving built on one, its lead model's (under its own name or a variant of it)
  let from = r.model_id;
  if (built) {
    const kept = await db.prepare(`SELECT model_id, COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND slot = 0 AND (model_id = ? OR model_id LIKE ?)
        AND look IS DISTINCT FROM 2 GROUP BY model_id ORDER BY (model_id = ?) DESC, COUNT(*) DESC`).all(run.id, name.first, `${name.first}#%`, name.first);
    from = kept[0]?.model_id ?? name.first;
  }
  const quality = run.yardstick === 'quality';
  const shape = run.shape_kind || w.shape_kind;
  const p = Math.max(1, Math.min(1000, Math.round(Number(page) || 1)));
  /* Its second look, on new requests it had never seen (lookAgain in src/eval/run.js), for a model on its own: a way of
     serving built on one keeps no answers to it. How many it was read on, and how many of its answers were kept, which a
     test from before they were keeps none of. */
  const second = Number(look) === 2 && !built;
  const keptSecond = built ? 0 : Number((await db.prepare(
    'SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 AND look = 2').get(run.id, r.model_id))?.n) || 0;
  /* The answers its row was read from. A model dropped part way can be finished later in the same test for a way of
     serving built on it (the strategies in src/eval/run.js), and its row still counts only the requests it answered
     before it was dropped: its first `runs` answers, in the order it gave them. A way of serving built on a model reads
     every request its lead model answered, once each, the last reading of it (a test from before a finished model went
     on from where it stopped answered its first requests twice, and the strategy read the second). A second look is
     every answer to it. */
  const mine = built
    ? `SELECT DISTINCT ON (call_id) * FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 AND look IS DISTINCT FROM 2
         ORDER BY call_id, created_at DESC, id DESC`
    : second
      ? 'SELECT * FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 AND look = 2 ORDER BY created_at, id'
      : 'SELECT * FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 AND look IS DISTINCT FROM 2 ORDER BY created_at, id LIMIT ?';
  const mineArgs = built || second ? [run.id, from] : [run.id, from, Number(r.runs) > 0 ? Number(r.runs) : null];
  /* 0 the same (or at least as good), 1 different (or clearly worse), and between, the same as one of the original
     model's two answers, over the answers that counted: the test leaves out a judgement that did not come back, and a
     refusal from a provider that was only busy or timed out, which say nothing about the model's answers (tryModel in
     src/eval/run.js), and writes down which (`scored`). An answer kept before it did counts unless it is such a refusal
     (the one it can still be told from: a refusal counts only where it would be refused again, LASTING_STATUSES). */
  // (a missing failure is not a refusal: compared as it is, it would make the whole test unknown and drop the row)
  const read = `read AS (SELECT *, COALESCE(scored = 1, score IS NOT NULL
                     AND NOT (COALESCE(failure, '') = 'refused' AND NOT (COALESCE(status, 0) = ANY(?::int[])))) AS counts,
                   ROW_NUMBER() OVER (ORDER BY created_at, id) AS pos FROM mine)`;
  const counts = await db.prepare(
    `WITH mine AS (${mine}), ${read}
     SELECT COUNT(*) AS n,
            COUNT(*) FILTER (WHERE counts AND failure IS NULL AND error IS NULL AND score <= 0) AS same,
            COUNT(*) FILTER (WHERE counts AND failure IS NULL AND error IS NULL AND score > 0 AND score < 0.999) AS partly,
            COUNT(*) FILTER (WHERE counts AND failure IS NULL AND error IS NULL AND score >= 0.999) AS differ,
            COUNT(*) FILTER (WHERE counts AND (failure IS NOT NULL OR error IS NOT NULL)) AS failed,
            COUNT(*) FILTER (WHERE NOT counts AND COALESCE(failure, '') = 'refused') AS busy,
            COUNT(*) FILTER (WHERE NOT counts AND COALESCE(failure, '') <> 'refused') AS unjudged,
            AVG(score) FILTER (WHERE counts) AS average,
            COUNT(*) FILTER (WHERE scored IS NULL) AS unmarked
       FROM read`).get(...mineArgs, LASTING_STATUSES);
  const rows = await db.prepare(
    `WITH mine AS (${mine}), ${read}
     SELECT call_id, answer, score, scored, difference, failure, error, status, latency_ms, ttft_ms, cost_usd, judged_by, reused, readings,
            created_at, pos
       FROM read${filter ? ` WHERE ${RESULT_FILTERS[filter]}` : ''} ORDER BY pos LIMIT ? OFFSET ?`)
    .all(...mineArgs, LASTING_STATUSES, per + 1, (p - 1) * per);
  // how many answers the chosen result has, which the pages are counted from
  const matched = !filter ? Number(counts.n) || 0 : Number(counts[filter === 'different' ? 'differ' : filter]) || 0;
  const page1 = rows.slice(0, per);
  const ids = page1.map((x) => x.call_id).filter(Boolean);
  const [calls, samples, refs] = ids.length ? await Promise.all([
    db.prepare(`SELECT id, request_json, content_purged_at, created_at, served_model, cost_usd, latency_ms, ttft_ms
        FROM calls WHERE id = ANY(?::text[])`).all(ids),
    db.prepare('SELECT call_id, ref_a_json, ref_b_json, content_purged_at FROM eval_samples WHERE run_id = ? AND call_id = ANY(?::text[])').all(run.id, ids),
    db.prepare(`SELECT call_id, slot, latency_ms, ttft_ms, cost_usd, status, failure FROM eval_replays WHERE run_id = ? AND model_id = ?
        AND call_id = ANY(?::text[])`).all(run.id, run.reference_model, ids),
  ]) : [[], [], []];
  const callOf = new Map(calls.map((c) => [c.id, c]));
  const sampleOf = new Map(samples.map((s) => [s.call_id, s]));
  const refOf = new Map();
  for (const x of refs) { if (!refOf.has(x.call_id)) refOf.set(x.call_id, []); refOf.get(x.call_id).push(x); }
  const plan = parse(run.plan_json);
  const ttft = plan?.speed?.metric === 'ttft' && Number(run.ref_ttft_p50) > 0;
  const named = await db.prepare('SELECT model_id, name FROM models_catalog WHERE model_id = ANY(?::text[])')
    .all([run.reference_model, from, name.first, name.fallback].filter(Boolean));
  const names = new Map(named.filter((x) => x.name).map((x) => [x.model_id, String(x.name).replace(/^[^:]{1,40}:\s*/, '').trim()]));
  const known = (id) => names.get(String(id).split('#')[0]) || String(id).split('/').pop();
  // what a way of serving built on a model does, and so whose answers these are
  const lead = known(from);
  const how = name.kind === 'cascade'
    ? `This setup answers with ${lead} and checks each answer, sending any that fail the check on to ${known(name.fallback)}.`
    : name.kind === 'router' && name.version === 2
      ? `This setup sends each kind of request to the model that did best on that kind, starting from ${lead}.`
      : `This setup picks, for each request, between ${lead} and ${known(name.fallback)}.`;
  return {
    key: r.model_id,
    from: !built ? null : {
      model: from,
      name: lead,
      why: `${how} It keeps no answers of its own, so these are the answers ${lead} gave. Its figures in the table also count what happened to the requests it sent on.`,
    },
    reference: run.reference_model,
    referenceName: known(run.reference_model),
    yardstick: quality ? 'quality' : 'agreement',
    shape,
    metric: ttft ? 'ttft' : 'latency',
    sample: Number(run.sample_size) || 0,
    total: Number(counts.n) || 0,
    counts: {
      same: Number(counts.same) || 0, partly: Number(counts.partly) || 0, different: Number(counts.differ) || 0,
      failed: Number(counts.failed) || 0, busy: Number(counts.busy) || 0, unjudged: Number(counts.unjudged) || 0,
    },
    // the average of the scores that count, which for a model on its own is the figure its row in the table shows
    average: counts.average === null || counts.average === undefined ? null : round8(Number(counts.average)),
    // the figure these answers make: its row's, or its second look's (lookAgain), with the most that look allowed
    figure: second
      ? (r.confirm_gap === null || r.confirm_gap === undefined ? null : round8(Number(r.confirm_gap) / 100))
      : (r.gap_pct === null || r.gap_pct === undefined ? null : round8(Number(r.gap_pct) / 100)),
    bar: second && r.confirm_floor !== null && r.confirm_floor !== undefined ? round8(Number(r.confirm_floor) / 100) : null,
    look: second ? 2 : 1,
    // its two looks: how many requests each was read on, how many answers to the second were kept, and how it ended
    looks: {
      first: Number(r.runs) || 0,
      second: Number(r.confirm_runs) || 0,
      kept: keptSecond,
      ended: r.confirm_verdict ? (CONFIRM_WORDS[r.confirm_verdict] ?? null) : null,
      // how the second look went, in its own figures, so a page can say it without reading the second look's answers
      verdict: r.confirm_verdict || null,
      figure: r.confirm_gap === null || r.confirm_gap === undefined ? null : round8(Number(r.confirm_gap) / 100),
      bar: r.confirm_floor === null || r.confirm_floor === undefined ? null : round8(Number(r.confirm_floor) / 100),
    },
    // the answers of one kind of result only, when asked for, and how many there are
    filter,
    matched,
    /* Answers kept before the test wrote down which counted: a judgement of one that did not come back can't be told
       from one that did, so where the average and the figure differ, the page says why rather than leaving it. */
    unmarked: Number(counts.unmarked) || 0,
    page: p,
    per,
    more: rows.length > per,
    rows: page1.map((x, k) => {
      const c = callOf.get(x.call_id);
      const s = sampleOf.get(x.call_id);
      // content goes by the workspace's retention window: the request's, and the answers the test kept
      const purged = !c || !!c.content_purged_at || !!s?.content_purged_at;
      const req = purged ? null : parse(c.request_json);
      const refs2 = purged ? [null, null] : [parse(s?.ref_a_json), parse(s?.ref_b_json)];
      const theirs = (refOf.get(x.call_id) || []).sort((a, b) => a.slot - b.slot);
      /* How long the original model took on it: its first timed answer in the test, or the real request's where the
         original model answered it (the answer a test takes from the real request carries no time of its own). */
      const timeOf = (t) => Number(ttft ? (t?.ttft_ms ?? t?.latency_ms) : t?.latency_ms) || 0;
      const refTimed = theirs.find((t) => Number(t.status || 200) < 400 && !t.failure && timeOf(t) > 0);
      const refMs = refTimed ? timeOf(refTimed) : c && c.served_model === run.reference_model && timeOf(c) > 0 ? timeOf(c) : null;
      /* What this model's answer was held to, as the test held it: each of the original model's two answers on its own
         and the score their average, or, held to "at least as good", the first of the two it could read. */
      const readRefs = refs2.map((j) => (j ? extract(j, shape) : { ok: false }));
      const heldTo = quality
        ? (readRefs[0].ok ? [true, false] : [false, readRefs[1].ok])
        : readRefs.map((e) => e.ok);
      // the fields that differed from each of them, read the way the test read them (a structured answer only)
      const got = !purged && x.answer !== null && !x.failure ? extract(asResponse(x.answer, shape), shape) : null;
      const fields = readRefs.map((e, i) => (shape !== 'free_text' && got?.ok && e.ok && heldTo[i] ? differingFields(got.value, e.value, shape) : null));
      /* A structured answer as the test read it, so a page can lay it out and mark the very fields named above; left
         out where it is too long to send whole, and the words are shown instead. */
      const whole = (e) => (shape !== 'free_text' && e?.ok && JSON.stringify(e.value ?? null).length <= 12000 ? e.value : undefined);
      const values = { answer: whole(got), original: readRefs.map(whole) };
      /* What the original model was paid for this request in the test: its answers' own costs (an answer reused from an
         earlier test is kept at no cost), or the real request's where the original model answered it. */
      const paidRef = theirs.map((t) => Number(t.cost_usd)).filter((v) => v > 0);
      const refCost = paidRef.length ? paidRef.reduce((a, b) => a + b, 0) / paidRef.length
        : c && c.served_model === run.reference_model && Number(c.cost_usd) > 0 ? Number(c.cost_usd) : null;
      const msgs = Array.isArray(req?.messages) ? req.messages.length : 0;
      return {
        // its place among all the model's answers in this look, whichever result is shown
        n: Number(x.pos) || (p - 1) * per + k + 1,
        callId: x.call_id,
        at: Number(c?.created_at) || null,
        purged,
        asked: clip(req ? lastAsked(req) : null, 2400),
        // the whole request, where it says more than what was asked last
        request: msgs > 1 ? clip(messagesText(req), 12000) : null,
        messages: msgs,
        original: refs2.map((j) => clip(j ? responseText(j) : null, 4000)),
        heldTo,
        // read back the way the test read it: a tool call as the tool it called and what it sent
        answer: purged || x.answer === null ? null : clip(responseText(asResponse(x.answer, shape)) ?? x.answer, 4000),
        score: x.score === null || x.score === undefined ? null : round8(Number(x.score)),
        // whether its score is one of those the model's figure averages
        counted: countedOf(x),
        verdict: answerVerdict(x, quality),
        difference: x.difference ? (DIFF_WORDS[x.difference] || String(x.difference)) : null,
        fields,
        values,
        compared: x.failure || x.error || !countedOf(x) ? null : comparedWords(x.judged_by, shape, true),
        /* held to "at least as good", what the judge's two readings said (readingsOf in src/eval/run.js): each one's pick,
           'answer' for this model's, 'original' or 'equal', how sure it was, and a requirement it broke or a figure it changed */
        readings: readingsWords(parse(x.readings)),
        ms: Number(ttft ? (x.ttft_ms ?? x.latency_ms) : x.latency_ms) || null,
        cost: x.cost_usd === null || x.cost_usd === undefined ? null : round8(Number(x.cost_usd)),
        reused: Number(x.reused) === 1,
        original_ms: refMs,
        original_cost: refCost === null ? null : round8(refCost),
      };
    }),
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
