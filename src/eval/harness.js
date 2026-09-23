/* How often are we wrong? Simulations over made-up workloads with known truths, built only from the
 * pure decision pieces the product itself uses (verdictWith, posterior, explorePlan, decide). No
 * model calls, no database: a run takes seconds, so every change to a rule is judged by these
 * numbers rather than argued about. `node scripts/harness.mjs` prints them; test/harness.test.js
 * holds the ones that must stay true. */

import { verdictWith, verdictFor } from './compare.js';
import { posterior, rngFrom } from '../learn/bandit.js';
import { decide, DEFAULTS } from '../learn/decide.js';

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
