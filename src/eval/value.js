import { db, now, round8 } from '../db/index.js';
import config from '../config.js';
import { routedSavings } from './actual.js';
import { withFeeOn } from './savings.js';
import { armById, nameOfResult } from '../learn/arms.js';
import { trafficOf } from './promote.js';
import { cadenceOf } from './schedule.js';
import { OUTCOME_OF } from './outcome.js';
import { COUNTED, GROUPS, grouped, settledAt } from '../learn/views.js';
import { zdrFor } from '../workspace.js';

/* What Understudy is doing for one workload, in the numbers its page leads with: what its calls cost
 * through us against the customer's own model alone, whether answers still work as often, whether they
 * come as fast, how many calls were rescued when a provider failed, how its calls are served and what
 * each path costs, and what has happened since the workload was first seen.
 *
 * Every figure is read from the record, never assumed:
 *   money      the last 30 days of calls through us, paid (our fee included) plus what testing and
 *              reading answers in the background cost, against what the same calls would have cost on
 *              the customer's own model without us (src/eval/actual.js);
 *   quality    how often answers worked, counted the way every screen counts it (src/learn/views.js), on
 *              the calls what serves now answered, against the customer's own model's calls in the 30
 *              days before the switch;
 *   speed      the middle time to an answer (to the first word, where most calls stream), the same two
 *              ways;
 *   rescued    tries that failed (a provider down, busy or too slow) whose call was then answered another
 *              way, the next in line or the customer's own model, so the app saw no error;
 *   paths      calls a day, and for a strategy that sends some calls on, what share it sends and what
 *              each path costs; for a router by kind of request, the share each of its setups answered;
 *   history    what was saved each day since the workload was first seen, net of testing, and the events
 *              along the way: the first call, each measurement, each switch and switch-back, each step of
 *              a rollout, each background trial, and each hour a provider failed and calls were rescued.
 * A figure the record cannot give comes back null, for the page to say so rather than show a zero. */

const DAY = 86400000;
const HOUR = 3600000;
const short = (m) => String(m || '').split('/').pop();
// a try that failed and was answered another way: not a call of the customer's, but the evidence of a rescue
const TRY = `COALESCE(check_json LIKE '%"by":"fell back"%' OR check_json LIKE '%"by":"experiment failed"%', FALSE)`;

/* What testing this workload cost from a moment on, our fee included: measurements, background answers,
   answers read in the background and answers checked against the customer's own model after a switch,
   the four things that are charged as optimizing. */
