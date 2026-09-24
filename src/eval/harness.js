/* How often are we wrong? Simulations over made-up workloads with known truths, built only from the
 * pure decision pieces the product itself uses (verdictWith, posterior, explorePlan, decide). No
 * model calls, no database: a run takes seconds, so every change to a rule is judged by these
 * numbers rather than argued about. `node scripts/harness.mjs` prints them; test/harness.test.js
 * holds the ones that must stay true. */

import { verdictWith, verdictFor, callsToClear } from './compare.js';
import { posterior, rngFrom } from '../learn/bandit.js';
import { decide, DEFAULTS } from '../learn/decide.js';
import { chanceWithin, safeSaving, rankCleared } from './confidence.js';
import { featuresRaw, crossFitRouter, simulateRoutes } from '../learn/kinds.js';

/**
 * A candidate whose true share of different answers is `gap` (0 to 1), measured on `n` calls against
 * a bar of `floorPct`: how often each verdict comes out, old rule and new. `fractional` draws scores
 * spread between 0 and 1 (a JSON answer partly wrong) with the same mean, instead of yes or no.
 */
export function verdictSim({ gap, n, floorPct, trials = 4000, fractional = false, seed = 1, reviewBand = 1.25 }) {
  const rng = rngFrom(seed);
  const counts = { cleared: 0, review: 0, missed: 0, insufficient: 0 };
  const old = { cleared: 0, review: 0, missed: 0, insufficient: 0 };
  for (let t = 0; t < trials; t += 1) {
    const scores = [];
    for (let i = 0; i < n; i += 1) {
      if (fractional) scores.push(rng() < gap * 2 ? rng() : 0);   // wrong on twice as many calls, each half as wrong on average
      else scores.push(rng() < gap ? 1 : 0);
    }
    counts[verdictWith(scores, floorPct, { reviewBand }).verdict] += 1;
    const g = (scores.reduce((a, b) => a + b, 0) / n) * 100;
    old[verdictFor(g, floorPct, n, { minRuns: n, reviewBand })] += 1;
  }
  const share = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / trials]));
  return { gap, n, floorPct, withIntervals: share(counts), pointEstimate: share(old) };
}

/**
 * The learning loop for one switched workload over `days`, reviewed every hour.
 *   rates: { base, serving, runner } true shares of calls that work (runner may be null)
 *   volume: calls a day; share: the experiment share (half yardstick, half runner)
 *   detection: the share of calls whose outcome is ever seen (the rest read as worked)
 *   budgetHours: hours of each day experiments run before the budget stops them (24 = no pause)
 * Returns what happened and when: the first promote, revert or rest, if any.
 */
export function learnSim({ rates, volume = 500, share = 0.02, days = 30, detection = 1, budgetHours = 24,
  halfLifeDays = 14, seed = 1, decideOpts = {} }) {
  const rng = rngFrom(seed);
  const hours = days * 24;
  const perHour = volume / 24;
  // calls kept as (age in days, n, s) groups per hour, per arm
  const groups = { base: [], serving: [], runner: [] };
  const t0 = 0;
  let first = null;
  const opts = { ...DEFAULTS, ...decideOpts };
  for (let h = 0; h < hours && !first; h += 1) {
    const hourOfDay = h % 24;
    const exploring = hourOfDay < budgetHours;
    const n = Math.round(perHour + (rng() - 0.5));
    let nBase = 0;
    let nRunner = 0;
    if (exploring) {
      for (let i = 0; i < n; i += 1) {
        const u = rng();
        if (u < share / 2) nBase += 1;
        else if (rates.runner !== null && rates.runner !== undefined && u < share) nRunner += 1;
      }
    }
    const nServing = n - nBase - nRunner;
    const draw = (count, rate) => {
      let s = 0;
      for (let i = 0; i < count; i += 1) {
        const worked = rng() < rate;
        // an outcome nobody sees reads as worked
        s += worked || rng() >= detection ? 1 : 0;
      }
      return s;
    };
    groups.serving.push({ at: h, n: nServing, s: draw(nServing, rates.serving) });
    groups.base.push({ at: h, n: nBase, s: draw(nBase, rates.base) });
    if (nRunner) groups.runner.push({ at: h, n: nRunner, s: draw(nRunner, rates.runner) });
    const aged = (gs) => gs.filter((g) => g.n > 0).map((g) => ({ ageDays: (h - g.at) / 24, n: g.n, s: g.s }));
    const prior = { mean: rates.base, strength: 4 };
    const post = (gs) => posterior({ live: aged(gs) }, { halfLifeDays, prior, quantiles: false });
    const st = {
      serving: { id: 'serving', fair: post(groups.serving) },
      base: { id: 'base', fair: post(groups.base) },
      runners: rates.runner === null || rates.runner === undefined ? [] : [{ id: 'runner', fair: post(groups.runner), ratio: 0.5, verdict: 'cleared' }],
      detection, hasEvents: false,
    };
    const d = decide(st, opts);
    if (d.length) first = { kind: d[0].kind, hour: h + 1, day: (h + 1) / 24, loss: d[0].loss };
  }
  return { first: first || { kind: 'nothing', hour: hours, day: days }, t0 };
}

