/* How sure a measurement can be that a setup keeps the promise, and which of the setups that
 * cleared to switch to. Pure, so every number on a certificate can be checked by hand.
 *
 * A setup clears when even the top of its range is inside the pass mark (see verdictWith). Among
 * the ones that clear, the cheapest used to win outright. That is right when "cleared" is certain,
 * and a measurement is a sample: two setups can both clear while one of them is much surer to keep
 * the promise than the other, or answer much faster. So the choice depends on the workload's
 * routing priority:
 *
 *   savings   the cheapest that cleared, as it always was;
 *   balanced  the biggest saving we can be sure of: what it saves, times the chance its true rate of
 *             worse or different answers is inside the pass mark; setups within a point of each
 *             other go to the faster one, then the cheaper one;
 *   cautious  the same ranking, among setups we are at least CAUTIOUS_MIN_CHANCE sure of, and the
 *             second look is held to a stricter bound (see run.js).
 *
 * The chance comes from the calls themselves: with k worse or different answers in n (a score of a
 * half counts as half of one), the true rate is taken as Beta(k + 1/2, n - k + 1/2), which is what
 * the calls say with nothing assumed beforehand, and the chance is how much of that lies at or under
 * the pass mark. */

/** The logarithm of the gamma function (Lanczos), for the incomplete beta below and the router's odds (kinds.js). */
export function logGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x0 = z - 1;
  let x = c[0];
  for (let i = 1; i < 9; i += 1) x += c[i] / (x0 + i);
  const t = x0 + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x0 + 0.5) * Math.log(t) - t + Math.log(x);
}

/* The continued fraction for the incomplete beta (Lentz's method). */
function betaFraction(a, b, x) {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 3e-14) break;
  }
  return h;
}

/** P(X <= x) for X ~ Beta(a, b). */
export function betaCdf(x, a, b) {
  if (!(a > 0) || !(b > 0)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(a, b, x)) / a;
  return 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/**
 * The chance a setup's true rate of worse or different answers is at or under the pass mark, from
 * its per-call scores (0 the same or at least as good, 1 worse or different, a half for half).
 */
export function chanceWithin(scores, floorPct) {
  const xs = (scores || []).filter((s) => s !== null && s !== undefined && Number.isFinite(Number(s)))
    .map((s) => Math.max(0, Math.min(1, Number(s))));
  const n = xs.length;
  const k = xs.reduce((a, b) => a + b, 0);
  const f = Math.max(0, Math.min(1, Number(floorPct) / 100));
  if (!Number.isFinite(f)) return null;
  return betaCdf(f, k + 0.5, n - k + 0.5);
}

/** What a setup saves once our fee is added, as a share of the customer's own cost, times how sure we are. */
export function safeSaving(costRatio, chance, feePct = 1) {
  if (costRatio === null || costRatio === undefined || !Number.isFinite(Number(costRatio))) return null;
  if (chance === null || chance === undefined || !Number.isFinite(Number(chance))) return null;
  const saving = Math.max(0, 1 - Number(costRatio) * (1 + (Number(feePct) || 0) / 100));
  return saving * Math.max(0, Math.min(1, Number(chance)));
}

export const ROUTING_MODES = ['cautious', 'balanced', 'savings'];

/** A workload's routing priority: its own choice, else its workspace's, else the deployment's. */
export function routingModeOf(workload, workspace = null, fallback = 'balanced') {
  const pick = (m) => (ROUTING_MODES.includes(m) ? m : null);
  return pick(workload?.routing_mode) || pick(workspace?.default_routing_mode) || pick(fallback) || 'balanced';
}

/* The speed a setup is ranked on: time to the first word where the workload is timed that way,
   otherwise time to the whole answer. A setup with no timing sorts after one with. */
const speedOf = (r, metric) => {
  const v = Number(metric === 'ttft' ? (r.ttft_p50 ?? r.latency_p50) : r.latency_p50);
  return Number.isFinite(v) && v > 0 ? v : Infinity;
};

/**
 * The setups that cleared, in the order they are looked at again and switched to.
 * rows: eval_results rows with cost_month_usd, cost_ratio, chance, safe_saving and timings.
 * Answers { order, left }: `left` are the ones a cautious workload would not switch to, with why.
 */
export function rankCleared(rows, { mode = 'balanced', metric = 'latency', cautiousChance = 0.99, bucket = 0.01 } = {}) {
  const all = [...(rows || [])];
  const byCost = (a, b) => (Number(a.cost_month_usd) - Number(b.cost_month_usd));
  if (mode === 'savings') return { order: all.sort(byCost), left: [] };
  const left = [];
  let pool = all;
  if (mode === 'cautious') {
    pool = all.filter((r) => Number(r.chance) >= cautiousChance);
    for (const r of all) if (!(Number(r.chance) >= cautiousChance)) left.push({ row: r, why: 'not sure enough for a cautious workload' });
  }
  const safe = (r) => {
    const s = Number(r.safe_saving);
    return Number.isFinite(s) ? s : -1;
  };
  /* Within a point of saving of each other counts as a tie, and a tie goes to the faster one. Grouped
     from the top: each group is the setups within `bucket` of the surest saving still left, so the
     order is the same however the setups arrive, and two a hair apart are never split by rounding. */
  const bySafe = [...pool].sort((a, b) => (safe(b) - safe(a)) || byCost(a, b));
  const groups = [];
  for (const r of bySafe) {
    const g = groups[groups.length - 1];
    if (g && safe(g[0]) - safe(r) <= bucket + 1e-12) g.push(r);
    else groups.push([r]);
  }
  const order = groups.flatMap((g) => g.sort((a, b) => (speedOf(a, metric) - speedOf(b, metric))
    || (safe(b) - safe(a)) || byCost(a, b)));
  return { order, left };
}
