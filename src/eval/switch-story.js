import { db, now, round8 } from '../db/index.js';
import config from '../config.js';
import { perCall, withFeeOn, callsPerMonth, projectSavings, cheaperPct } from './savings.js';
import { OUTCOME_OF } from './outcome.js';
import { servingKey } from './promote.js';
import { armById } from '../learn/arms.js';

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
  return (await db.prepare('SELECT price_in, price_out, price_cache_read FROM models_catalog WHERE model_id = ?').get(modelId)) ?? null;
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
  // the model that answers most of its calls, and the strategy it belongs to
  const to = w.routed_model;
  const arm = w.routed_arm_id ? await armById(w.routed_arm_id) : null;
  /* The name the switch and its measurement know it by: the model, or for a strategy its own name,
     "cascade:<model>" and the like. Looked up by the model alone, a cascade found no measurement at
     all and its card said it had been switched for no reason. */
  const key = await servingKey(w);
  const kind = arm?.spec?.kind ?? 'model';
  const at = w.promoted_at;
  const fee = config.ROUTING_FEE_PCT;
  const t = now();

  const promo = await db.prepare(
    `SELECT actor_user_id, run_id FROM promotions WHERE workload_id = ? AND action = 'promote' AND to_model = ?
      ORDER BY created_at DESC LIMIT 1`).get(w.id, key);

  /* The measurement it was switched on. The switch records its run, but a manual approval can
     record a newer run that never tried this model, so the run is only trusted if it has a
     result for the model; otherwise the newest earlier run that does. */
  const resultIn = (runId) => db.prepare(
    `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, r.sample_size, r.floor_pct, e.gap_pct, e.verdict,
            e.cost_ratio, e.escalated_pct
       FROM eval_runs r JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
      WHERE r.id = ?`).get(key, runId);
  let evidence = w.promoted_run_id ? await resultIn(w.promoted_run_id) : null;
  if (!evidence) {
    evidence = await db.prepare(
      `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, r.sample_size, r.floor_pct, e.gap_pct, e.verdict,
              e.cost_ratio, e.escalated_pct
         FROM eval_runs r JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
        WHERE r.workload_id = ? AND r.created_at <= ? ORDER BY r.created_at DESC LIMIT 1`).get(key, w.id, at);
  }

  /* The newest finished measurement since the switch, and what it found about this model, if
     it tried it at all. */
  const latest = await db.prepare(
    `SELECT r.id, COALESCE(r.finished_at, r.created_at) AS at, ${OUTCOME_OF('r.')} AS outcome,
            r.noise_pct, r.floor_pct, r.sample_size, e.gap_pct, e.verdict
       FROM eval_runs r LEFT JOIN eval_results e ON e.run_id = r.id AND e.model_id = ?
      WHERE r.workload_id = ? AND r.status = 'done' AND r.created_at > ?
        AND ${OUTCOME_OF('r.')} IN ('compared', 'unmeasurable', 'refused')
      ORDER BY r.created_at DESC LIMIT 1`).get(key, w.id, at);

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
     Paid is what they were charged, fee included. What those calls would have cost on the original
     model is what they cost, divided by what the measurement found the new one costs against it on
     the same calls, because that carries every difference a list price misses. Without a measured
     cost, their real prompts at the original's prices, cached prompt tokens priced as cached, and
     its usual answer length, because how long its answers would have been cannot be read off a call
     it never answered. Never with our fee on the original: without us they would not pay it. */
  /* A strategy's calls are the ones it answered, whichever of its models did: a cascade call sent
     on is answered by the customer's own model and still paid for as this strategy's, check and
     all. Calls an experiment gave to something else are not this strategy's. */
  const served = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(charged_usd), 0) AS paid, COALESCE(SUM(prompt_tokens), 0) AS pin,
            COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(cached_tokens), 0) AS cached,
            COUNT(*) FILTER (WHERE escalated = 1) AS sent_on
       FROM calls WHERE workload_id = ? AND source = 'routed' AND status_code = 200 AND created_at >= ?
        AND (arm_id = ? OR (arm_id IS NULL AND served_model = ?))`).get(w.id, at, w.routed_arm_id ?? '', to);
  const tried = (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'routed' AND explored = 1 AND created_at >= ?`)
    .get(w.id, at)).n;
  const copies = (await db.prepare(
    `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'trace' AND created_at >= ?`)
    .get(w.id, at)).n;
  const cachedIn = Math.min(Number(served.pin), Number(served.cached || 0));
  const cacheRate = fromPrice?.price_cache_read != null ? Number(fromPrice.price_cache_read) : Number(fromPrice?.price_in ?? 0);
  const wouldHave = measuredRatio !== null && Number(served.cost) > 0
    ? Number(served.cost) / measuredRatio
    : fromPrice
      ? fromPrice.price_in * (served.pin - cachedIn) + cacheRate * cachedIn + fromPrice.price_out * fromOut * served.n
      : null;

  const spent = (await db.prepare(
    'SELECT COALESCE(SUM(spend_usd), 0) AS s FROM eval_runs WHERE workload_id = ?').get(w.id)).s;
  // what background answers on this workload have cost since the switch, which is optimizing too
  const background = (await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM shadow_runs WHERE workload_id = ? AND created_at >= ?').get(w.id, at)).s;
  /* and what reading its live answers in the background has cost since the switch (src/learn/grade.js),
     charged as optimizing like the rest, and left out of the net saving until now */
  const graded = (await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM graded_calls WHERE workload_id = ? AND created_at >= ?').get(w.id, at)).s;
  // and checking its answers against the customer's own model in the background (src/learn/control.js)
  const checked = (await db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM control_checks WHERE workload_id = ? AND created_at >= ?').get(w.id, at)).s;
  const optimizing = withFeeOn(Number(spent) + Number(background) + Number(graded) + Number(checked), fee);
  const savedSoFar = wouldHave == null ? null : wouldHave - served.paid;
  // how long the switch takes to pay back what finding it cost, at the pace it saves now
  const perDay = projection[0] ? projection[0].saved / 30 : null;

  return {
    from, to, at, key, kind,
    label: arm?.label ?? null,
    spec: arm?.spec ?? null,
    how: promo?.actor_user_id ? 'you' : 'automatic',
    evidence: evidence ? {
      runId: evidence.id, at: evidence.at, sample: evidence.sample_size, floor: evidence.floor_pct,
      gap: evidence.gap_pct, verdict: evidence.verdict, escalated: evidence.escalated_pct ?? null,
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
      // how the new strategy's call was priced: as measured, every check and call sent on in it, or at list price
      toPricedBy: measuredRatio !== null ? 'measured' : 'list',
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
      // a cascade's calls sent on to the customer's own model, and calls experiments answered instead
      sentOn: Number(served.sent_on || 0), explored: Number(tried || 0),
      paid: round8(served.paid),
      wouldHave: wouldHave == null ? null : round8(wouldHave),
      saved: savedSoFar == null ? null : round8(savedSoFar),
      // how the original was priced: from the measured cost of the new one, or at list price
      wouldPricedBy: measuredRatio !== null && Number(served.cost) > 0 ? 'measured' : 'list',
      // and what is left once measuring, background answers and reading answers are paid for
      net: savedSoFar == null ? null : round8(savedSoFar - optimizing),
    },
    measuring: {
      spent: round8(withFeeOn(spent, fee)),
      background: round8(withFeeOn(background, fee)),
      graded: round8(withFeeOn(graded, fee)),
      checked: round8(withFeeOn(Number(checked), fee)),
      paybackDays: perDay && perDay > 0 ? Math.ceil(optimizing / perDay) : null,
    },
    projection,
  };
}