/** Run learnSim many times and count what happened. */
export function learnRates(params, { trials = 200, seed = 100 } = {}) {
  const kinds = { promote: 0, revert: 0, rest: 0, nothing: 0 };
  let daySum = 0;
  let decided = 0;
  for (let t = 0; t < trials; t += 1) {
    const r = learnSim({ ...params, seed: seed + t });
    kinds[r.first.kind] += 1;
    if (r.first.kind !== 'nothing') { daySum += r.first.day; decided += 1; }
  }
  return { ...Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v / trials])), meanDay: decided ? daySum / decided : null };
}

/* Which setup is switched to --------------------------------------------------------------------- */

/**
 * Which of a workload's cheaper setups a measurement switches to, under a routing priority. `setups(rng)`
 * makes one workload's setups with their truths: [{ id, rate, ratio, p50 }], where `rate` is the true share
 * of worse or different answers, `ratio` what it costs against the customer's model, and `p50` its typical
 * time against the customer's model's (1). Each is measured on `n` calls against a pass mark of
 * `floorPct`, the ones that cleared are ranked by `mode` (rankCleared), and the first `tries` in line are
 * looked at again on `fresh` calls they have never seen, as run.js does. Over `trials` workloads: how often
 * anything was switched to; how often what was switched to truly breaks the promise (its true rate is past
 * the pass mark); the true saving, after the fee, averaged over every workload; how fast what was switched
 * to is; and how often it was the one `best(setups)` names, for scenarios with a right answer.
 */
export function choiceSim({ setups, mode = 'balanced', tries = 3, n = 120, fresh = null, floorPct = 3, trials = 2000,
  seed = 1, confirmZ = null, cautiousChance = 0.99, feePct = 1, reviewBand = 1.25, best = null, secondLook = true }) {
  const rng = rngFrom(seed);
  const z = confirmZ ?? (mode === 'cautious' ? 1.96 : 1.6449);
  // as many fresh calls as run.js takes: twice the fewest a perfect run needs at the usual strictness, never fewer than the first look
  const look = fresh ?? Math.max(30, Math.ceil(2 * callsToClear(floorPct)), n);
  const draw = (rate, m) => {
    const out = new Array(m);
    for (let i = 0; i < m; i += 1) out[i] = rng() < rate ? 1 : 0;
    return out;
  };
  let switched = 0;
  let broken = 0;
  let saving = 0;
  let speed = 0;
  let right = 0;
  for (let t = 0; t < trials; t += 1) {
    const ss = setups(rng);
    const rows = [];
    for (const s of ss) {
      const scores = draw(s.rate, n);
      if (verdictWith(scores, floorPct, { reviewBand }).verdict !== 'cleared') continue;
      if (!(s.ratio < 1 / (1 + feePct / 100))) continue;
      const chance = chanceWithin(scores, floorPct);
      rows.push({ model_id: s.id, truth: s, cost_month_usd: s.ratio, cost_ratio: s.ratio, chance,
        safe_saving: safeSaving(s.ratio, chance, feePct), latency_p50: s.p50 * (0.9 + 0.2 * rng()) });
    }
    let chosen = null;
    let looked = 0;
    const order = rankCleared(rows, { mode, cautiousChance }).order;
    // with no second look, the first in line is switched to on its first look alone, as it once was
    if (!secondLook && order.length) chosen = order[0].truth;
    for (const r of secondLook ? order : []) {
      if (looked >= tries) break;
      looked += 1;
      if (verdictWith(draw(r.truth.rate, look), floorPct, { reviewBand, z }).verdict === 'cleared') {
        chosen = r.truth;
        break;
      }
    }
    if (!chosen) continue;
    switched += 1;
    if (chosen.rate > floorPct / 100) broken += 1;
    saving += Math.max(0, 1 - chosen.ratio * (1 + feePct / 100));
    speed += chosen.p50;
    if (best && chosen.id === best(ss)) right += 1;
  }
  return {
    mode, tries, switched: switched / trials, broken: broken / trials, brokenOfSwitched: switched ? broken / switched : 0,
    saving: saving / trials, speed: switched ? speed / switched : null, right: best ? right / trials : null,
  };
}

