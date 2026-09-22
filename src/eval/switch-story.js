import { db, now, round8 } from '../db/index.js';
import config from '../config.js';
import { perCall, withFeeOn, callsPerMonth, projectSavings, cheaperPct } from './savings.js';
import { OUTCOME_OF } from './outcome.js';

/* Everything the switched card says about a workload we moved to a cheaper model, worked out
 * from the record rather than from whichever measurement happens to be newest.
 *
 * The newest measurement is often not the one the switch was made on, and it may not have
 * tried the model now serving at all: one that could not set a bar tried nothing. Reading the
 * card's numbers from it is how the card came to show 100% accuracy against a bar of 100% for
 * a model it knew nothing about. So each part is read from where it is actually true:
 *   why it switched      the measurement it was switched on
 *   whether it still is  the newest finished measurement since the switch
 *   what a call costs    today's list prices, and this workload's own call sizes
 *   what it has saved    the calls it has actually served since the switch
 * and anything the record cannot answer comes back as null, for the card to say so. */

const DAY = 86400000;
// the customer's own traffic: never a replay we made to measure, nor a test call, nor a refusal
const TRAFFIC = `source IN ('routed', 'trace') AND (status_code IS NULL OR status_code < 400)`;

async function priceOf(modelId) {
  return (await db.prepare('SELECT price_in, price_out FROM models_catalog WHERE model_id = ?').get(modelId)) ?? null;
}

/* How long a model's answers to this workload run, in tokens. Its own calls for the customer
   come first; failing that, what it answered when we measured it on these same calls; failing
   that, whatever this workload's answers usually run to. Two models asked the same thing can
   answer at very different lengths, and pricing the new one at the old one's length would get
   the saving wrong in whichever direction it happened to go. */
async function answerLength(workloadId, modelId, since) {
  const own = await db.prepare(
    `SELECT AVG(completion_tokens) AS n, COUNT(*) AS c FROM calls
      WHERE workload_id = ? AND served_model = ? AND ${TRAFFIC} AND created_at >= ?`).get(workloadId, modelId, since);
  if (own.c > 0) return Number(own.n);
  const measured = await db.prepare(
    `SELECT AVG(completion_tokens) AS n, COUNT(*) AS c FROM calls
      WHERE workload_id = ? AND served_model = ? AND source = 'replay' AND status_code = 200`).get(workloadId, modelId);
  if (measured.c > 0) return Number(measured.n);
  const any = await db.prepare(
    `SELECT AVG(completion_tokens) AS n FROM calls WHERE workload_id = ? AND ${TRAFFIC}`).get(workloadId);
  return Number(any?.n ?? 0);
}

