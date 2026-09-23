/* How often the live rule is wrong over a long run, with the record the product really keeps. Pure: no
 * database, no model, seeded so any run can be replayed.
 *
 * src/eval/harness.js simulates a month of hourly looks with a plain decayed count per strategy. The
 * product's record is read another way (src/learn/fair.js): every task weighted by one over the chance
 * it had, decayed by age, worth Kish's effective count. And a workload is looked at every hour for as
 * long as it runs, not for a month. A decayed record stops growing after a few half-lives, so from then
 * on each look is much like the one a few weeks before it, and a rule that is wrong one time in a
 * thousand per few weeks is wrong more and more often the longer it is looked at. This runs the same
 * traffic, the same record and the same rule (decide in src/learn/decide.js) for as many days as asked,
 * and counts what the rule did and when. */

import { rngFrom } from './bandit.js';
import { fairRecord } from './fair.js';
import { decide, DEFAULTS } from './decide.js';

/**
 * One switched workload, looked at every hour for `days`.
 *   rates        { base, serving, runner }: the true share of calls that work (runner may be null)
 *   volume       tasks a day; `steps` calls each, which succeed or fail together
 *   share        the experiment share: half to the customer's own model, half to the runner-up
 *   detection    the share of failures that are ever seen (the rest read as worked)
 *   budgetHours  hours of each day experiments run before the budget pauses them
 *   decideOpts   passed to decide, as the product passes its settings
 * Returns the first decision and when it came: { kind, hour, day }.
 */
export function liveSim({ rates, volume = 1000, share = 0.02, days = 180, detection = 1, budgetHours = 24, steps = 1,
  halfLifeDays = 14, windowHalfLives = 8, seed = 1, decideOpts = {} }) {
  const rng = rngFrom(seed);
  const opts = { ...DEFAULTS, ...decideOpts };
  const hours = days * 24;
  const perHour = volume / 24;
  const fade = 0.5 ** (1 / (24 * halfLifeDays));
  const windowHours = Math.round(windowHalfLives * halfLifeDays * 24);
  const arms = ['serving', 'base', ...(rates.runner === null || rates.runner === undefined ? [] : ['runner'])];
  // running sums per strategy, decayed hour by hour, and the hours still inside the window
  const sums = Object.fromEntries(arms.map((k) => [k, { tasks: 0, n: 0, w: 0, ws: 0, q: 0 }]));
  const kept = Object.fromEntries(arms.map((k) => [k, []]));
  let allN = 0;
  let allS = 0;
  const allKept = [];
  const worked = (rate) => (rng() < rate || rng() >= detection ? 1 : 0);
  for (let h = 0; h < hours; h += 1) {
    for (const k of arms) {
      const s = sums[k];
      s.w *= fade;
      s.ws *= fade;
      s.q *= fade * fade;
      // an hour that has left the window takes what it added, as much of it as is left
      while (kept[k].length && h - kept[k][0].at >= windowHours) {
        const g = kept[k].shift();
        const f = fade ** (h - g.at);
        s.tasks -= g.tasks;
        s.n -= g.n;
        s.w -= g.w * f;
        s.ws -= g.ws * f;
        s.q -= g.q * f * f;
      }
    }
    while (allKept.length && h - allKept[0].at >= windowHours) {
      const g = allKept.shift();
      allN -= g.n;
      allS -= g.s;
    }
    const exploring = h % 24 < budgetHours;
    const n = Math.round(perHour + (rng() - 0.5));
    const pOf = { base: share / 2, runner: share / 2, serving: 1 - (arms.includes('runner') ? share : share / 2) };
    const group = Object.fromEntries(arms.map((k) => [k, { at: h, tasks: 0, n: 0, w: 0, ws: 0, q: 0 }]));
    let hourN = 0;
    let hourS = 0;
    for (let i = 0; i < n; i += 1) {
      let arm = 'serving';
      if (exploring) {
        const u = rng();
        if (u < share / 2) arm = 'base';
        else if (arms.includes('runner') && u < share) arm = 'runner';
      }
      const ok = worked(rates[arm]);
      hourN += steps;
      hourS += ok * steps;
      // what serves answering while nothing else could have is not a fair call, as in the product
      if (!exploring) continue;
      const w = 1 / pOf[arm];
      const g = group[arm];
      g.tasks += 1;
      g.n += steps;
      g.w += w;
      g.ws += w * ok;
      g.q += w * w;
    }
    allN += hourN;
    allS += hourS;
    allKept.push({ at: h, n: hourN, s: hourS });
    for (const k of arms) {
      const g = group[k];
      if (!g.tasks) continue;
      kept[k].push(g);
      const s = sums[k];
      s.tasks += g.tasks;
      s.n += g.n;
      s.w += g.w;
      s.ws += g.ws;
      s.q += g.q;
    }
    const prior = { mean: allN >= 20 ? allS / allN : 0.95, strength: 4 };
    const rec = (k) => fairRecord(sums[k], { prior });
    const d = decide({
      serving: { id: 'serving', fair: rec('serving') },
      base: { id: 'base', fair: rec('base') },
      runners: arms.includes('runner') ? [{ id: 'runner', fair: rec('runner'), ratio: 0.5, verdict: 'cleared' }] : [],
      detection, hasEvents: false, days: (h + 1) / 24,
    }, opts);
    if (d.length) return { kind: d[0].kind, hour: h + 1, day: (h + 1) / 24 };
  }
  return { kind: 'nothing', hour: hours, day: days };
}

/** Run liveSim many times and count what happened, and by when: `by` is the share decided by each day asked. */
export function liveRates(params, { trials = 200, seed = 100, byDays = [] } = {}) {
  const kinds = { promote: 0, revert: 0, rest: 0, nothing: 0 };
  const by = Object.fromEntries(byDays.map((d) => [d, { promote: 0, revert: 0, rest: 0 }]));
  for (let t = 0; t < trials; t += 1) {
    const r = liveSim({ ...params, seed: seed + t });
    kinds[r.kind] += 1;
    for (const d of byDays) if (r.kind !== 'nothing' && r.day <= d) by[d][r.kind] += 1;
  }
  const share = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / trials]));
  return { ...share(kinds), by: Object.fromEntries(Object.entries(by).map(([d, o]) => [d, share(o)])), trials };
}
