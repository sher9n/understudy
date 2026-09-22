import config from '../config.js';
import { db, id, now } from '../db/index.js';
import { addActivity, track } from '../traffic.js';
import { chargeEval } from '../billing.js';
import { extract, disagreement } from '../eval/compare.js';
import { judgeBarPair } from '../eval/judge.js';
import { promote, revert, everReverted, keyOfSpec } from '../eval/promote.js';
import { upsertArm, armsFor, setStatus, referenceSpec, armKey, specOfResult, labelOf } from './arms.js';
import { posterior, probAtLeast, explorePlan, pickFrom, thompsonShares } from './bandit.js';
import { serveWith } from './serve.js';
import { requestText } from './check.js';

/* Learning, from what live calls show, which way of serving a workload works best.
 *
 * A measurement says which strategies give the customer's own answers on a sample of calls. What
 * the customer cares about is whether answers work, and that only shows on live calls, afterwards
 * (see outcomes.js). So once a workload is switched, a small share of its calls, within limits the
 * workload sets, is served another way: half by the customer's own model, as the yardstick the
 * serving strategy is held against, and half by runners-up from the last measurement that are
 * cheaper still. Each such call records the chance it had of being served that way, so what the
 * experiments show can be read fairly. Every hour the records are read again, and when the
 * evidence is strong enough the workload moves: to a cheaper runner-up that works as often, or
 * back to the customer's own model when what serves works less often than it does.
 *
 * A workload whose switches wait for approval never has an answer changed: its runners-up answer
 * copies of a few calls in the background instead, and what that shows is put in front of
 * whoever approves. */

const DAY = 86400000;
export const EXPLORE_MODES = ['off', 'shadow', 'careful', 'normal'];

const short = (m) => String(m || '').split('/').pop();
const pctOf = (x) => (x === null || x === undefined ? 'no' : `${(x * 100).toFixed(1)}%`);

/** How much a workload may experiment, and how: its own setting, or what its switching mode implies. */
export function exploreOf(workload) {
  const chosen = EXPLORE_MODES.includes(workload?.explore_mode) ? workload.explore_mode : null;
  const mode = chosen || (workload?.optimize_mode === 'ask' ? 'shadow' : 'careful');
  const share = mode === 'normal' ? config.EXPLORE_SHARE_NORMAL
    : mode === 'careful' ? config.EXPLORE_SHARE_CAREFUL
      : mode === 'shadow' ? config.SHADOW_SHARE : 0;
  const budget = workload?.explore_budget_usd;
  return {
    mode, chosen: !!chosen, share,
    budgetUsd: budget === null || budget === undefined ? config.EXPLORE_BUDGET_USD : Number(budget),
    live: mode === 'careful' || mode === 'normal',
  };
}

/* What is known about each of a workload's strategies, read at most once a minute per workload:
   the proxy asks on every call, and a record moves by one call in thousands. */
const memo = new Map();
const MEMO_MS = 60000;
export const forgetState = (workloadId = null) => { if (workloadId) memo.delete(workloadId); else memo.clear(); };

export async function stateOf(workload, { fresh = false } = {}) {
  const hit = memo.get(workload.id);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.state;
  const state = await readState(workload);
  memo.set(workload.id, { at: Date.now(), state });
  return state;
}

/* The record as last read, for the proxy, which must never wait on it: one a minute old is read
   again in the background while this call uses it, and the first call after a restart gets
   nothing, and so no experiment, rather than a slower answer. */
const refreshing = new Set();
export function peekState(workload) {
  const hit = memo.get(workload.id);
  if ((!hit || Date.now() - hit.at >= MEMO_MS) && !refreshing.has(workload.id)) {
    refreshing.add(workload.id);
    track(readState(workload)
      .then((state) => { memo.set(workload.id, { at: Date.now(), state }); })
      .finally(() => { refreshing.delete(workload.id); }), `reading what is known about ${workload.slug}`);
  }
  return hit ? hit.state : null;
}

