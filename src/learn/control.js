import config from '../config.js';
import { db, id, now } from '../db/index.js';
import { chargeEval, account, optimizeLeft } from '../billing.js';
import { extract, disagreement, structuredCompare, proseText } from '../eval/compare.js';
import { judgeCandidate, judgeBarPair } from '../eval/judge.js';
import { askOf } from '../eval/ask.js';
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
 * scored against it exactly as a measurement scores a candidate: the same fields, the same judge, and Jev
 * reading a written difference three ways. Nobody ever sees the background answer. Once there are
 * CONTROL_MIN_CHECKS of them since the switch, the hourly review switches back a setup whose rate of
 * worse or different answers is clearly past the workload's pass mark: the lower edge of a range that
 * holds at every hourly look (a confidence sequence, as in decide.js), so it never happens by chance.
 * Paid for as optimizing, within the workspace's optimization budget. */

const DAY = 86400000;
const IST = 5.5 * 3600000;
// the start of today, as the day is counted in India, where this product's days are told
const istDayStart = (t) => Math.floor((t + IST) / DAY) * DAY - IST;
const short = (m) => String(m || '').split('/').pop();

/**
 * How an answer that was served compares with the customer's model's answer to the same call, scored as a
 * measurement scores a candidate: { score (0 as good, 1 worse or different), better, judgedBy, cost }, or
 * null when nothing can be said (the customer's model gave nothing to compare with, or no judge answered).
 */
export async function scoreServed(body, served, ref, shape, { scope = null } = {}) {
  const a = extract(served, shape);
  const b = extract(ref, shape);
  if (!b.ok) return null;
  if (!a.ok) return { score: 1, better: 0, judgedBy: 'no answer', cost: 0, kind: a.reason || 'no answer' };
  if (shape === 'free_text') {
    const j = await judgeCandidate(askOf(body), a.value, b.value, null, { scope });
    if (j.transient || j.score === null || j.score === undefined) return null;
    return { score: j.score, better: Number(j.detail?.better) > 0 ? 1 : 0, judgedBy: j.judgedBy, cost: j.cost || 0,
      kind: j.score > 0 ? j.detail?.kind ?? null : null };
  }
  const d = disagreement(a, b, shape);
  if (d !== null) return { score: d, better: 0, judgedBy: 'fields', cost: 0, kind: d > 0 ? 'decision' : null };
  const c = structuredCompare(a.value, b.value, shape);
  const j = await judgeBarPair(askOf(body), proseText(c.prose, 'a'), proseText(c.prose, 'b'), { scope, subject: 'a' });
  if (j.transient || !j.judgedBy) return null;
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

/**
 * After a call a switch answered: now and then, the customer's own model answers a copy of it in the
 * background, and how the served answer compares with it is kept. Never for a call the customer's own
 * model answered anyway (an experiment's yardstick, or a cascade or router that sent it on).
 */
export async function maybeControl(info, { rng = Math.random, serve = serveWith } = {}) {
  if (!config.CONTROL_ENABLED) return null;
  const { workload, body, response, callId = null, decision } = info || {};
  if (!workload?.routed_arm_id || !response || !decision || !body) return null;
  if (decision.armId !== workload.routed_arm_id || decision.explored || decision.escalated) return null;
  const perDay = await perDayOf(workload.id);
  if (rng() >= Math.min(1, config.CONTROL_PER_DAY / Math.max(1, perDay))) return null;
  const today = await db.prepare('SELECT COUNT(*) AS n FROM control_checks WHERE workload_id = ? AND created_at >= ?')
    .get(workload.id, istDayStart(now()));
  if (Number(today?.n) >= config.CONTROL_MAX_PER_DAY) return null;
  const left = await optimizeLeft(workload.workspace_id);
  if (left !== null && left !== undefined && left <= 0) return null;
  // paid for like a measurement, so only while the balance can pay for it
  const acct = await account(workload.workspace_id);
  if (!(Number(acct?.balance_usd) > 0.05)) return null;

  const row = {
    id: id('ctl'), workspace_id: workload.workspace_id, workload_id: workload.id, arm_id: workload.routed_arm_id,
    call_id: callId, score: null, better: 0, judged_by: null, detail_json: null, cost_usd: 0, latency_ms: null,
    ref_latency_ms: null, status: 200, created_at: now(),
  };
  // an answer that cannot even be read is a worse answer, whatever the customer's model would have said
  if (!extract(response, workload.shape_kind).ok) {
    row.score = 1;
    row.judged_by = 'no answer';
    row.detail_json = JSON.stringify({ kind: extract(response, workload.shape_kind).reason || 'no answer' });
  } else {
    let own = null;
    try {
      own = await serve(referenceSpec(workload), body, { shape: workload.shape_kind, scope: workload.workspace_id });
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
        s = await scoreServed(body, response, own.json, workload.shape_kind, { scope: workload.workspace_id });
      } catch {
        s = null;
      }
      if (s) {
        row.score = s.score;
        row.better = s.better ? 1 : 0;
        row.judged_by = s.judgedBy;
        row.cost_usd += Number(s.cost) || 0;
        row.detail_json = JSON.stringify({ kind: s.kind ?? null });
      }
    }
  }
  await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, call_id, score, better, judged_by, detail_json,
      cost_usd, latency_ms, ref_latency_ms, status, created_at) VALUES (@id, @workspace_id, @workload_id, @arm_id, @call_id, @score,
      @better, @judged_by, @detail_json, @cost_usd, @latency_ms, @ref_latency_ms, @status, @created_at)`).run(row);
  if (row.cost_usd > 0) {
    await chargeEval(workload.workspace_id, row.cost_usd, `Checking ${workload.slug} against ${short(workload.reference_model)} in the background`);
  }
  return row;
}

/**
 * What the control group has found about what serves a workload now, since it was switched to (and over
 * the last CONTROL_WINDOW_DAYS at most): how many answers were checked, how many were worse or different,
 * how many better, and the range for its true rate that holds at every hourly look.
 */
export async function controlRecord(workload) {
  if (!workload?.routed_arm_id) return null;
  const from = Math.max(Number(workload.promoted_at) || 0, now() - config.CONTROL_WINDOW_DAYS * DAY);
  const r = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(score), 0) AS worse, COALESCE(SUM(better), 0) AS better,
            COALESCE(SUM(cost_usd), 0) AS cost, MAX(created_at) AS last
       FROM control_checks WHERE workload_id = ? AND arm_id = ? AND created_at >= ? AND score IS NOT NULL`)
    .get(workload.id, workload.routed_arm_id, from);
  const n = Number(r?.n) || 0;
  const worse = Number(r?.worse) || 0;
  const rate = n ? worse / n : 0;
  // a record with nothing worse yet is read as having half of one, so it is still uncertain rather than exact
  const q = n ? Math.max(worse, 0.5) / n : 0.5;
  const half = n ? Math.sqrt((q * (1 - q)) / n) * zSeq(n, { alpha: config.LEARN_ALPHA / 2 }) : 1;
  const floorPct = Number(workload.floor_pct) > 0 ? Number(workload.floor_pct) : config.EVAL_FLOOR_MIN_PCT;
  return {
    n, worse: Math.round(worse * 100) / 100, better: Number(r?.better) || 0, rate,
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
