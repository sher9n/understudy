import config from '../config.js';
import { db, id, now } from '../db/index.js';
import { chargeEval, account, backgroundLeft } from '../billing.js';
import { extract, disagreement, structuredCompare, proseText, heldFieldChanged } from '../eval/compare.js';
import { judgeCandidate, judgeBarPair, judgeQuality, numbersDiffer, numbersOf } from '../eval/judge.js';
import { askOf } from '../eval/ask.js';
import { keptChecklist } from '../eval/checklist.js';
import { OUTCOME_OF } from '../eval/outcome.js';
import { zdrFor } from '../workspace.js';
import { serveWith } from './serve.js';
import { referenceSpec } from './arms.js';
import { zSeq } from './decide.js';

/* The control group: after a switch, is what serves still as good as the customer's own model?
 *
 * A measurement is a sample, taken now and then. The live watch sees calls that fail outright and
 * answers that slow down. Live experiments compare how often calls work, but only where a workload lets
 * them change answers (one that asks first before switching never does), and "worked" is only what the
 * traffic happens to show. None of that asks, every day, the plain question: would the customer's own
 * model have answered this call as well?
 *
 * So about CONTROL_PER_DAY of a switched workload's answers a day (never more than CONTROL_MAX_PER_DAY)
 * are asked of the customer's own model too, in the background, and the answer that was served is
 * scored against it exactly as the measurement that made the switch scored it: the same fields, the same
 * judge, the same yardstick (the same answer, or for written work with no one right answer, one at least
 * as good), and Jev reading a written difference three ways. Every served answer is a candidate, the ones
 * a cascade or router sent on to the customer's own model too: those are scored against a second answer
 * of the customer's model, as the measurement scores them, so the rate is the whole workload's, the one
 * the pass mark is for. Nobody ever sees the background answer. Once there are CONTROL_MIN_CHECKS of them
 * since the switch, the hourly review switches back a setup whose rate of worse or different answers is
 * clearly past the workload's pass mark: the lower edge of a range that holds at every hourly look (a
 * confidence sequence, as in decide.js), so it never happens by chance. Paid for as optimizing, within
 * the workspace's optimization budget, and counted there (optimizeSpent); never out of its last
 * OPTIMIZE_RESERVE_SHARE, which is kept for the measurements that decide what serves. */

const DAY = 86400000;
const IST = 5.5 * 3600000;
// the start of today, as the day is counted in India, where this product's days are told
const istDayStart = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const short = (m) => String(m || '').split('/').pop();

/**
 * How an answer that was served compares with the customer's model's answer to the same call, scored as
 * the measurement that made the switch scores a candidate: { score (0 as good, 1 worse or different, null
 * when nothing can be said), better, judgedBy, cost, kind }. Nothing can be said when the customer's model
 * gave nothing to compare with (cut short, refused, not the shape the call asks for: the measurement leaves
 * such calls out too), or when no judge answered; what was spent finding that out is still in `cost`. Nor
 * when a difference stands only because Jev's reading of which answer serves better did not come back
 * (unsettled): that counts against a setup being switched to, never towards switching back one that serves,
 * which a judge failing the same way on every check would otherwise do on no evidence at all. Held to "at least as
 * good", written or structured, it is read as the measurement read it: by the judge its planted answers chose
 * (`prefer`), held to the workload's own instruction (`checklist`), a structured answer as its JSON. And as the measurement
 * holds a written answer to the figures the customer's model states the same both times (qualityAgainst in
 * src/eval/run.js): where the served answer changes a figure, `again()` asks the customer's model once more, and a figure
 * it states again makes the served answer worse whatever a reading says, since a judge can see that two answers give
 * different figures, not which one is right. `twice` says the customer's model was asked that second time.
 */