/* Failures that are the serving side's doing: a provider that failed or could not be reached, or
   a model nobody would serve. A request the customer got wrong, or our own account, is nobody's. */
const COUNTED = `(status_code = 200 OR status_code IN (0, 404, 408, 429) OR status_code >= 500)`;

async function readState(workload) {
  const t = now();
  const settled = t - config.LEARN_SETTLE_MIN * 60000;
  // eight half-lives back, past which a call counts for less than one in two hundred
  const since = t - 8 * config.LEARN_HALF_LIFE_DAYS * DAY;
  const arms = await armsFor(workload.id);
  const baseKey = armKey(referenceSpec(workload));
  const baselineArm = arms.find((a) => a.key === baseKey) || null;

  /* Each call is held to the strategy that answered it. A call from before strategies were kept
     is held to the customer's own model when that answered it, and to the one kept strategy for
     the model that did otherwise. */
  const modelArms = new Map();
  for (const a of arms) {
    if (a.spec?.kind !== 'model') continue;
    modelArms.set(a.spec.model, modelArms.has(a.spec.model) ? null : a.id);
  }
  const rows = await db.prepare(
    `SELECT arm_id, served_model, FLOOR((? - created_at) / 86400000.0) AS age, COUNT(*) AS n,
            SUM(CASE WHEN status_code = 200 THEN COALESCE(reward, 1) ELSE 0 END) AS s,
            SUM(CASE WHEN status_code = 200 AND reward IS NOT NULL THEN 1 ELSE 0 END) AS known,
            SUM(CASE WHEN status_code <> 200 OR reward < 0.5 THEN 1 ELSE 0 END) AS failed
       FROM calls
      WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND created_at < ? AND ${COUNTED}
      GROUP BY 1, 2, 3`)
    .all(t, workload.id, since, settled);
  const live = new Map();
  const tally = new Map();
  let allN = 0;
  let allS = 0;
  for (const r of rows) {
    let armId = r.arm_id;
    if (!armId) {
      if (r.served_model === workload.reference_model) armId = baselineArm?.id || 'baseline';
      else armId = modelArms.get(r.served_model) || null;
    }
    if (!armId) continue;
    const n = Number(r.n);
    const s = Number(r.s);
    allN += n;
    allS += s;
    if (!live.has(armId)) live.set(armId, []);
    live.get(armId).push({ ageDays: Number(r.age), n, s });
    const k = tally.get(armId) || { known: 0, failed: 0 };
    k.known += Number(r.known);
    k.failed += Number(r.failed);
    tally.set(armId, k);
  }
  const shadowRows = await db.prepare(
    `SELECT arm_id, FLOOR((? - created_at) / 86400000.0) AS age, COUNT(*) AS n, SUM(agreement) AS s
       FROM shadow_runs WHERE workload_id = ? AND created_at >= ? AND agreement IS NOT NULL
      GROUP BY 1, 2`).all(t, workload.id, since);
  const shadow = new Map();
  for (const r of shadowRows) {
    if (!shadow.has(r.arm_id)) shadow.set(r.arm_id, []);
    shadow.get(r.arm_id).push({ ageDays: Number(r.age), n: Number(r.n), s: Number(r.s) });
  }

  // the workload's own rate across everything, as the starting point for a strategy with few calls
  const prior = { mean: allN >= 20 ? allS / allN : 0.95, strength: 4 };
  const opts = { halfLifeDays: config.LEARN_HALF_LIFE_DAYS, surrogateWeight: config.LEARN_SURROGATE_WEIGHT, prior };
  const ratioOf = (a) => {
    if (a.key === baseKey) return 1;
    const r = a.offline?.ratio;
    return r === null || r === undefined || !Number.isFinite(Number(r)) ? null : Number(r);
  };
  const record = (a) => ({
    ...a,
    ratio: ratioOf(a),
    post: posterior({ live: live.get(a.id) || [], shadow: shadow.get(a.id) || [] }, opts),
    failed: tally.get(a.id)?.failed ?? 0,
    known: tally.get(a.id)?.known ?? 0,
  });
  const recs = arms.map(record);
  const recById = new Map(recs.map((a) => [a.id, a]));
  const baseline = baselineArm ? recById.get(baselineArm.id)
    : {
      id: 'baseline', virtual: true, key: baseKey, kind: 'model', status: 'baseline', spec: referenceSpec(workload),
      label: `${short(workload.reference_model)} (yours)`, ratio: 1,
      post: posterior({ live: live.get('baseline') || [] }, opts),
      failed: tally.get('baseline')?.failed ?? 0, known: tally.get('baseline')?.known ?? 0,
    };
  const serving = workload.routed_arm_id ? recById.get(workload.routed_arm_id) || null : null;

  // what the day's experiments have added to the bill: the rest of the day's budget is what is left
  const day = t - DAY;
  const explored = await db.prepare(
    `SELECT arm_id, COALESCE(SUM(cost_usd), 0) AS cost FROM calls
      WHERE workload_id = ? AND explored = 1 AND created_at >= ? GROUP BY arm_id`).all(workload.id, day);
  const servingRatio = serving?.ratio ?? 1;
  let extra = 0;
  for (const e of explored) {
    const r = recById.get(e.arm_id)?.ratio ?? (e.arm_id === baseline.id ? 1 : null);
    // a runner-up cheaper than what serves added nothing; one dearer added the difference
    extra += r === null ? Number(e.cost) : Number(e.cost) * Math.max(0, 1 - servingRatio / r);
  }
  const sh = await db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM shadow_runs WHERE workload_id = ? AND created_at >= ?')
    .get(workload.id, day);
  extra += Number(sh.cost);
  return { arms: recs, byId: recById, serving, baseline, prior, extraToday: extra, at: t };
}