/* A router by kind of request ------------------------------------------------------------------- */

const ITEMS = ['shoes', 'a jacket', 'the lamp', 'two books', 'a kettle', 'the charger', 'socks', 'a tent', 'the blender', 'a rug'];
const WHEN = ['last week', 'on Monday', 'ten days ago', 'yesterday', 'a month ago', 'before the holidays'];
const STREETS = ['Mill Lane', 'Harbour Road', 'Station Street', 'Elm Avenue', 'Kings Parade'];
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
const num = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo));

/** Kinds of request a made-up workload gets, each written a few different ways. */
export const REQUEST_KINDS = {
  order: (rng) => pick(rng, [
    () => `Where is my order ${num(rng, 1000, 99999)}? I ordered ${pick(rng, ITEMS)} ${pick(rng, WHEN)}.`,
    () => `Has order ${num(rng, 1000, 99999)} shipped yet? It was ${pick(rng, ITEMS)}.`,
    () => `Can you tell me when order ${num(rng, 1000, 99999)} will arrive? I bought ${pick(rng, ITEMS)} ${pick(rng, WHEN)}.`,
  ])(),
  refund: (rng) => pick(rng, [
    () => `I was charged twice for order ${num(rng, 1000, 99999)} and the refund for ${pick(rng, ITEMS)} never arrived, even though `
      + `support promised a full refund and the return label was sent back ${pick(rng, WHEN)}. Please explain the charges.`,
    () => `The refund for ${pick(rng, ITEMS)} on order ${num(rng, 1000, 99999)} is missing. I returned it ${pick(rng, WHEN)} and my `
      + `card still shows both charges, one of ${num(rng, 10, 400)} and another of ${num(rng, 10, 400)}. What happened to my money?`,
    () => `You refunded the wrong amount on order ${num(rng, 1000, 99999)}: I paid ${num(rng, 10, 400)} for ${pick(rng, ITEMS)} and `
      + `got back ${num(rng, 1, 90)}. The damaged item went back ${pick(rng, WHEN)}. Please sort out the difference.`,
  ])(),
  address: (rng) => pick(rng, [
    () => `Please change the delivery address for order ${num(rng, 1000, 99999)} to ${num(rng, 1, 200)} ${pick(rng, STREETS)}.`,
    () => `I moved ${pick(rng, WHEN)}. Can order ${num(rng, 1000, 99999)} go to ${num(rng, 1, 200)} ${pick(rng, STREETS)} instead?`,
  ])(),
  document: (rng) => `document #${num(rng, 1, 100000)}`,
};

/**
 * A router by kind of request, learned from one measurement's calls, over made-up workloads with known
 * truths. `kinds` [{ make(rng), share }] is what the workload is asked and how often; `options`
 * [{ ratio, rates }] are the cheaper setups, with their cost against the customer's model and their true
 * share of worse answers on each kind. Each trial learns a router from `n` calls exactly as run.js does
 * (crossFitRouter, the verdict on the calls it did not learn from, cheaper than the customer's model and
 * than the best single setup that cleared), takes a second look on `fresh` calls, and then reads the
 * truth from `test` more. Reported with the kinds check (kindsZ at least `liftZ`) and without it:
 *   switched     how often a router was switched to
 *   broken       how often the router switched to is past the pass mark over all its calls
 *   diluted      how often the calls it sends to cheaper setups are past the pass mark, which is what
 *                a router whose kinds mean nothing does: it mixes a worse model into part of the traffic
 *   gap, saving  its true share of worse answers and its true saving after the fee, when switched
 */