export async function switchStory(w) {
  if (!w?.routed_model) return null;
  const from = w.reference_model;
  const to = w.routed_model;
  const at = w.promoted_at;
  const fee = config.ROUTING_FEE_PCT;
  const t = now();

  const promo = await db.prepare(
    `SELECT actor_user_id, run_id FROM promotions WHERE workload_id = ? AND action = 'promote' AND to_model = ?
      ORDER BY created_at DESC LIMIT 1`).get(w.id, to);

  /* The measurement it was switched on. The switch records its run, but a manual approval can
     record a newer run that never tried this model, so the run is only trusted if it has a
     result for the model; otherwise the newest earlier run that does. */
  const resultIn = (runId) => db.prepare(
    `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, r.sample_size, r.floor_pct, e.gap_pct, e.verdict,
            e.cost_ratio
       FROM eval_runs r JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
      WHERE r.id = ?`).get(to, runId);
  let evidence = w.promoted_run_id ? await resultIn(w.promoted_run_id) : null;
  if (!evidence) {
    evidence = await db.prepare(
      `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, r.sample_size, r.floor_pct, e.gap_pct, e.verdict,
              e.cost_ratio
         FROM eval_runs r JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
        WHERE r.workload_id = ? AND r.created_at <= ? ORDER BY r.created_at DESC LIMIT 1`).get(to, w.id, at);
  }

  /* The newest finished measurement since the switch, and what it found about this model, if
     it tried it at all. */
  const latest = await db.prepare(
    `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, ${OUTCOME_OF('r.')} AS outcome,
            r.noise_pct, r.floor_pct, r.sample_size, e.gap_pct, e.verdict
       FROM eval_runs r LEFT JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
      WHERE r.workload_id = ? AND r.status = 'done' AND r.created_at > ?
        AND ${OUTCOME_OF('r.')} IN ('compared', 'unmeasurable', 'refused')
      ORDER BY r.created_at DESC LIMIT 1`).get(to, w.id, at);

  const ws = await db.prepare('SELECT measure_every_days FROM workspaces WHERE id = ?').get(w.workspace_id);
  const cadenceDays = ws?.measure_every_days ?? config.MEASURE_EVERY_DAYS;
  const lastRun = (await db.prepare(
    'SELECT MAX(created_at) AS at FROM eval_runs WHERE workload_id = ?').get(w.id))?.at ?? at;
  const nextCheckAt = cadenceDays > 0 ? lastRun + cadenceDays * DAY : null;

  // what one call costs on each, at today's list prices and this workload's own call sizes
  const window = t - 30 * DAY;
  const prompt = await db.prepare(
    `SELECT AVG(prompt_tokens) AS n, COUNT(*) AS c, MIN(created_at) AS first FROM calls
      WHERE workload_id = ? AND ${TRAFFIC} AND created_at >= ?`).get(w.id, window);
  const promptAll = prompt.c > 0 ? Number(prompt.n)
    : Number((await db.prepare(`SELECT AVG(prompt_tokens) AS n FROM calls WHERE workload_id = ? AND ${TRAFFIC}`)
      .get(w.id))?.n ?? 0);
  const [fromPrice, toPrice] = [await priceOf(from), await priceOf(to)];
  const fromOut = await answerLength(w.id, from, window);
  const toOut = await answerLength(w.id, to, window);
  /* A call of no known size cannot be priced. Copies sent without their token counts read as
     calls of nothing, and pricing those printed "$0.00 a call" and "0% less" as though they
     were findings. */
  const sized = promptAll > 0 || fromOut > 0 || toOut > 0;
  const fromPerCall = sized ? perCall(fromPrice, { prompt: promptAll, completion: fromOut }) : null;
  /* When the switch rests on a measurement, the new model is priced the way the measurement
     priced it: what it actually cost on the sampled calls against the original model on the same
     calls. That carries what a list price misses, and keeps this card and the measurement's own
     table saying the same thing. Without one, today's list price and its own answer length. */
  const measuredRatio = evidence?.cost_ratio != null && Number(evidence.cost_ratio) > 0 ? Number(evidence.cost_ratio) : null;
  const toPerCall = !sized ? null
    : measuredRatio !== null && fromPerCall !== null ? withFeeOn(fromPerCall * measuredRatio, fee)
      : withFeeOn(perCall(toPrice, { prompt: promptAll, completion: toOut }), fee);

  // how much traffic that is, from the customer's own calls over the last thirty days
  const days = prompt.c > 0 ? Math.max(1, Math.min(30, (t - prompt.first) / DAY)) : 30;
  const monthly = callsPerMonth(prompt.c, days);
  /* and how it reaches us. Only a routed call can be served by the new model; a copy has
     already run on the original at the customer's own provider by the time we see it. So the
     saving projected is the one on the calls that come through us, at the pace they have come
     since they began. Projected from every call, 900 copies and 100 routed calls read as ten
     times the saving that was happening. A workload that sends only copies has none yet, and its
     figures are what routing all of it would save, said as that. */
  const routed = await db.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM calls
      WHERE workload_id = ? AND source = 'routed' AND ${TRAFFIC} AND created_at >= ?`).get(w.id, window);
  const routedDays = routed.n > 0 ? Math.max(1, Math.min(30, (t - routed.first) / DAY)) : days;
  const monthlyRouted = callsPerMonth(routed.n, routedDays);
  const basis = routed.n > 0 ? 'routed' : 'all';
  const projection = projectSavings({ fromPerCall, toPerCall, monthly: basis === 'routed' ? monthlyRouted : monthly });
  // with some calls still arriving as copies, what routing all of them would save in a month
  const allMonth = basis === 'routed' && routed.n < prompt.c
    ? projectSavings({ fromPerCall, toPerCall, monthly, months: [1] })[0] ?? null
    : null;

  /* What it has actually saved: every call it has served for the customer since the switch.
     Paid is what they were charged, fee included. What those calls would have cost on the
     original model is their real prompts at its prices, and its usual answer length, because
     how long its answers would have been cannot be read off a call it never answered. */
  const served = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(charged_usd), 0) AS paid, COALESCE(SUM(prompt_tokens), 0) AS pin
       FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ? AND status_code = 200
        AND created_at >= ?`).get(w.id, to, at);
  const copies = (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'trace' AND created_at >= ?`)
    .get(w.id, at)).n;
  const wouldHave = fromPrice
    ? fromPrice.price_in * served.pin + fromPrice.price_out * fromOut * served.n
    : null;

  const spent = (await db.prepare(
    'SELECT COALESCE(SUM(spend_usd), 0) AS s FROM eval_runs WHERE workload_id = ?').get(w.id)).s;

  return {
    from, to, at,
    how: promo?.actor_user_id ? 'you' : 'automatic',
    evidence: evidence ? {
      runId: evidence.id, at: evidence.at, sample: evidence.sample_size, floor: evidence.floor_pct,
      gap: evidence.gap_pct, verdict: evidence.verdict,
    } : null,
    latest: latest ? {
      runId: latest.id, at: latest.at, outcome: latest.outcome, noise: latest.noise_pct,
      floor: latest.floor_pct, sample: latest.sample_size, gap: latest.gap_pct, verdict: latest.verdict,
    } : null,
    cadenceDays, nextCheckAt,
    prices: {
      feePct: fee,
      fromPerCall: fromPerCall == null ? null : round8(fromPerCall),
      toPerCall: toPerCall == null ? null : round8(toPerCall),
      cheaperPct: cheaperPct(fromPerCall, toPerCall),
      // why a price may be missing: not in the price list, or no call of a known size to price
      fromListed: !!fromPrice, toListed: !!toPrice, sized,
    },
    volume: {
      calls: prompt.c, routed: routed.n, copies: prompt.c - routed.n,
      days, monthly: round8(monthly),
      routedDays, monthlyRouted: round8(monthlyRouted),
      // what the projection is built on: the routed calls, or every call if none are routed yet
      basis,
      allMonthSaved: allMonth ? allMonth.saved : null,
    },
    soFar: {
      calls: served.n, copies,
      paid: round8(served.paid),
      wouldHave: wouldHave == null ? null : round8(wouldHave),
      saved: wouldHave == null ? null : round8(wouldHave - served.paid),
    },
    measuring: { spent: round8(withFeeOn(spent, fee)) },
    projection,
  };
}