/* The runners-up worth trying: found by the last measurement to match, or come close, and cheaper
   than what serves now. Something dearer than what serves has nothing to offer an experiment. */
const cheaperThan = (st, ratio) => st.arms.filter((a) => a.status === 'trying' && a.ratio !== null && a.ratio < ratio);

/**
 * Which strategy answers one call, when the workload experiments: { armId, spec, propensity,
 * explored } or null to leave the serving strategy to answer as it always does.
 */
export async function chooseExplore(workload, servingArm, { rng = Math.random } = {}) {
  const s = exploreOf(workload);
  if (!s.live || !servingArm || s.share <= 0) return null;
  const st = peekState(workload);
  if (!st || st.extraToday >= s.budgetUsd) return null;
  const serving = st.byId.get(servingArm.id) || { ...servingArm, post: { a: 1, b: 1 }, ratio: null };
  const candidates = serving.ratio === null ? [] : cheaperThan(st, serving.ratio);
  const plan = explorePlan({ share: s.share, serving, candidates, baseline: st.baseline });
  if (plan.length === 1) return null;
  const pick = pickFrom(plan, rng());
  if (pick.arm.id === serving.id) {
    return { armId: serving.id, spec: serving.spec, propensity: pick.p, explored: false, shadow: null };
  }
  let arm = pick.arm;
  if (arm.virtual) {
    /* The customer's own model is kept as a strategy the first time it is used as the yardstick,
       and its record carries on under that name, so the chances of the calls after it do not
       jump while the record is read again. */
    arm = await upsertArm(workload, referenceSpec(workload), { status: 'baseline', offline: { ratio: 1 } });
    const m = memo.get(workload.id);
    if (m?.state.baseline.virtual) {
      const rec = { ...m.state.baseline, ...arm, virtual: false, ratio: 1 };
      m.state.baseline = rec;
      m.state.byId.set(arm.id, rec);
      m.state.arms.push(rec);
    }
  }
  return { armId: arm.id, spec: arm.spec, propensity: pick.p, explored: true, shadow: null, why: pick.why };
}