export async function scoreServed(body, served, ref, shape, { scope = null, yardstick = 'agreement', prefer = null, checklist = null, again = null, stable = null } = {}) {
  const a = extract(served, shape);
  const b = extract(ref, shape);
  if (!b.ok) return { score: null, better: 0, judgedBy: null, cost: 0, kind: null };
  if (!a.ok) return { score: 1, better: 0, judgedBy: 'no answer', cost: 0, kind: a.reason || 'no answer' };
  if (yardstick === 'quality') {
    let extra = 0;
    let twice = false;
    /* A structured answer is held to the fields the customer's model gives the same way on nearly every call, as the
       measurement read them (`stable`; heldFieldChanged in src/eval/compare.js): where the served answer changes one of
       them from the customer's answer, that model is asked once more, and one it gives the same way again makes the served
       answer worse whatever a reading says. It used to reach the judge as its JSON, a changed total and all. With no such
       fields read (a measurement from before they were), none is held. */
    const only = stable instanceof Set ? stable : null;
    if (again && shape !== 'free_text' && only?.size && heldFieldChanged(a.value, b.value, b.value, shape, { only })) {
      let more = null;
      try { more = await again(); } catch { more = null; }
      twice = true;
      extra += Number(more?.cost) || 0;
      const c = more?.json ? extract(more.json, shape) : null;
      const held = c?.ok ? heldFieldChanged(a.value, b.value, c.value, shape, { only }) : null;
      if (held) return { score: 1, better: 0, judgedBy: 'fields', cost: extra, kind: 'fact', twice, field: held.path };
    }
    if (again && typeof a.value === 'string' && typeof b.value === 'string' && numbersOf(b.value).length > 0 && numbersDiffer(a.value, b.value)) {
      let more = null;
      try { more = await again(); } catch { more = null; }
      twice = true;
      extra += Number(more?.cost) || 0;
      const c = more?.json ? extract(more.json, shape) : null;
      if (c?.ok && typeof c.value === 'string' && !numbersDiffer(b.value, c.value)) {
        return { score: 1, better: 0, judgedBy: 'numbers', cost: extra, kind: 'fact', twice };
      }
    }
    const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    const j = await judgeQuality(askOf(body), text(a.value), text(b.value), { scope, prefer, checklist });
    if (j.transient || j.score === null || j.score === undefined) return { score: null, better: 0, judgedBy: null, cost: (j.cost || 0) + extra, kind: null, twice };
    return { score: j.score, better: j.detail?.candBetter ? 1 : 0, judgedBy: j.judgedBy, cost: (j.cost || 0) + extra,
      kind: j.score > 0 ? (j.detail?.kind || 'worse') : null, twice };
  }
  if (shape === 'free_text') {
    const j = await judgeCandidate(askOf(body), a.value, b.value, null, { scope });
    // what serves is read without differences a reading left unsettled (see judgeCandidate): with one answer to hold it to, none
    const score = j.unsettled ? (j.settled ?? null) : j.score;
    if (j.transient || score === null || score === undefined) return { score: null, better: 0, judgedBy: null, cost: j.cost || 0, kind: null };
    return { score, better: Number(j.detail?.better) > 0 ? 1 : 0, judgedBy: j.judgedBy, cost: j.cost || 0,
      kind: score > 0 ? j.detail?.kind ?? null : null };
  }
  const d = disagreement(a, b, shape);
  if (d !== null) return { score: d, better: 0, judgedBy: 'fields', cost: 0, kind: d > 0 ? 'decision' : null };
  const c = structuredCompare(a.value, b.value, shape);
  const j = await judgeBarPair(askOf(body), proseText(c.prose, 'a'), proseText(c.prose, 'b'), { scope, subject: 'a' });
  if (j.transient || j.unsettled || !j.judgedBy) return { score: null, better: 0, judgedBy: null, cost: j.cost || 0, kind: null };
  return { score: j.score, better: j.detail?.better ? 1 : 0, judgedBy: `fields+${j.judgedBy}`, cost: j.cost || 0,
    kind: j.score > 0 ? j.detail?.kind ?? null : null };
}

/* How many calls a workload answers a day, read at most every ten minutes: the chance a call is checked is
   what spreads about CONTROL_PER_DAY checks over the day. */