async function optimizingSince(workloadId, since) {
  const spent = Number((await db.prepare(
    'SELECT COALESCE(SUM(spend_usd), 0) AS s FROM eval_runs WHERE workload_id = ? AND created_at >= ?').get(workloadId, since)).s);
  const background = Number((await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM shadow_runs WHERE workload_id = ? AND created_at >= ?').get(workloadId, since)).s);
  const graded = Number((await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM graded_calls WHERE workload_id = ? AND created_at >= ?').get(workloadId, since)).s);
  const checked = Number((await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM control_checks WHERE workload_id = ? AND created_at >= ?').get(workloadId, since)).s);
  return round8(withFeeOn(spent + background + graded + checked, config.ROUTING_FEE_PCT));
}

/* The same, a day at a time, for the history's line: each day labelled by the moment it ends, as
   routedSavings labels its days. */
async function optimizingByDay(workloadId, first, days) {
  const out = new Array(days).fill(0);
  const add = (rows) => {
    for (const r of rows) {
      const b = Number(r.b);
      if (b >= 0 && b < days) out[b] += Number(r.s);
    }
  };
  const bucket = `LEAST(${days - 1}, GREATEST(0, CEIL((created_at - ?::bigint) / 86400000.0)))::int`;
  add(await db.prepare(`SELECT ${bucket} AS b, SUM(spend_usd) AS s FROM eval_runs WHERE workload_id = ? AND created_at >= ? GROUP BY 1`)
    .all(first, workloadId, first - DAY));
  add(await db.prepare(`SELECT ${bucket} AS b, SUM(cost_usd) AS s FROM shadow_runs WHERE workload_id = ? AND created_at >= ? GROUP BY 1`)
    .all(first, workloadId, first - DAY));
  add(await db.prepare(`SELECT ${bucket} AS b, SUM(cost_usd) AS s FROM graded_calls WHERE workload_id = ? AND created_at >= ? GROUP BY 1`)
    .all(first, workloadId, first - DAY));
  add(await db.prepare(`SELECT ${bucket} AS b, SUM(cost_usd) AS s FROM control_checks WHERE workload_id = ? AND created_at >= ? GROUP BY 1`)
    .all(first, workloadId, first - DAY));
  return out.map((v) => withFeeOn(v, config.ROUTING_FEE_PCT));
}

/* The calls a way of serving answered for the customer: routed, not a failed try, and its own (by its
   strategy, or for a switch made before strategies were kept, by the model). */
function servedBy(w, switched) {
  if (switched) {
    return { sql: `source = 'routed' AND NOT ${TRY} AND (arm_id = ? OR (arm_id IS NULL AND served_model = ?))`,
      args: [w.routed_arm_id ?? '', w.routed_model] };
  }
  return { sql: `NOT ${TRY} AND served_model = ?`, args: [w.reference_model] };
}

async function workedRate(w, where, from, to) {
  const at = settledAt();
  const r = await db.prepare(`SELECT ${GROUPS} FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND created_at < ? AND ${COUNTED} AND ${where.sql}`)
    .get(at, at, w.id, from, to, ...where.args);
  const g = grouped(r);
  return g.calls > 0 && g.rate !== null ? { rate: round8(g.rate), calls: g.calls } : null;
}

async function middleTime(w, where, from, to, metric) {
  const col = metric === 'ttft' ? 'ttft_ms' : 'latency_ms';
  const r = await db.prepare(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${col}) AS p, COUNT(${col}) AS n FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND created_at < ? AND status_code = 200
        AND ${col} > 0 AND ${where.sql}`).get(w.id, from, to, ...where.args);
  return Number(r?.n) > 0 && r.p !== null ? { ms: Math.round(Number(r.p)), calls: Number(r.n) } : null;
}

/* Tries that failed and whose call was then answered, found by the request they share: the answer is
   the same request, from the same workload, within ten minutes of the try, and it succeeded. Looked up
   by workspace and request first, which is how the calls are indexed (ix_calls_ws_request): a busy
   workload is never read end to end for each try. */
const RESCUED = `FROM calls f WHERE f.workload_id = ? AND f.source = 'routed' AND f.created_at >= ?
    AND COALESCE(f.check_json LIKE '%"by":"fell back"%' OR f.check_json LIKE '%"by":"experiment failed"%', FALSE)
    AND f.request_hash IS NOT NULL
    AND EXISTS (SELECT 1 FROM calls a WHERE a.workspace_id = f.workspace_id AND a.request_hash = f.request_hash
      AND a.workload_id = f.workload_id
      AND a.id <> f.id AND a.status_code = 200 AND a.created_at >= f.created_at AND a.created_at <= f.created_at + 600000
      AND NOT COALESCE(a.check_json LIKE '%"by":"fell back"%' OR a.check_json LIKE '%"by":"experiment failed"%', FALSE))`;

/** A strategy's label in words, from a measurement's own name for it. */
async function labelOfKey(workloadId, key, reference) {
  if (!key) return null;
  if (key === reference) return `${short(reference)} (your own model)`;
  const r = await db.prepare(`SELECT e.model_id, e.arm_json FROM eval_results e JOIN eval_runs r ON r.id = e.run_id
      WHERE r.workload_id = ? AND e.model_id = ? ORDER BY r.created_at DESC LIMIT 1`).get(workloadId, key);
  if (r?.arm_json) return nameOfResult(r).label;
  return short(key);
}

export async function valueOf(w) {
  const t = now();
  const since = t - 30 * DAY;
  const ref = w.reference_model;
  const switched = !!w.routed_model;
  /* A switch made for a workload whose requests reach us only as copies waits for the first one that
     comes through us. Until then the customer's own model answers every request at their own provider,
     and that is what the figures read: its answers, its times. */
  const waiting = switched && !(await trafficOf(w)).carries;
  const serves = switched && !waiting;
  const at = serves ? Number(w.promoted_at) || null : null;
  const arm = w.routed_arm_id ? await armById(w.routed_arm_id) : null;
  const serving = servedBy(w, serves);
  const own = servedBy({ ...w, routed_model: null }, false);

  // money: the last thirty days of calls through us, testing included, against the customer's own model alone
  const s30 = await routedSavings({ workspaceId: w.workspace_id, workloadId: w.id, days: 30, at: t });
  const optimizing = await optimizingSince(w.id, since);
  const money = {
    calls: s30.calls,
    paid: s30.paid,
    optimizing,
    now: round8(s30.paid + optimizing),
    before: s30.would,
    saved: round8(s30.would - s30.paid - optimizing),
    feePct: config.ROUTING_FEE_PCT,
  };

  // quality and speed: what serves now, since it began (at most thirty days), against the customer's own model before it
  const nowFrom = Math.max(since, at || 0);
  const beforeFrom = at ? at - 30 * DAY : null;
  const streamed = await db.prepare(`SELECT COUNT(*) AS n, COUNT(ttft_ms) AS s FROM calls
      WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND status_code = 200`).get(w.id, since);
  const metric = Number(streamed.n) > 0 && Number(streamed.s) / Number(streamed.n) >= 0.5 ? 'ttft' : 'latency';
  const quality = {
    now: await workedRate(w, serving, nowFrom, t),
    before: at ? await workedRate(w, own, beforeFrom, at) : null,
  };
  const speed = {
    metric,
    now: await middleTime(w, serving, nowFrom, t, metric),
    before: at ? await middleTime(w, own, beforeFrom, at, metric) : null,
  };

  // requests rescued in the last thirty days
  const rescued = Number((await db.prepare(`SELECT COUNT(*) AS n ${RESCUED}`).get(w.id, since)).n);

  // the paths: calls a day over the last week, and for a strategy that sends some on, the share and each path's cost
  const weekFrom = Math.max(t - 7 * DAY, at || 0);
  const week = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS first,
        COUNT(*) FILTER (WHERE escalated = 1) AS sent_on,
        COALESCE(SUM(charged_usd), 0) AS paid,
        COALESCE(SUM(charged_usd) FILTER (WHERE COALESCE(escalated, 0) = 0), 0) AS short_paid,
        COALESCE(SUM(charged_usd) FILTER (WHERE escalated = 1), 0) AS long_paid
      FROM calls WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND status_code = 200 AND ${serving.sql}`)
    .get(w.id, weekFrom, ...serving.args);
  const allWeek = await db.prepare(`SELECT COUNT(*) FILTER (WHERE source = 'routed') AS n,
        COUNT(*) FILTER (WHERE source = 'trace') AS copies, MIN(created_at) AS first FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') AND created_at >= ? AND NOT ${TRY}`).get(w.id, t - 7 * DAY);
  const weekDays = Number(allWeek.n) + Number(allWeek.copies) > 0 ? Math.max(1, Math.min(7, (t - Number(allWeek.first)) / DAY)) : 7;
  const n = Number(week.n);
  const sentOn = Number(week.sent_on);
  const kind = arm?.spec?.kind ?? (switched ? 'model' : 'reference');
  /* For a router by kind of request, which of its setups answered the week's requests it did not send to
     the customer's own model, and what each of those cost: it can send them to several. Read from the kind
     each call was taken for (its check says) through the router's own table, so two setups of one model
     (the customer's own thinking less, and from its cheapest provider) are told apart; read by the model
     that answered, they were one. */
  let byOption = null;
  if (kind === 'router' && Array.isArray(arm?.spec?.options) && n >= 20) {
    const rows = await db.prepare(`SELECT substring(check_json from '"kind":([0-9]+)') AS k, COUNT(*) AS n,
          COALESCE(SUM(charged_usd), 0) AS paid FROM calls
        WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND status_code = 200 AND COALESCE(escalated, 0) = 0
          AND ${serving.sql} GROUP BY 1`).all(w.id, weekFrom, ...serving.args);
    const table = Array.isArray(arm.spec.table) ? arm.spec.table : [];
    const sums = arm.spec.options.map(() => ({ n: 0, paid: 0 }));
    for (const r of rows) {
      const j = r.k === null || r.k === undefined ? -1 : table[Number(r.k)];
      if (Number.isInteger(j) && j >= 0 && sums[j]) { sums[j].n += Number(r.n); sums[j].paid += Number(r.paid); }
    }
    byOption = sums.map((x, j) => ({ option: j, share: round8(x.n / n), perCall: x.n > 0 ? round8(x.paid / x.n) : null }));
  }
  const paths = {
    kind,
    perDay: Number(allWeek.n) > 0 ? round8(Number(allWeek.n) / weekDays) : 0,
    // requests that reach us only as copies, after the customer's own provider has answered them
    copiesPerDay: Number(allWeek.copies) > 0 ? round8(Number(allWeek.copies) / weekDays) : 0,
    // while a switch is still taking over, the share of requests it answers; the rest go to the customer's own model
    rolloutShare: w.rollout_share === null || w.rollout_share === undefined ? null : Number(w.rollout_share),
    calls: n,
    // the share sent the long way, read from live calls once there are enough of them
    sentOn: (kind === 'cascade' || kind === 'router') && n >= 20 ? round8(sentOn / n) : null,
    perCall: n > 0 ? round8(Number(week.paid) / n) : null,
    shortPerCall: n - sentOn > 0 ? round8(Number(week.short_paid) / (n - sentOn)) : null,
    longPerCall: sentOn > 0 ? round8(Number(week.long_paid) / sentOn) : null,
    byOption,
    // what one of these calls would cost on the customer's own model alone, from the last thirty days
    ownPerCall: s30.calls > 0 && s30.would > 0 ? round8(s30.would / s30.calls) : null,
  };

  // history: saved each day since the workload was first seen, net of testing, and the events along the way
  // the first request: through us, or a copy of one the customer's own provider had answered
  const first = await db.prepare(`SELECT created_at AS at, source FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') ORDER BY created_at LIMIT 1`).get(w.id);
  const firstSeen = Number(first?.at) || null;
  let history = { series: [], saved: 0, testing: 0, events: [], firstSeen };
  if (firstSeen) {
    const days = Math.max(2, Math.min(365, Math.ceil((t - firstSeen) / DAY) + 1));
    const life = await routedSavings({ workspaceId: w.workspace_id, workloadId: w.id, days, at: t });
    const testing = await optimizingByDay(w.id, t - (days - 1) * DAY, days);
    let total = 0;
    const series = life.series.map((d, i) => {
      total += d.would - d.paid - testing[i];
      return { at: d.at, saved: round8(total) };
    });
    // what testing cost over the same days, so a shortfall can say whether it was testing, the fee, or both
    history = { series, saved: round8(total), testing: round8(testing.reduce((a, b) => a + b, 0)),
      events: await eventsOf(w, firstSeen, t, first.source), firstSeen };
  }

  return {
    reference: ref,
    switched,
    // set up and waiting for the first request that comes through us, the customer's own model answering until then
    waiting,
    switchedAt: at,
    label: arm?.label ?? null,
    spec: arm?.spec ?? null,
    money, quality, speed,
    rescued: { count: rescued, days: 30 },
    paths,
    history,
    /* What holds for every request, as this workspace has it set: whether providers must delete what they
       are sent (otherwise they are still never ones that train on it), the shares a new setup takes over
       in, and whether this workload switches by itself. */
    guards: { zdr: await zdrFor(w.workspace_id), stages: config.ROLLOUT_STAGES, mode: w.optimize_mode },
    tests: await testsOf(w),
    at: t,
  };
}

/* Whether this workload has been tested, and if not, when the first test starts: by itself once it has
   seen EVAL_FIRST_RUN_MIN_CALLS requests (src/proxy.js considerMeasuring), in a workspace that tests on a
   schedule; only when asked in one that does not. Counted the way that decision counts them. */
async function testsOf(w) {
  const runs = Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ?').get(w.id)).n);
  const auto = (await cadenceOf(w.workspace_id)) > 0;
  if (runs > 0) return { runs, auto };
  const seen = Number((await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?').get(w.id)).n);
  return { runs, auto, seen, firstAfter: config.EVAL_FIRST_RUN_MIN_CALLS };
}

/* What happened to a workload, oldest first, as facts for its page to put into words. */
async function eventsOf(w, firstSeen, t, via) {
  const ref = w.reference_model;
  const events = [{ at: firstSeen, kind: 'connected', via }];

  const runs = await db.prepare(`SELECT r.id, r.trigger, COALESCE(r.finished_at, r.created_at) AS at, r.spend_usd,
        ${OUTCOME_OF('r.')} AS outcome, r.floor_pct, r.routing_mode, r.choice_json
      FROM eval_runs r WHERE r.workload_id = ? AND r.status = 'done' ORDER BY r.created_at`).all(w.id);
  for (const r of runs) {
    const results = await db.prepare(`SELECT model_id, verdict, cost_month_usd, arm_json, choice_rank, confirm_verdict FROM eval_results
        WHERE run_id = ? AND verdict <> 'reference'`).all(r.id);
    const passed = results.filter((x) => x.verdict === 'cleared');
    const nameOf = (x) => (x.arm_json ? nameOfResult(x).label : short(x.model_id));
    const best = passed.filter((x) => x.cost_month_usd !== null)
      .sort((a, b) => Number(a.cost_month_usd) - Number(b.cost_month_usd))[0] ?? passed[0] ?? null;
    /* The one the test chose, under the routing priority it ran under: the first in its order that passed its
       second look, or the one already serving that was kept. The cheapest that passed is not always it: a setup
       a hair dearer and much faster comes first under balanced. A test from before there was an order has none. */
    let record = null;
    try { record = JSON.parse(r.choice_json || 'null'); } catch { record = null; }
    const kept = record?.servingKept ?? null;
    // what the test chose, as it wrote it down; worked out from the ranks only for a test from before it did
    const written = !!record && Object.prototype.hasOwnProperty.call(record, 'chosen');
    const chosen = written ? (record.chosen ? passed.find((x) => x.model_id === record.chosen) ?? null : null)
      : passed.filter((x) => Number(x.choice_rank) > 0).sort((a, b) => Number(a.choice_rank) - Number(b.choice_rank))
        .find((x) => x.confirm_verdict === 'cleared' || x.model_id === kept) ?? null;
    events.push({
      at: Number(r.at), kind: 'test', trigger: r.trigger, outcome: r.outcome,
      tried: results.length, passed: passed.length,
      best: best ? nameOf(best) : null,
      chosen: chosen ? nameOf(chosen) : null,
      chosenKept: !!chosen && (written ? !!record.chosenKept : chosen.model_id === kept), mode: r.routing_mode ?? null,
      spend: round8(withFeeOn(Number(r.spend_usd) || 0, config.ROUTING_FEE_PCT)),
      bar: r.floor_pct === null ? null : Number(r.floor_pct),
    });
  }

  const promos = await db.prepare(`SELECT action, from_model, to_model, reason, actor_user_id, created_at FROM promotions
      WHERE workload_id = ? ORDER BY created_at`).all(w.id);
  for (const p of promos) {
    /* A switch back goes to the customer's own model, or, for a switch rolled back while it was still
       taking over, to the strategy it was replacing, which the row names by its key. */
    const to = p.to_model && p.to_model !== ref ? await labelOfKey(w.id, p.to_model, ref) : short(ref);
    const back = p.action !== 'promote';
    events.push({
      at: Number(p.created_at),
      kind: back ? 'back' : 'switch',
      by: p.actor_user_id ? 'you' : 'automatic',
      to,
      toOwn: !p.to_model || p.to_model === ref,
      // what was switched back from, by its key, so a setup tested again can say it was switched back before
      ...(back ? { fromKey: p.from_model || null } : {}),
      reason: p.reason || null,
    });
  }

  /* The steps of a rollout are said in the activity feed as they happen, and read from there: "… now
     answers 25% of …" and "… now answers all of …". */
  const steps = await db.prepare(`SELECT title, created_at FROM activity WHERE workload_id = ? AND kind = 'ok'
      AND (title LIKE '% now answers %' ) ORDER BY created_at`).all(w.id);
  for (const s of steps) {
    const pct = /now answers (\d+)% of/.exec(s.title);
    const all = / now answers all of /.test(s.title);
    if (pct || all) events.push({ at: Number(s.created_at), kind: 'step', share: all ? 1 : Number(pct[1]) / 100 });
  }

  // each runner-up's first answer in the background, which is when its trial began
  const trials = await db.prepare(`SELECT s.arm_id, MIN(s.created_at) AS at, COUNT(*) AS n, a.label FROM shadow_runs s
      LEFT JOIN arms a ON a.id = s.arm_id WHERE s.workload_id = ? GROUP BY s.arm_id, a.label ORDER BY 2`).all(w.id);
  for (const tr of trials) events.push({ at: Number(tr.at), kind: 'trial', label: tr.label || 'a runner-up', answers: Number(tr.n) });

  // each hour in which a provider failed and three or more calls were rescued
  const bad = await db.prepare(`SELECT (f.created_at / ${HOUR}) * ${HOUR} AS h, COUNT(*) AS n ${RESCUED}
      GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY 1`).all(w.id, firstSeen);
  for (const b of bad) events.push({ at: Number(b.h), kind: 'outage', rescued: Number(b.n) });

  // a cheaper setup found on live calls and waiting for a person, as the activity feed said it
  const ready = await db.prepare(`SELECT title, created_at FROM activity WHERE workload_id = ? AND kind = 'ok'
      AND (title LIKE '% is ready to approve on %' OR title LIKE '% matched your live answers on %') ORDER BY created_at`).all(w.id);
  for (const r of ready) {
    const label = r.title.split(/ is ready to approve on | matched your live answers on /)[0];
    events.push({ at: Number(r.created_at), kind: 'ready', label });
  }

  return events.filter((e) => e.at <= t).sort((a, b) => a.at - b.at);
}