/* How closely a background answer matched the one that was used: 1 the same, 0 different. Free
   text is judged the way a measurement judges it; anything with a shape is compared field by
   field. */
async function agreementOf(body, used, other, shape, scope) {
  if (shape === 'free_text') {
    const a = extract(used, shape);
    const b = extract(other, shape);
    if (!a.ok) return { agreement: null, cost: 0 };
    if (!b.ok) return { agreement: 0, cost: 0, judgedBy: 'no answer' };
    const j = await judgeBarPair(requestText(body), a.value, b.value, { scope });
    return { agreement: 1 - j.score, cost: j.cost || 0, judgedBy: j.judgedBy };
  }
  const a = extract(used, shape);
  if (!a.ok) return { agreement: null, cost: 0 };
  const b = extract(other, shape);
  const d = disagreement(b, a, shape);
  return { agreement: d === null ? null : 1 - d, cost: 0, judgedBy: 'fields' };
}

/**
 * After a call is answered: now and then, a runner-up answers a copy of it in the background, and
 * how closely it matched is kept. Only for a workload whose setting is "shadow", and within its
 * budget. Nobody ever sees the background answer.
 */
export async function maybeShadow({ workload, body, response, callId = null }, { rng = Math.random, serve = serveWith } = {}) {
  const s = exploreOf(workload);
  if (s.mode !== 'shadow' || s.share <= 0 || !response) return null;
  if (rng() >= s.share) return null;
  const st = await stateOf(workload);
  if (st.extraToday >= s.budgetUsd) return null;
  const candidates = cheaperThan(st, st.serving?.ratio ?? 1);
  if (!candidates.length) return null;
  const shares = thompsonShares(candidates.map((c) => ({ id: c.id, a: c.post.a, b: c.post.b })));
  const arm = pickFrom(candidates.map((c) => ({ arm: c, p: shares.get(c.id) })), rng()).arm;
  const started = Date.now();
  let out = null;
  let status = 200;
  let reading = { agreement: null, cost: 0 };
  try {
    out = await serve(arm.spec, body, { shape: workload.shape_kind, scope: workload.workspace_id });
    reading = await agreementOf(body, response, out.json, workload.shape_kind, workload.workspace_id);
  } catch (err) {
    status = Number(err?.status) || 0;
    // our own account is nobody's answer; any other failure is a runner-up that did not answer
    reading = { agreement: status === 401 || status === 402 ? null : 0, cost: 0, judgedBy: 'failed' };
  }
  const cost = (out?.cost || 0) + (reading.cost || 0);
  const row = {
    id: id('shd'), workspace_id: workload.workspace_id, workload_id: workload.id, arm_id: arm.id, call_id: callId,
    agreement: reading.agreement, cost_usd: cost, latency_ms: out ? out.latencyMs ?? Date.now() - started : null, status,
    detail_json: JSON.stringify({ judgedBy: reading.judgedBy ?? null, escalated: out?.escalated ?? null }), created_at: now(),
  };
  await db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, call_id, agreement, cost_usd, latency_ms,
      status, detail_json, created_at) VALUES (@id, @workspace_id, @workload_id, @arm_id, @call_id, @agreement, @cost_usd,
      @latency_ms, @status, @detail_json, @created_at)`).run(row);
  if (cost > 0) await chargeEval(workload.workspace_id, cost, `Background answer for ${workload.slug} on ${arm.label}`);
  // counted against the day's budget straight away, not when the record is next read
  const m = memo.get(workload.id);
  if (m) m.state.extraToday += cost;
  return row;
}

/* What one experiment added to the bill: nothing when what answered is cheaper than what serves,
   the difference when it is dearer. Counted the moment the call ends, so a burst of calls cannot
   run past the day's budget while the record waits to be read again. */
function countSpend(workload, armId, costUsd) {
  const m = memo.get(workload.id);
  if (!m || !armId || !(costUsd > 0)) return;
  const st = m.state;
  // a strategy this record does not know yet counts in full, which can only pause experiments early
  const r = st.byId.get(armId)?.ratio ?? (armId === st.baseline.id ? 1 : null);
  const servingRatio = st.serving?.ratio ?? 1;
  st.extraToday += r === null ? costUsd : costUsd * Math.max(0, 1 - servingRatio / r);
}

/** Told about every answered call: counts an experiment's spend, and maybe answers it again in the background. */
export async function afterServed(info, opts = {}) {
  if (info.decision?.explored) countSpend(info.workload, info.decision.armId, Number(info.costUsd) || 0);
  return await maybeShadow(info, opts);
}

/** One strategy's record in the form a page shows it. */
export function readingOf(a) {
  const p = a.post;
  return {
    live: { mean: p.mean, lo: p.lo, hi: p.hi, calls: p.nLive, rate: p.liveRate, failed: a.failed, known: a.known },
    shadow: { calls: p.nShadow, rate: p.shadowRate },
    readAt: now(),
  };
}

/**
 * Read a workload's records again and act on what they show: back to the customer's own model
 * when what serves clearly works less often; on to a cheaper runner-up that clearly works as
 * often; a runner-up that clearly works less often is set aside. For a workload that waits for
 * approval, a runner-up whose background answers matched is put in front of whoever approves.
 */
export async function reviewWorkload(given, { promoteFn = promote, revertFn = revert } = {}) {
  const workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(given.id);
  if (!workload) return [];
  const s = exploreOf(workload);
  const st = await stateOf(workload, { fresh: true });
  for (const a of st.arms) {
    const prev = a.stats || {};
    await db.prepare('UPDATE arms SET stats_json = ? WHERE id = ?').run(JSON.stringify({ ...prev, ...readingOf(a) }), a.id);
  }
  const decisions = [];
  const { LEARN_TOLERANCE: delta, LEARN_CONFIDENCE: conf, LEARN_MIN_CALLS: min } = config;
  const ref = workload.reference_model;
  const serving = st.serving;
  const base = st.baseline;

  if (s.live && serving) {
    // what serves, against the customer's own model on the same weeks
    if (base.post.nLive >= Math.ceil(min / 2) && serving.post.nLive >= min) {
      const worse = 1 - probAtLeast(serving.post, base.post, delta);
      if (worse >= conf) {
        const reason = `Live results: calls on ${serving.label} worked ${pctOf(serving.post.liveRate)} of the time, `
          + `against ${pctOf(base.post.liveRate)} on ${short(ref)} (${serving.post.nLive} and ${base.post.nLive} calls). `
          + `Switched back to ${ref}.`;
        const r = await revertFn(workload, { auto: true, soft: true, reason });
        if (r?.ok) {
          forgetState(workload.id);
          decisions.push({ kind: 'revert', armId: serving.id, chance: worse });
          return decisions;
        }
      }
    }
    // a cheaper runner-up that works as often, once there is enough of it to be sure
    const ready = cheaperThan(st, serving.ratio ?? 1).filter((a) => a.post.nLive >= min)
      .sort((x, y) => x.ratio - y.ratio);
    for (const a of ready) {
      const asGood = probAtLeast(a.post, serving.post, delta);
      if (asGood < conf || workload.optimize_mode !== 'auto') continue;
      const key = keyOfSpec(a.spec, ref);
      const reason = `live results: ${a.post.nLive} calls worked ${pctOf(a.post.liveRate)} of the time, `
        + `against ${pctOf(serving.post.liveRate)} on ${serving.label}`;
      const detail = `Switched on its own by live results: its calls worked ${pctOf(a.post.liveRate)} of the time over `
        + `${a.post.nLive} calls, against ${pctOf(serving.post.liveRate)} on ${serving.label}, and it costs `
        + `${Math.round((1 - a.ratio / (serving.ratio || 1)) * 100)}% less.`;
      const r = await promoteFn(workload, key, { auto: true, reason, spec: a.spec, runId: a.origin_run_id ?? null, detail });
      if (r?.ok && !r.already) {
        forgetState(workload.id);
        decisions.push({ kind: 'promote', armId: a.id, chance: asGood });
        return decisions;
      }
    }
  }
  // a runner-up that clearly works less often than what serves is not tried any more
  if (serving) {
    for (const a of st.arms.filter((x) => x.status === 'trying' && x.post.nLive >= Math.ceil(min / 2))) {
      const worse = 1 - probAtLeast(a.post, serving.post, delta);
      if (worse < conf) continue;
      await setStatus(a.id, 'resting');
      await addActivity(workload.workspace_id, {
        kind: 'floor',
        title: `Stopped trying ${a.label} on ${workload.slug}`,
        detail: `Its calls worked ${pctOf(a.post.liveRate)} of the time over ${a.post.nLive} calls, against `
          + `${pctOf(serving.post.liveRate)} on ${serving.label}.`,
        workloadId: workload.id,
      });
      decisions.push({ kind: 'rest', armId: a.id, chance: worse });
    }
  }
  // for approval: background answers that matched the live ones inside the workload's bar
  if (s.mode === 'shadow') {
    const floor = Number(workload.floor_pct) || config.EVAL_FLOOR_MIN_PCT;
    for (const a of st.arms.filter((x) => x.status === 'trying' && x.post.nShadow >= min && !x.stats?.suggestedAt)) {
      if ((1 - a.post.shadowRate) * 100 > floor) continue;
      await addActivity(workload.workspace_id, {
        kind: 'ok',
        title: `${a.label} matched your live answers on ${workload.slug}`,
        detail: `In the background it answered ${a.post.nShadow} of your live calls and matched ${pctOf(a.post.shadowRate)} of them, `
          + `inside your ${floor.toFixed(1)}% bar. Nothing was changed: approve it on the workload's page to switch.`,
        workloadId: workload.id,
      });
      await db.prepare('UPDATE arms SET stats_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...(a.stats || {}), ...readingOf(a), suggestedAt: now() }), a.id);
      decisions.push({ kind: 'suggest', armId: a.id });
    }
  }
  return decisions;
}

