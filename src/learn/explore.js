import config from '../config.js';
import { db, id, now } from '../db/index.js';
import { addActivity, track } from '../traffic.js';
import { chargeEval } from '../billing.js';
import { extract, disagreement } from '../eval/compare.js';
import { judgeBarPair } from '../eval/judge.js';
import { promote, revert, everReverted, keyOfSpec } from '../eval/promote.js';
import { upsertArm, armsFor, setStatus, referenceSpec, armKey, specOfResult, labelOf } from './arms.js';
import { posterior, explorePlan, pickFrom, thompsonShares } from './bandit.js';
import { decide } from './decide.js';
import { serveWith } from './serve.js';
import { requestText } from './check.js';
import { memo, forgetState } from './memo.js';
import { account } from '../billing.js';

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

/**
 * How much a workload may experiment, and how: its own setting, or what its switching mode implies.
 * In "normal" mode the share grows on a quiet workload, so the customer's own model answers about
 * eight calls a day as the yardstick whatever the volume; "careful" stays at its small share.
 */
export function exploreOf(workload, { perDay = null } = {}) {
  const chosen = EXPLORE_MODES.includes(workload?.explore_mode) ? workload.explore_mode : null;
  const mode = chosen || (workload?.optimize_mode === 'ask' ? 'shadow' : 'careful');
  let share = mode === 'normal' ? config.EXPLORE_SHARE_NORMAL
    : mode === 'careful' ? config.EXPLORE_SHARE_CAREFUL
      : mode === 'shadow' ? config.SHADOW_SHARE : 0;
  if (mode === 'normal' && perDay > 0) {
    share = Math.max(share, Math.min(config.EXPLORE_SHARE_MAX, (2 * config.EXPLORE_YARDSTICK_PER_DAY) / perDay));
  }
  const budget = workload?.explore_budget_usd;
  return {
    mode, chosen: !!chosen, share,
    budgetUsd: budget === null || budget === undefined ? config.EXPLORE_BUDGET_USD : Number(budget),
    live: mode === 'careful' || mode === 'normal',
  };
}

/* What is known about each of a workload's strategies, read at most once a minute per workload:
   the proxy asks on every call, and a record moves by one call in thousands. */
const MEMO_MS = 60000;
export { forgetState };

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
// a call the strategy failed and the customer's own model answered, for a reason of the strategy's, counts against it
const COUNTED = `(status_code = 200 OR status_code IN (0, 404, 408, 429) OR status_code >= 500 OR check_json LIKE '%"by":"fell back"%')`;
/* And only calls whose outcomes could be read at all: those recorded since outcomes were kept, which
   carry their fingerprint. An older call has no signals, so it can only ever read as having worked,
   and counted in, the customer's own model's months of history outvoted the serving strategy's first
   weeks, whose failures were being seen, and switched workloads back on no real difference. */
const READABLE = `request_hash IS NOT NULL`;
const IST = 5.5 * 3600000;
// the start of today, as the day is counted in India, where this product's days are told
const istDayStart = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const modelsOf = (spec) => (!spec ? []
  : spec.kind === 'cascade' ? [spec.first.model, spec.fallback.model]
    : spec.kind === 'router' ? [spec.cheap.model, spec.strong.model] : [spec.model]);

