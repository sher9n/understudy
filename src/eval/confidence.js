/* How sure a measurement can be that a setup keeps the promise. Pure, so every number on a certificate
 * can be checked by hand.
 *
 * A setup clears when even the top of its range is inside the pass mark (see verdictWith). A measurement
 * is a sample, so two setups can both clear while one of them is much surer to keep the promise than the
 * other. That chance is kept with each result: a workload optimizing for quality only switches to setups it
 * is at least CAUTIOUS_MIN_CHANCE sure of, and the router by kind of request weighs its savings by it. Which
 * of the setups that cleared is switched to is src/eval/score.js: the best score for quality, cost and speed.
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