/** Every workload with something to learn about. */
export async function reviewAll() {
  const rows = await db.prepare(
    `SELECT DISTINCT w.id FROM workloads w JOIN arms a ON a.workload_id = w.id
      WHERE a.status IN ('serving', 'trying', 'baseline') AND w.merged_into IS NULL`).all();
  let acted = 0;
  for (const r of rows) {
    try {
      acted += (await reviewWorkload(r)).length;
    } catch (err) {
      console.error(`learning review of ${r.id} failed: ${err?.message || err}`);
    }
  }
  return { workloads: rows.length, acted };
}

/**
 * At the end of a measurement: what it found worth trying is kept as a runner-up, with what the
 * measurement said about it. A runner-up it no longer vouches for is set aside, and one switched
 * back for good stays out.
 */
export async function markTrying(workload, { runId, results, refMonthly, floor }) {
  const keep = new Set();
  for (const r of results) {
    if (r.verdict === 'reference' || r.stopped || !['cleared', 'review'].includes(r.verdict)) continue;
    if (refMonthly !== null && (r.cost_month_usd === null || r.cost_month_usd >= refMonthly)) continue;
    if (await everReverted(workload.id, r.model_id)) continue;
    const ratio = r.cost_ratio ?? (refMonthly ? r.cost_month_usd / refMonthly : null);
    const arm = await upsertArm(workload, specOfResult(r), {
      originRunId: runId,
      offline: { verdict: r.verdict, gap: r.gap_pct, floor, ratio, escalatedPct: r.escalated_pct ?? null, runs: r.runs, runId, at: now() },
    });
    keep.add(arm.id);
    if (!['serving', 'retired', 'baseline'].includes(arm.status)) await setStatus(arm.id, 'trying');
  }
  for (const a of await armsFor(workload.id)) {
    if (a.status === 'trying' && !keep.has(a.id)) await setStatus(a.id, 'resting');
  }
  forgetState(workload.id);
  return keep.size;
}