async function readState(workload) {
  const t = now();
  const settled = t - config.LEARN_SETTLE_MIN * 60000;
  // eight half-lives back, past which a call counts for less than one in two hundred
  const since = t - 8 * config.LEARN_HALF_LIFE_DAYS * DAY;
  const arms = await armsFor(workload.id);
  const baseKey = armKey(referenceSpec(workload));
  const baselineArm = arms.find((a) => a.key === baseKey) || null;
  /* How long a signal takes to arrive here, from the ones that have: a call only joins a record once
     that long has passed, for every strategy alike. Judged sooner, a runner-up's fresh calls all read
     as worked while the serving strategy's had time to be corrected. */
  const delay = await db.prepare(
    `SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY o.occurred_at - c.created_at) AS ms
       FROM outcomes o JOIN calls c ON c.id = o.call_id
      WHERE o.workload_id = ? AND o.kind <> 'reported' AND o.occurred_at >= c.created_at AND o.occurred_at >= ?`)
    .get(workload.id, t - 30 * DAY);
  const settleMs = Math.round(Math.max(config.LEARN_SETTLE_MIN * 60000, Math.min(DAY, Number(delay?.ms) || 0)));
  const settledAt = t - settleMs;
  // how often anything is ever seen about a call here: what "worked" can mean on this workload
  const seenRow = await db.prepare(
    `SELECT COUNT(*) AS n, COUNT(reward) AS known FROM calls
      WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND created_at < ? AND ${COUNTED} AND ${READABLE}`)
    .get(workload.id, since, settledAt);
  const detection = Number(seenRow?.n) ? Number(seenRow.known) / Number(seenRow.n) : 0;
  const def = await db.prepare('SELECT events_json FROM outcome_defs WHERE workload_id = ?').get(workload.id);
  let hasEvents = false;
  try { hasEvents = JSON.parse(def?.events_json || '[]').length > 0; } catch { hasEvents = false; }
  // the volume, for sizing experiments and saying how long evidence will take
  const vol = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS first FROM calls
      WHERE workload_id = ? AND source = 'routed' AND created_at >= ?`).get(workload.id, t - 7 * DAY);
  const perDay = Number(vol?.n) ? Number(vol.n) / Math.max(1, Math.min(7, (t - Number(vol.first)) / DAY)) : 0;

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
      WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND created_at < ? AND ${COUNTED} AND ${READABLE}
      GROUP BY 1, 2, 3`)
    .all(t, workload.id, since, settledAt);
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
  /* The fair comparison, for decisions: only calls since learning began on this workload (its first
     switch), each held to the strategy that answered it by the chance it was given, and only from
     hours when an experiment was possible: what serves, the runners-up and the customer's own model
     then answered calls of the same days and hours, picked by chance, so a difference between them is
     the strategies' and not the season's or the time of day's. A call what serves answered while the
     day's budget was spent (chance 1) is left out of its fair record for that reason. The customer's
     model keeps its record across switches: it is the same yardstick throughout. */
  const began = Number((await db.prepare(
    `SELECT MIN(created_at) AS at FROM promotions WHERE workload_id = ? AND action = 'promote'`).get(workload.id))?.at) || 0;
  const fairRows = began ? await db.prepare(
    `SELECT arm_id, FLOOR((? - created_at) / 86400000.0) AS age, COUNT(*) AS n,
            SUM(CASE WHEN status_code = 200 THEN COALESCE(reward, 1) ELSE 0 END) AS s
       FROM calls
      WHERE workload_id = ? AND source = 'routed' AND arm_id IS NOT NULL AND created_at >= ? AND created_at < ?
        AND ${COUNTED} AND ${READABLE} AND (explored = 1 OR propensity < 1)
      GROUP BY 1, 2`).all(t, workload.id, Math.max(began, since), settledAt) : [];
  const fair = new Map();
  for (const r of fairRows) {
    if (!fair.has(r.arm_id)) fair.set(r.arm_id, []);
    fair.get(r.arm_id).push({ ageDays: Number(r.age), n: Number(r.n), s: Number(r.s) });
  }
  const shadowRows = await db.prepare(
    `SELECT arm_id, FLOOR((? - created_at) / 86400000.0) AS age, COUNT(*) AS n, SUM(agreement) AS s,
            SUM(CASE WHEN agreement >= 0.999 THEN 1 ELSE 0 END) AS same
       FROM shadow_runs WHERE workload_id = ? AND created_at >= ? AND agreement IS NOT NULL
      GROUP BY 1, 2`).all(t, workload.id, since);
  const shadow = new Map();
  const same = new Map();
  for (const r of shadowRows) {
    if (!shadow.has(r.arm_id)) shadow.set(r.arm_id, []);
    shadow.get(r.arm_id).push({ ageDays: Number(r.age), n: Number(r.n), s: Number(r.s) });
    same.set(r.arm_id, (same.get(r.arm_id) || 0) + Number(r.same));
  }

  // the workload's own rate across everything, as the starting point for a strategy with few calls
  const prior = { mean: allN >= 20 ? allS / allN : 0.95, strength: 4 };
  const opts = { halfLifeDays: config.LEARN_HALF_LIFE_DAYS, surrogateWeight: config.LEARN_SURROGATE_WEIGHT, prior };
  const ratioOf = (a) => {
    if (a.key === baseKey) return 1;
    const r = a.offline?.ratio;
    return r === null || r === undefined || !Number.isFinite(Number(r)) ? null : Number(r);
  };
  // the fair record counts only calls that were used: background answers are a stand-in, kept apart
  const fairOpts = { ...opts, surrogateWeight: 0 };
  const record = (a) => ({
    ...a,
    ratio: ratioOf(a),
    post: posterior({ live: live.get(a.id) || [], shadow: shadow.get(a.id) || [] }, opts),
    fair: posterior({ live: fair.get(a.id) || [] }, fairOpts),
    same: same.get(a.id) || 0,
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
      fair: posterior({}, fairOpts), same: 0,
      failed: tally.get('baseline')?.failed ?? 0, known: tally.get('baseline')?.known ?? 0,
    };
  const serving = workload.routed_arm_id ? recById.get(workload.routed_arm_id) || null : null;

  /* A switch made before costs were kept on its strategy learns its cost from the measurement it
     rests on. Without one, nothing is tried on the workload: an experiment could be neither priced
     against what serves nor held to a budget. */
  if (serving && serving.ratio === null) {
    const key = keyOfSpec(serving.spec, workload.reference_model);
    const m = await db.prepare(
      `SELECT r.cost_ratio FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
        WHERE e.workload_id = ? AND r.model_id = ? AND r.cost_ratio IS NOT NULL
        ORDER BY e.created_at DESC LIMIT 1`).get(workload.id, key);
    if (m && Number.isFinite(Number(m.cost_ratio))) {
      serving.ratio = Number(m.cost_ratio);
      await db.prepare('UPDATE arms SET offline_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...(serving.offline || {}), ratio: serving.ratio }), serving.id);
    }
  }

  /* What can be tried at all: strategies whose models are still offered and not switched off in this
     workspace, and the customer's own model only while it can still be reached through us. */
  const enabled = new Set((await db.prepare(
    `SELECT c.model_id FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1`).all(workload.workspace_id)).map((r) => r.model_id));
  const offered = !!await db.prepare('SELECT 1 FROM models_catalog WHERE model_id = ?').get(workload.reference_model);
  for (const a of recs) a.usable = modelsOf(a.spec).every((m) => enabled.has(m) || (m === workload.reference_model && offered));
  baseline.usable = offered;

  /* What today's experiments have added to the bill, today counted in IST: a runner-up cheaper than
     what serves adds nothing, anything dearer adds the difference, a background answer adds all of
     it, and our fee on each. With no known cost for what serves, a call tried elsewhere counts in full. */
  const dayStart = istDayStart(t);
  const explored = await db.prepare(
    `SELECT arm_id, COALESCE(SUM(cost_usd), 0) AS cost FROM calls
      WHERE workload_id = ? AND explored = 1 AND created_at >= ? GROUP BY arm_id`).all(workload.id, dayStart);
  const servingRatio = serving ? serving.ratio : 1;
  let extra = 0;
  for (const e of explored) {
    const r = recById.get(e.arm_id)?.ratio ?? (e.arm_id === baseline.id ? 1 : null);
    extra += r === null || servingRatio === null ? Number(e.cost) : Number(e.cost) * Math.max(0, 1 - servingRatio / r);
  }
  const sh = await db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM shadow_runs WHERE workload_id = ? AND created_at >= ?')
    .get(workload.id, dayStart);
  extra += Number(sh.cost);
  extra *= 1 + config.ROUTING_FEE_PCT / 100;
  return { arms: recs, byId: recById, serving, baseline, prior, extraToday: extra, dayStart, at: t,
    detection, hasEvents, settleMs, perDay };
}

/* The runners-up worth trying: ones the last measurement found inside the bar, still offered, and
   cheaper than what serves now. One that only came close has not earned a customer's live calls, and
   one dearer than what serves has nothing to offer an experiment. */
const cheaperThan = (st, ratio) => (ratio === null || ratio === undefined ? []
  : st.arms.filter((a) => a.status === 'trying' && a.usable !== false && a.ratio !== null && a.ratio < ratio
    && (a.offline?.verdict ?? 'cleared') === 'cleared'));

/**
 * Which strategy answers one call, when the workload experiments: { armId, spec, propensity,
 * explored } or null to leave the serving strategy to answer as it always does.
 */
export async function chooseExplore(workload, servingArm, { rng = Math.random } = {}) {
  const st = peekState(workload);
  const s = exploreOf(workload, { perDay: st?.perDay ?? null });
  if (!s.live || !servingArm || s.share <= 0) return null;
  if (!st || st.extraToday >= s.budgetUsd) return null;
  // until what serves has a known cost, nothing is tried (see readState)
  const serving = st.byId.get(servingArm.id);
  if (!serving || serving.ratio === null) return null;
  const candidates = cheaperThan(st, serving.ratio);
  const plan = explorePlan({ share: s.share, serving, candidates, baseline: st.baseline.usable ? st.baseline : null });
  if (plan.length === 1) return null;
  const pick = pickFrom(plan, rng());
  // what serves falls back to the customer's own model when it fails, as it does outside experiments
  const own = serving.spec?.kind === 'model' && serving.spec.model === workload.reference_model && !serving.spec.recipe;
  const toOwn = own ? null : { armId: null, spec: referenceSpec(workload), propensity: 1, explored: false, shadow: null, isFallback: true };
  if (pick.arm.id === serving.id) {
    return { armId: serving.id, spec: serving.spec, propensity: pick.p, explored: false, shadow: null, fallback: toOwn };
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
  return {
    armId: arm.id, spec: arm.spec, propensity: pick.p, explored: true, shadow: null, why: pick.why,
    // an experiment is never worth a failed call: if it cannot be answered, the call is served as usual
    fallback: { armId: serving.id, spec: serving.spec, propensity: null, explored: false, shadow: null, fallback: toOwn },
  };
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
    // a judge that could not judge says nothing about whether the answers matched
    if (j.transient || !j.judgedBy) return { agreement: null, cost: j.cost || 0, judgedBy: 'not judged' };
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
  // an answer that cannot be read has nothing to be compared with, so nothing is spent on it
  if (!extract(response, workload.shape_kind).ok) return null;
  const st = await stateOf(workload);
  if (st.extraToday >= s.budgetUsd) return null;
  // what answered the call: the serving strategy, or the customer's own model when nothing is switched
  const candidates = cheaperThan(st, st.serving ? st.serving.ratio : 1);
  if (!candidates.length) return null;
  // paid for like a measurement, so only while the balance can pay for it
  const acct = await account(workload.workspace_id);
  if (!(Number(acct?.balance_usd) > 0.05)) return null;
  const shares = thompsonShares(candidates.map((c) => ({ id: c.id, a: c.post.a, b: c.post.b })));
  const arm = pickFrom(candidates.map((c) => ({ arm: c, p: shares.get(c.id) })), rng()).arm;
  const started = Date.now();
  let out = null;
  let status = 200;
  let reading = { agreement: null, cost: 0 };
  try {
    out = await serve(arm.spec, body, { shape: workload.shape_kind, scope: workload.workspace_id });
  } catch (err) {
    status = Number(err?.status) || 0;
    // our own account is nobody's answer; a provider that failed is a runner-up that did not answer
    reading = { agreement: err?.status && status !== 401 && status !== 402 ? 0 : null, cost: 0, judgedBy: 'failed' };
    if (err?.spent) out = { cost: err.spent };
  }
  if (out?.json) {
    try {
      reading = await agreementOf(body, response, out.json, workload.shape_kind, workload.workspace_id);
    } catch {
      // a reading that went wrong on our side says nothing about the runner-up
      reading = { agreement: null, cost: 0, judgedBy: 'not read' };
    }
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
  if (m) m.state.extraToday += cost * (1 + config.ROUTING_FEE_PCT / 100);
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
  const servingRatio = st.serving ? st.serving.ratio : 1;
  const extra = r === null || servingRatio === null ? costUsd : costUsd * Math.max(0, 1 - servingRatio / r);
  st.extraToday += extra * (1 + config.ROUTING_FEE_PCT / 100);
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
    // background answers: how many there were, how many were the same answer, and how close they were on average
    shadow: { calls: p.nShadow, same: a.same ?? 0, rate: p.shadowRate },
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
  const st = await stateOf(workload, { fresh: true });
  const s = exploreOf(workload, { perDay: st.perDay });
  for (const a of st.arms) {
    const prev = a.stats || {};
    await db.prepare('UPDATE arms SET stats_json = ? WHERE id = ?').run(JSON.stringify({ ...prev, ...readingOf(a) }), a.id);
  }
  const decisions = [];
  const min = config.LEARN_MIN_CALLS;
  const ref = workload.reference_model;
  const serving = st.serving;
  const base = st.baseline;
  const said = (x) => `${pctOf(x.fair.liveRate)} of ${x.fair.nLive} calls`;

  /* Every decision is made by one pure rule (src/learn/decide.js) on the fair record: calls since
     learning began, served by chance in matched hours, with time for their outcomes to arrive. The
     rule's false-switch rates are measured by the harness (scripts/harness.mjs). */
  if (serving && serving.ratio !== null) {
    const runners = cheaperThan(st, serving.ratio).map((a) => ({ id: a.id, fair: a.fair, ratio: a.ratio, verdict: a.offline?.verdict ?? 'cleared' }));
    const ruling = decide({ serving: { id: serving.id, fair: serving.fair }, base: { id: base.id, fair: base.fair }, runners,
      detection: st.detection, hasEvents: st.hasEvents },
    { minCalls: config.LEARN_MIN_CALLS, tolerance: config.LEARN_TOLERANCE, minDetection: config.LEARN_MIN_DETECTION });
    for (const d of ruling) {
      if (d.kind === 'revert') {
        const reason = `Live results: since the switch, calls on ${serving.label} worked ${said(serving)}, `
          + `against ${said(base)} on ${short(ref)} answering beside it. Switched back to ${ref}.`;
        const r = await revertFn(workload, { auto: true, soft: true, reason });
        if (r?.ok) {
          forgetState(workload.id);
          decisions.push({ kind: 'revert', armId: serving.id, loss: d.loss });
          return decisions;
        }
        continue;
      }
      const a = st.byId.get(d.armId);
      if (!a) continue;
      if (d.kind === 'rest') {
        await setStatus(a.id, 'resting');
        await addActivity(workload.workspace_id, {
          kind: 'floor',
          title: `Stopped trying ${a.label} on ${workload.slug}`,
          detail: `Its calls worked ${said(a)}, against ${said(serving)} on ${serving.label}.`,
          workloadId: workload.id,
        });
        decisions.push({ kind: 'rest', armId: a.id, loss: d.loss });
        continue;
      }
      // promote: shown as good as what serves and as the customer's own model, on enough calls each
      const cheaper = Math.round((1 - a.ratio / (serving.ratio || 1)) * 100);
      if (workload.optimize_mode !== 'auto') {
        if (a.stats?.suggestedAt) continue;
        await addActivity(workload.workspace_id, {
          kind: 'ok',
          title: `${a.label} is ready to approve on ${workload.slug}`,
          detail: `Its calls worked ${said(a)}, against ${said(serving)} on ${serving.label} and ${said(base)} on ${short(ref)}, `
            + `and it costs ${cheaper}% less. Nothing was switched: approve it on the workload's page.`,
          workloadId: workload.id,
        });
        await db.prepare('UPDATE arms SET stats_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...(a.stats || {}), ...readingOf(a), suggestedAt: now() }), a.id);
        decisions.push({ kind: 'suggest', armId: a.id });
        continue;
      }
      const reason = `live results: ${a.fair.nLive} calls worked ${pctOf(a.fair.liveRate)} of the time, `
        + `against ${pctOf(serving.fair.liveRate)} on ${serving.label} and ${pctOf(base.fair.liveRate)} on ${short(ref)}`;
      const detail = `Switched on its own by live results: its calls worked ${said(a)}, against ${said(serving)} on `
        + `${serving.label} and ${said(base)} on ${short(ref)}, and it costs ${cheaper}% less.`;
      const r = await promoteFn(workload, keyOfSpec(a.spec, ref), { auto: true, reason, spec: a.spec, runId: a.origin_run_id ?? null, detail });
      if (r?.ok && !r.already) {
        forgetState(workload.id);
        decisions.push({ kind: 'promote', armId: a.id, loss: d.loss });
        return decisions;
      }
    }
  }
  // for approval: background answers that were the same as the live ones, inside the workload's bar
  if (s.mode === 'shadow') {
    const floor = Number(workload.floor_pct) || config.EVAL_FLOOR_MIN_PCT;
    for (const a of cheaperThan(st, serving ? serving.ratio : 1).filter((x) => x.post.nShadow >= min && !x.stats?.suggestedAt)) {
      const sameShare = a.same / a.post.nShadow;
      if ((1 - sameShare) * 100 > floor) continue;
      await addActivity(workload.workspace_id, {
        kind: 'ok',
        title: `${a.label} matched your live answers on ${workload.slug}`,
        detail: `In the background it answered ${a.post.nShadow} of your live calls and gave the same answer on ${a.same} of them, `
          + `inside your ${floor.toFixed(1)}% bar. Nothing was changed: approve it on the workload's page to switch.`,
        workloadId: workload.id,
      });
      await db.prepare('UPDATE arms SET stats_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...(a.stats || {}), ...readingOf(a), suggestedAt: now() }), a.id);
      decisions.push({ kind: 'suggest', armId: a.id });
    }
  }
  if (decisions.length) forgetState(workload.id);
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
    // only what cleared the bar is tried on live calls; one that came close has not earned them
    if (r.verdict === 'reference' || r.stopped || r.verdict !== 'cleared') continue;
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
  const st = await stateOf(workload, { fresh: true });
  const s = exploreOf(workload, { perDay: st.perDay });
  const ref = workload.reference_model;
  /* The last seven days, or the days since the switch when it is more recent: the customer's own
     model answering before the switch is not an experiment, and counted in with them it read as a
     yardstick taking an eighth of the traffic. */
  const weekSince = Math.max(now() - 7 * DAY, Number(workload.promoted_at) || 0);
  const share = await db.prepare(
    `SELECT COALESCE(arm_id, '') AS arm, served_model, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN explored = 1 THEN 1 ELSE 0 END), 0) AS explored,
            COALESCE(SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END), 0) AS escalated,
            COALESCE(SUM(cost_usd), 0) AS cost
       FROM calls WHERE workload_id = ? AND source = 'routed' AND created_at >= ? AND ${COUNTED}
      GROUP BY 1, 2`).all(workload.id, weekSince);
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
  // what can be tried against what answers now: the serving strategy, or the customer's own model
  const tryableIds = new Set(cheaperThan(st, st.serving ? st.serving.ratio : 1).map((a) => a.id));
  const shape = (a, role) => ({
    id: a.virtual ? null : a.id, key: a.spec ? keyOfSpec(a.spec, ref) : null, tryable: tryableIds.has(a.id),
    role, label: a.label || labelOf(a.spec, ref), kind: a.kind || a.spec?.kind, status: a.status,
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
    explore: {
      ...s, spentToday: st.extraToday, reason: whyNot(workload, s, st),
      // the shares each setting means, from the settings themselves, so the page never says a number the server does not use
      shares: { careful: config.EXPLORE_SHARE_CAREFUL, normal: config.EXPLORE_SHARE_NORMAL, shadow: config.SHADOW_SHARE },
      servingCostKnown: !st.serving || st.serving.ratio !== null,
      // what "worked" can mean here, and how long evidence takes at this volume and share
      detection: st.detection, hasEvents: st.hasEvents, settleMinutes: Math.round(st.settleMs / 60000), perDay: Math.round(st.perDay),
      daysToEvidence: st.perDay > 0 && s.share > 0 ? Math.ceil(config.LEARN_MIN_CALLS / Math.max(0.01, (st.perDay * s.share) / 2)) : null,
    },
    tolerance: config.LEARN_TOLERANCE, confidence: config.LEARN_CONFIDENCE, minCalls: config.LEARN_MIN_CALLS,
    halfLifeDays: config.LEARN_HALF_LIFE_DAYS, weekCalls, weekSince, weekFromSwitch: weekSince > now() - 7 * DAY + 60000,
    serving, baseline, others,
    shadow: { recent: shadows.map((r) => ({ ...r, agreement: r.agreement === null ? null : Number(r.agreement) })), spentUsd: Number(spent.c) },
  };
}

/* Why a workload is not experimenting right now, in words for its page, or null when it is. */
function whyNot(workload, s, st) {
  if (s.mode === 'off') return 'Experiments are off for this workload.';
  if (st.extraToday >= s.budgetUsd) return `Today's experiments have used the $${s.budgetUsd.toFixed(2)} budget, so they pause until midnight IST.`;
  if (s.live && !workload.routed_model) return 'Live experiments start once this workload is switched to something cheaper.';
  if (st.serving && st.serving.ratio === null) {
    return 'Nothing is tried until the next measurement prices what serves now against your own model: without that, an experiment could not be held to a budget.';
  }
  if (s.mode === 'shadow' && !cheaperThan(st, st.serving ? st.serving.ratio : 1).length) {
    return 'Background answers start once a measurement finds a runner-up that is cheaper than what answers now.';
  }
  return null;
}