const volume = new Map();
async function perDayOf(workloadId) {
  const hit = volume.get(workloadId);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.n;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'routed' AND created_at >= ?`)
    .get(workloadId, now() - DAY);
  const n = Number(r?.n) || 0;
  volume.set(workloadId, { at: Date.now(), n });
  if (volume.size > 5000) volume.clear();
  return n;
}

/* The bar a switch is held to here: the yardstick and the pass mark of one measurement, never one's yardstick
   with another's mark. The newest that set a pass mark, and failing that the one that made the switch; read
   at most every ten minutes. Taken apart, a re-check that moved a written workload from "the same answer" to
   "at least as good" left the checks judging the same answer against the new, tighter mark, and a healthy
   switch went back in a day and a half; and one that could not set a mark at all ("refused") left the mark
   at the 3% floor for a workload whose own was ten. Never one that found the customer's model too unsteady to
   measure: it writes the mark it worked out (half its calls or more, often) before it gives up, and read as
   the bar, that mark let the checks find nothing, however far a setup slipped. Under "at least as good", with the judge
   that measurement's planted answers chose (prefer), so the checks read answers as the measurement did. */
const bars = new Map();
export async function barOf(workload) {
  const hit = bars.get(workload.id);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.bar;
  const row = await db.prepare(`SELECT yardstick, floor_pct, judge_check_json, plan_json FROM eval_runs WHERE workload_id = ? AND status = 'done'
        AND floor_pct IS NOT NULL AND ${OUTCOME_OF()} <> 'unmeasurable' ORDER BY created_at DESC LIMIT 1`).get(workload.id)
    ?? (workload.promoted_run_id ? await db.prepare('SELECT yardstick, floor_pct, judge_check_json, plan_json FROM eval_runs WHERE id = ?')
      .get(workload.promoted_run_id) : null);
  let check = null;
  try { check = row?.judge_check_json ? JSON.parse(row.judge_check_json) : null; } catch { check = null; }
  let plan = null;
  try { plan = row?.plan_json ? JSON.parse(row.plan_json) : null; } catch { plan = null; }
  const stable = plan?.yardstick?.stableFields;
  const bar = {
    yardstick: row?.yardstick === 'quality' ? 'quality' : 'agreement',
    prefer: check?.prefer === 'llm' ? 'llm' : null,
    floorPct: Number(row?.floor_pct) > 0 ? Number(row.floor_pct)
      : Number(workload.floor_pct) > 0 ? Number(workload.floor_pct) : config.EVAL_FLOOR_MIN_PCT,
    /* the fields of a structured answer its customer's model gives the same way on nearly every call, as that measurement
       read them (stablePaths in src/eval/compare.js); null for one measured before they were read, which holds none */
    stable: Array.isArray(stable) ? new Set(stable) : null,
  };
  bars.set(workload.id, { at: Date.now(), bar });
  if (bars.size > 5000) bars.clear();
  return bar;
}
/** Forget what was read about a workload's bar, so a measurement that just finished is read at once. */
export const forgetBar = (workloadId) => { bars.delete(workloadId); };

/* Checks running now. Each workload's place is claimed before anything is awaited, so calls that arrive
   together cannot all pass the day's cap before any of them has written its row; and there is a limit
   across every workload, so a burst of traffic never becomes a burst of background calls. */
const inFlight = new Map();
let running = 0;
const PER_WORKLOAD = 2;
const ACROSS = 24;

/**
 * After a call a switch answered: now and then, the customer's own model answers a copy of it in the
 * background, and how the served answer compares with it is kept. Never for a call an experiment answered
 * another way: that one was not served by the switch.
 */
export async function maybeControl(info, { rng = Math.random, serve = serveWith } = {}) {
  if (!config.CONTROL_ENABLED) return null;
  const { workload, body, response, callId = null, decision } = info || {};
  if (!workload?.routed_arm_id || !response || !decision || !body) return null;
  if (decision.armId !== workload.routed_arm_id || decision.explored) return null;
  /* Drawn before a place is claimed: nearly every call is not one to check, and holding a place while
     finding that out turned away, in a burst, the few calls that were. */
  const perDay = await perDayOf(workload.id);
  if (rng() >= Math.min(1, config.CONTROL_PER_DAY / Math.max(1, perDay))) return null;
  const mine = inFlight.get(workload.id) || 0;
  if (mine >= PER_WORKLOAD || running >= ACROSS) return null;
  inFlight.set(workload.id, mine + 1);
  running += 1;
  try {
    return await control(workload, { body, response, callId, decision }, { serve });
  } finally {
    const left = (inFlight.get(workload.id) || 1) - 1;
    if (left > 0) inFlight.set(workload.id, left); else inFlight.delete(workload.id);
    running -= 1;
  }
}

async function control(workload, { body, response, callId, decision }, { serve }) {
  // today's checks, and the others of this workload still running, which have not written theirs yet
  const today = await db.prepare('SELECT COUNT(*) AS n FROM control_checks WHERE workload_id = ? AND created_at >= ?')
    .get(workload.id, istDayStart(now()));
  if (Number(today?.n) + (inFlight.get(workload.id) || 1) - 1 >= config.CONTROL_MAX_PER_DAY) return null;
  /* Within the workspace's optimization budget, and never out of its last quarter: that is kept for the
     measurements that decide what serves, which a background check must never crowd out (backgroundLeft). */
  const left = await backgroundLeft(workload.workspace_id);
  if (left !== null && left <= 0) return null;
  // paid for like a measurement, so only while the balance can pay for it
  const acct = await account(workload.workspace_id);
  if (!(Number(acct?.balance_usd) > 0.05)) return null;

  // judged by the yardstick of the bar it is held to, and marked with it (see controlRecord)
  const { yardstick, prefer, stable } = await barOf(workload);
  const checklist = yardstick === 'quality' && workload.shape_kind === 'free_text' ? await keptChecklist(workload.id) : null;
  const row = {
    id: id('ctl'), workspace_id: workload.workspace_id, workload_id: workload.id, arm_id: workload.routed_arm_id,
    call_id: callId, score: null, better: 0, judged_by: null, yardstick, detail_json: null, cost_usd: 0, latency_ms: null,
    ref_latency_ms: null, status: 200, created_at: now(),
  };
  /* The customer's own model is asked whatever the served answer was like: an answer cut short counts as
     worse only when the customer's model finishes the same call, the way the measurement leaves out the
     calls the customer's own model could not answer. */
  let own = null;
  const ownAnswer = async () => serve(referenceSpec(workload), body, { shape: workload.shape_kind, scope: workload.workspace_id,
    zdr: await zdrFor(workload.workspace_id) });
  /* asked a second time only to see whether it states a figure, or gives a field of a structured answer, the served answer
     changed the same way again (see scoreServed) */
  const again = yardstick === 'quality'
    ? async () => {
      try {
        const r = await ownAnswer();
        return { json: r?.json ?? null, cost: Number(r?.cost) || 0 };
      } catch (err) {
        return { json: null, cost: Number(err?.spent) || 0 };
      }
    }
    : null;
  try {
    own = await ownAnswer();
  } catch (err) {
    row.status = Number(err?.status) || 0;
    // our own account refusing is nobody's reading; a provider that failed on the customer's model says nothing either
    if (err?.spent) row.cost_usd = Number(err.spent) || 0;
  }
  if (own?.json) {
    row.ref_latency_ms = own.latencyMs ?? null;
    row.cost_usd += Number(own.cost) || 0;
    let s = null;
    try {
      s = await scoreServed(body, response, own.json, workload.shape_kind, { scope: workload.workspace_id, yardstick, prefer, checklist, again, stable });
    } catch {
      s = null;
    }
    if (s) {
      row.cost_usd += Number(s.cost) || 0;
      if (s.score !== null && s.score !== undefined) {
        row.score = s.score;
        row.better = s.better ? 1 : 0;
        row.judged_by = s.judgedBy;
        row.detail_json = JSON.stringify({ kind: s.kind ?? null, escalated: !!decision.escalated, ...(s.twice ? { askedTwice: true } : {}),
          ...(s.field ? { field: s.field } : {}) });
      }
    }
  }
  await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, call_id, score, better, judged_by, yardstick,
      detail_json, cost_usd, latency_ms, ref_latency_ms, status, created_at) VALUES (@id, @workspace_id, @workload_id, @arm_id, @call_id,
      @score, @better, @judged_by, @yardstick, @detail_json, @cost_usd, @latency_ms, @ref_latency_ms, @status, @created_at)`).run(row);
  if (row.cost_usd > 0) {
    await chargeEval(workload.workspace_id, row.cost_usd, `Checking ${workload.slug} against ${short(workload.reference_model)} in the background`);
  }
  return row;
}