/** Everything a page needs to show what is being learned about one workload. */
export async function learningView(workload) {
  const s = exploreOf(workload);
  const st = await stateOf(workload, { fresh: true });
  const ref = workload.reference_model;
  const share = await db.prepare(
    `SELECT COALESCE(arm_id, '') AS arm, served_model, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN explored = 1 THEN 1 ELSE 0 END), 0) AS explored,
            COALESCE(SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END), 0) AS escalated,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM calls WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND ${COUNTED}
      GROUP BY 1, 2`).all(workload.id, now() - 7 * DAY);
  const week = new Map();
  let weekCalls = 0;
  for (const r of share) {
    let armId = r.arm || null;
    if (!armId && r.served_model === ref) armId = st.baseline.id;
    if (!armId) continue;
    const w = week.get(armId) || { calls: 0, explored: 0, escalated: 0, cost: 0 };
    w.calls += Number(r.n);
    w.explored += Number(r.explored);
    w.escalated += Number(r.escalated);
    w.cost += Number(r.cost);
    week.set(armId, w);
    weekCalls += Number(r.n);
  }
  const shape = (a, role) => ({
    id: a.virtual ? null : a.id, role, label: a.label || labelOf(a.spec, ref), kind: a.kind || a.spec?.kind, status: a.status,
    spec: a.spec, ratio: a.ratio, offline: a.offline ?? null, ...readingOf(a),
    week: week.get(a.id) || { calls: 0, explored: 0, escalated: 0, cost: 0 },
  });
  const serving = st.serving ? shape(st.serving, 'serving') : null;
  const baseline = shape(st.baseline, 'yardstick');
  const others = st.arms.filter((a) => a.id !== st.serving?.id && a.id !== st.baseline.id && ['trying', 'resting'].includes(a.status))
    .map((a) => shape(a, a.status === 'trying' ? 'runner-up' : 'set aside'));
  const shadows = await db.prepare(
    `SELECT s.arm_id, s.agreement, s.cost_usd, s.created_at FROM shadow_runs s WHERE s.workload_id = ?
      ORDER BY s.created_at DESC LIMIT 40`).all(workload.id);
  const spent = await db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM shadow_runs WHERE workload_id = ?').get(workload.id);
  return {
    explore: { ...s, spentToday: st.extraToday, reason: whyNot(workload, s, st) },
    tolerance: config.LEARN_TOLERANCE, confidence: config.LEARN_CONFIDENCE, minCalls: config.LEARN_MIN_CALLS,
    halfLifeDays: config.LEARN_HALF_LIFE_DAYS, weekCalls,
    serving, baseline, others,
    shadow: { recent: shadows.map((r) => ({ ...r, agreement: r.agreement === null ? null : Number(r.agreement) })), spentUsd: Number(spent.c) },
  };
}

/* Why a workload is not experimenting right now, in words for its page, or null when it is. */
function whyNot(workload, s, st) {
  if (s.mode === 'off') return 'Experiments are off for this workload.';
  if (st.extraToday >= s.budgetUsd) return `Today's experiments have used the $${s.budgetUsd.toFixed(2)} budget, so they pause until tomorrow.`;
  if (s.live && !workload.routed_model) return 'Live experiments start once this workload is switched to something cheaper.';
  if (s.mode === 'shadow' && !cheaperThan(st, st.serving?.ratio ?? 1).length) {
    return 'Background answers start once a measurement finds a runner-up that is cheaper than what answers now.';
  }
  return null;
}
