/* The fair record of one strategy: how often its calls work, and what one of them costs, read over the
 * whole of a workload's traffic from the calls it was given by chance. Pure: numbers in, numbers out.
 *
 * Each strategy answers only a share of the calls, and the share moves: a switch starts on five calls
 * in a hundred and grows, the customer's own model answers ninety five in a hundred while a switch
 * takes over and one or two in a hundred once it has, a day's budget pauses experiments. A record
 * that simply counted each strategy's own calls would describe the days it happened to get many of,
 * and two strategies would be compared on different days. So every call counts for one over the chance
 * it had of being served that way: a yardstick call given one chance in a hundred stands for a hundred
 * calls of that day's traffic, one given ninety five in a hundred for about one. Every strategy's record
 * is then a reading of the same traffic, day for day, and a difference between two is theirs rather
 * than the season's. (Weighting within each day and then pooling days by each strategy's own count
 * undid exactly this: the yardstick's record became its rollout days and what serves' became the days
 * after, so a drift in how often calls fail read as one strategy being worse than the other.)
 *
 * The unit is the task, not the call. A conversation or an agent's loop stays on the strategy its first
 * step was given (src/learn/choose.js), so its steps were chosen once, together, and they tend to
 * succeed or fail together. Counted as calls, one forty step task looked like forty independent pieces
 * of evidence. So each task is one unit: it carries its steps and how well they worked, weighted once
 * by its chance, and the number of units the record is worth (the effective count below) treats its
 * steps as one piece of evidence that may weigh more, never as many.
 *
 * Older days count for less, halving every `halfLifeDays`, the costs as much as the rates. The
 * effective count is Kish's: (sum of weights) squared over the sum of squared weights, over tasks,
 * which is what the spread of a weighted average of that many tasks comes to. */

/**
 * One strategy's days, as the database sums them. Each day (by the age of each task's first step):
 *   tasks  the tasks it answered;           n     the calls (steps) in them
 *   wn     sum over tasks of w x steps;     ws    sum over tasks of w x how well its steps worked
 *   q      sum over tasks of (w x steps) squared
 *   ok     calls it answered (status 200);  wok   sum over tasks of w x such calls
 *   wcost  sum over tasks of w x what those calls cost
 * where w is one over the chance the task was given.
 */
export function combineDays(days = [], { halfLifeDays = 14 } = {}) {
  const out = { tasks: 0, n: 0, wn: 0, ws: 0, q: 0, ok: 0, wok: 0, wcost: 0 };
  for (const d of days) {
    const dec = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? 0.5 ** (Math.max(0, Number(d.ageDays) || 0) / halfLifeDays) : 1;
    out.tasks += Number(d.tasks) || 0;
    out.n += Number(d.n) || 0;
    out.ok += Number(d.ok) || 0;
    out.wn += dec * (Number(d.wn) || 0);
    out.ws += dec * (Number(d.ws) || 0);
    out.q += dec * dec * (Number(d.q) || 0);
    out.wok += dec * (Number(d.wok) || 0);
    out.wcost += dec * (Number(d.wcost) || 0);
  }
  return out;
}

/**
 * A record of how often calls work, in the Beta form the rest of learning reads ({ a, b, nLive,
 * liveRate }), from combined sums. The workload's own rate is the starting point, held lightly (see
 * posterior in bandit.js), so a strategy with a handful of tasks reads close to what is usual.
 *   nLive     the calls behind it, for saying so
 *   tasks     the tasks behind it: what "enough evidence" is counted in
 *   nEff      what the weighted tasks are worth, as a number of equally weighted ones
 *   liveRate  the share of the traffic's calls that worked, read through this strategy, or null
 *   costPerCall  what one call it answered costs, read the same way, or null
 */
export function fairRecord(sums = {}, { prior = { mean: 0.9, strength: 4 } } = {}) {
  const m = Math.min(0.98, Math.max(0.02, Number(prior.mean ?? 0.9)));
  const strength = Number(prior.strength ?? 4);
  const a0 = Math.max(0.5, m * strength);
  const b0 = Math.max(0.5, (1 - m) * strength);
  const wn = Number(sums.wn) || 0;
  const q = Number(sums.q) || 0;
  const rate = wn > 0 ? Math.max(0, Math.min(1, (Number(sums.ws) || 0) / wn)) : null;
  // rounded, so equal chances count every task exactly rather than 249.9999
  const nEff = wn > 0 && q > 0 ? Math.round(((wn * wn) / q) * 1000) / 1000 : 0;
  const a = a0 + (rate ?? 0) * nEff;
  const b = b0 + (1 - (rate ?? 0)) * nEff;
  const wok = Number(sums.wok) || 0;
  return {
    a, b, mean: a / (a + b), nLive: Number(sums.n) || 0, tasks: Number(sums.tasks) || 0, nEff,
    liveRate: rate, weight: nEff,
    costPerCall: wok > 0 ? (Number(sums.wcost) || 0) / wok : null, okCalls: Number(sums.ok) || 0,
  };
}