/**
 * What the control group has found about what serves a workload now, since it was switched to (and over
 * the last CONTROL_WINDOW_DAYS at most): how many answers were checked, how many were worse or different,
 * how many better, and the range for its true rate that holds at every hourly look. Only the checks judged
 * by the yardstick of the bar they are held to count: a re-check that moves a written workload from "the
 * same answer" to "at least as good" sets a mark for that yardstick, and the checks judged by the other one
 * held against it switched a healthy setup back. What every check cost is counted whatever it was judged by.
 */
export async function controlRecord(workload) {
  if (!workload?.routed_arm_id) return null;
  const from = Math.max(Number(workload.promoted_at) || 0, now() - config.CONTROL_WINDOW_DAYS * DAY);
  // the pass mark and the yardstick of one measurement (barOf)
  const { floorPct, yardstick } = await barOf(workload);
  const r = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE score IS NOT NULL AND yardstick = ?) AS n,
            COUNT(*) FILTER (WHERE score IS NOT NULL) AS judged,
            COALESCE(SUM(score) FILTER (WHERE yardstick = ?), 0) AS worse,
            COALESCE(SUM(better) FILTER (WHERE score IS NOT NULL AND yardstick = ?), 0) AS better,
            COALESCE(SUM(cost_usd), 0) AS cost, MAX(created_at) AS last
       FROM control_checks WHERE workload_id = ? AND arm_id = ? AND created_at >= ?`)
    .get(yardstick, yardstick, yardstick, workload.id, workload.routed_arm_id, from);
  const n = Number(r?.n) || 0;
  // the checks since the switch compared the other way, which the page says rather than hides
  const otherWay = Math.max(0, (Number(r?.judged) || 0) - n);
  const worse = Number(r?.worse) || 0;
  const rate = n ? worse / n : 0;
  // a record with nothing worse yet is read as having half of one, so it is still uncertain rather than exact
  const q = n ? Math.max(worse, 0.5) / n : 0.5;
  const half = n ? Math.sqrt((q * (1 - q)) / n) * zSeq(n, { alpha: config.LEARN_ALPHA / 2 }) : 1;
  return {
    n, otherWay, worse: Math.round(worse * 100) / 100, better: Number(r?.better) || 0, rate,
    lo: Math.max(0, rate - half), hi: Math.min(1, rate + half), floorPct,
    costUsd: Number(r?.cost) || 0, since: from, last: r?.last ? Number(r.last) : null,
    enough: n >= config.CONTROL_MIN_CHECKS,
  };
}

/** Whether the control group says what serves is clearly worse than the pass mark allows, and why, in words. */
export function controlBreach(rec, reference) {
  if (!rec || !rec.enough) return null;
  if (!(rec.lo * 100 > rec.floorPct)) return null;
  const worse = Number.isInteger(rec.worse) ? rec.worse : rec.worse.toFixed(1);
  return `Checked against ${short(reference)} in the background since the switch: of ${rec.n} of its answers, ${worse} were `
    + `worse or different (${(rec.rate * 100).toFixed(1)}%), clearly past your ${rec.floorPct.toFixed(1)}% pass mark.`;
}