export function routerSim({ kinds, options, n = 120, fresh = null, test = 1500, floorPct = 3, trials = 40, seed = 1,
  liftZ = 1.645, feePct = 1, refCost = 0.002, shrink = 2, prior = 0, margin = 0.8, sureShrink = 0, pick = 'best', refNoise = 0, zs = null }) {
  const rng = rngFrom(seed);
  const look = fresh ?? Math.max(30, Math.ceil(2 * callsToClear(floorPct)), n);
  const learn = { floorPct, margin, shrink, prior, sureShrink, pick, feePct, kMax: 4, minSize: 8, minSilhouette: 0.1, seed: 7,
    looks: [{ n }, { n: look }] };
  const gen = (m) => Array.from({ length: m }, () => {
    const u = rng();
    let k = 0;
    let acc = kinds[0].share;
    while (u > acc && k < kinds.length - 1) { k += 1; acc += kinds[k].share; }
    const body = { messages: [{ role: 'system', content: 'You answer customers about their orders.' },
      { role: 'user', content: kinds[k].make(rng) }] };
    return {
      kind: k, raw: featuresRaw(body),
      results: options.map((o) => ({ ok: true, score: rng() < o.rates[k] ? 1 : 0, cost: o.ratio * refCost, latency: 800, ttft: 200 })),
      ref: { noise: rng() < refNoise ? 1 : 0, cost: refCost, latency: 1200, ttft: 300 },
    };
  });
  const opts = options.map((o, j) => ({ model: `option-${j}`, key: `option-${j}`, ratio: o.ratio }));
  const tally = () => ({ switched: 0, broken: 0, diluted: 0, gap: 0, saving: 0 });
  const withCheck = tally();
  const without = tally();
  // the same routers read with other strictnesses of the kinds check, to choose it by (ROUTER_KIND_LIFT_Z)
  const byZ = new Map((zs || []).map((z) => [z, tally()]));
  let formed = 0;
  let kindsZ = 0;
  for (let t = 0; t < trials; t += 1) {
    const calls = gen(n);
    const cf = crossFitRouter(calls, opts, learn);
    if (!cf) continue;
    formed += 1;
    kindsZ += cf.heldOut.kindsZ;
    const singles = options.map((o, j) => (verdictWith(calls.map((c) => c.results[j].score), floorPct).verdict === 'cleared' ? o.ratio : null))
      .filter((x) => x !== null);
    const bestSingle = singles.length ? Math.min(...singles) : null;
    const passes = verdictWith(cf.heldOut.scores, floorPct).verdict === 'cleared' && cf.heldOut.ratio !== null
      && cf.heldOut.ratio <= 0.95 && (bestSingle === null || cf.heldOut.ratio <= bestSingle * 0.95);
    if (!passes) continue;
    if (verdictWith(simulateRoutes(cf.spec, gen(look)).scores, floorPct).verdict !== 'cleared') continue;
    const truth = simulateRoutes(cf.spec, gen(test));
    const toCheaper = truth.scores.filter((_, i) => truth.served[i] >= 0);
    const cheaperGap = toCheaper.length ? (toCheaper.reduce((a, b) => a + b, 0) / toCheaper.length) * 100 : 0;
    for (const [tl, on] of [[without, true], [withCheck, cf.heldOut.kindsZ >= liftZ], ...[...byZ].map(([z, t]) => [t, cf.heldOut.kindsZ >= z])]) {
      if (!on) continue;
      tl.switched += 1;
      if (truth.gap > floorPct) tl.broken += 1;
      if (cheaperGap > floorPct) tl.diluted += 1;
      tl.gap += truth.gap;
      tl.saving += Math.max(0, 1 - truth.ratio * (1 + feePct / 100));
    }
  }
  const out = (tl) => ({
    switched: tl.switched / trials, broken: tl.broken / trials, diluted: tl.diluted / trials,
    gap: tl.switched ? tl.gap / tl.switched : null, saving: tl.switched ? tl.saving / tl.switched : null,
  });
  return { formed: formed / trials, kindsZ: formed ? kindsZ / formed : null, withCheck: out(withCheck), without: out(without),
    byZ: Object.fromEntries([...byZ].map(([z, t]) => [z, out(t)])) };
}
