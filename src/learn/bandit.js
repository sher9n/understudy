/* The arithmetic of learning which way of serving a workload works best. Pure: every function
 * here takes numbers and returns numbers, and a random source can be passed in so any draw can
 * be replayed.
 *
 * Each strategy's record is kept as a Beta distribution over one number, the share of its calls
 * that work. Every call it served adds what happened to it (worked, or not, or somewhere in
 * between); older calls count for less, halving every couple of weeks, because models and
 * providers change and last month's record should not outvote this week's. Answers a strategy
 * gave in the background, never seen by anybody, count for less again, because matching the
 * live answer is only a stand-in for working.
 *
 * From those records come three things: a range the true rate very likely sits in, the chance
 * one strategy works at least about as often as another, and, for experiments, how often each
 * candidate should be tried (Thompson sampling: each is tried as often as it has a chance of
 * being the best, so a candidate that is clearly worse is soon hardly tried at all). */

/** A small seeded random source (mulberry32), so a draw can be replayed in a test. */
export function rngFrom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (rng) => {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

/** Gamma(k, 1), by Marsaglia and Tsang; below 1 by the usual boost. */
export function sampleGamma(k, rng = Math.random) {
  if (k < 1) return sampleGamma(k + 1, rng) * rng() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a, b, rng = Math.random) {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

/* The regularized incomplete beta function, by its continued fraction, which is what a Beta's
   cumulative distribution is. Used for exact ranges rather than ranges read off random draws. */
const lnGamma = (z) => {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) { y += 1; ser += c / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
};

function betacf(a, b, x) {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

export function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** The value a Beta(a, b) falls below with probability p. */
export function betaQuantile(p, a, b) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * A strategy's record, from its calls grouped by how many days old they are.
 *   live: [{ ageDays, n, s }]   calls it answered for real: n calls, s the sum of how well each worked
 *   shadow: [{ ageDays, n, s }] answers it gave in the background: s the sum of how closely each matched
 * The starting point is the workload's own rate across everything, held lightly, so a strategy
 * with a handful of calls reads close to what is usual here rather than at an extreme.
 */
export function posterior({ live = [], shadow = [] } = {}, {
  halfLifeDays = 14, surrogateWeight = 0.3, prior = { mean: 0.9, strength: 4 }, quantiles = true,
} = {}) {
  const m = Math.min(0.98, Math.max(0.02, Number(prior.mean ?? 0.9)));
  let a = Math.max(0.5, m * prior.strength);
  let b = Math.max(0.5, (1 - m) * prior.strength);
  let nLive = 0;
  let sLive = 0;
  let nShadow = 0;
  let sShadow = 0;
  let weight = 0;
  for (const g of live) {
    const w = 0.5 ** (Math.max(0, g.ageDays) / halfLifeDays);
    a += w * g.s;
    b += w * (g.n - g.s);
    weight += w * g.n;
    nLive += g.n;
    sLive += g.s;
  }
  for (const g of shadow) {
    const w = surrogateWeight * 0.5 ** (Math.max(0, g.ageDays) / halfLifeDays);
    a += w * g.s;
    b += w * (g.n - g.s);
    weight += w * g.n;
    nShadow += g.n;
    sShadow += g.s;
  }
  return {
    a, b, mean: a / (a + b),
    lo: quantiles ? betaQuantile(0.05, a, b) : null, hi: quantiles ? betaQuantile(0.95, a, b) : null,
    nLive, nShadow, weight,
    liveRate: nLive ? sLive / nLive : null,
    shadowRate: nShadow ? sShadow / nShadow : null,
  };
}

/** The chance strategy A works at least as often as B, less a tolerance: P(A >= B - delta). */
export function probAtLeast(A, B, delta = 0, { draws = 4000, rng = rngFrom(7) } = {}) {
  let n = 0;
  for (let i = 0; i < draws; i += 1) {
    if (sampleBeta(A.a, A.b, rng) >= sampleBeta(B.a, B.b, rng) - delta) n += 1;
  }
  return n / draws;
}

/**
 * What is expected to be lost by serving A instead of B: E[max(0, B - A)] over both records. Near
 * zero when A is very likely at least as good; it keeps growing the more B is likely to be better,
 * and by how much. Far less sensitive to being looked at every hour than "P(A >= B) >= 0.95".
 */
export function expectedLoss(A, B, { draws = 0, rng = rngFrom(13), shift = 0 } = {}) {
  // `shift` moves the yardstick: the loss against B being `shift` worse than it is
  if (draws > 0) {
    let sum = 0;
    for (let i = 0; i < draws; i += 1) sum += Math.max(0, sampleBeta(B.a, B.b, rng) - shift - sampleBeta(A.a, A.b, rng));
    return sum / draws;
  }
  /* In closed form: the difference of two records is close to normal once each holds a few calls,
     and E[max(0, D)] for a normal D is mu * Phi(mu / sigma) + sigma * phi(mu / sigma). Exact
     enough here, and instant, which lets the harness review a workload every hour for a month
     ten thousand times over. */
  const mv = (X) => {
    const n = X.a + X.b;
    return { m: X.a / n, v: (X.a * X.b) / (n * n * (n + 1)) };
  };
  const a = mv(A);
  const b = mv(B);
  const mu = b.m - shift - a.m;
  const sigma = Math.sqrt(a.v + b.v) || 1e-9;
  const z = mu / sigma;
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const Phi = 0.5 * (1 + erf(z / Math.SQRT2));
  return Math.max(0, mu * Phi + sigma * phi);
}

/**
 * How far apart two records are, in units of how sure we can be: (mean A - mean B) over the
 * standard deviation of the difference. A z of 3 is passed by chance about one look in seven
 * hundred, which is what a decision looked at every hour for a month has to survive.
 */
export function zDiff(A, B) {
  const mv = (X) => { const n = X.a + X.b; return { m: X.a / n, v: (X.a * X.b) / (n * n * (n + 1)) }; };
  const a = mv(A);
  const b = mv(B);
  return { mu: a.m - b.m, sigma: Math.sqrt(a.v + b.v) || 1e-9, z: (a.m - b.m) / (Math.sqrt(a.v + b.v) || 1e-9) };
}

// Abramowitz and Stegun 7.1.26, good to a few parts in ten million
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** How often each candidate would be the best in a draw from every record: Thompson sampling. */
export function thompsonShares(arms, { draws = 400, rng = rngFrom(11) } = {}) {
  const wins = new Map(arms.map((x) => [x.id, 0]));
  if (arms.length === 1) return new Map([[arms[0].id, 1]]);
  for (let i = 0; i < draws; i += 1) {
    let best = null;
    let top = -1;
    for (const x of arms) {
      const v = sampleBeta(x.a, x.b, rng);
      if (v > top) { top = v; best = x.id; }
    }
    wins.set(best, wins.get(best) + 1);
  }
  return new Map([...wins].map(([k, v]) => [k, v / draws]));
}

/**
 * Who answers one call, as chances that add up to one. `share` is how much of the traffic may be
 * experimented on. Half of it goes to the customer's own model, as the yardstick the serving
 * strategy is compared with; half to the candidates, split by Thompson sampling. With no
 * candidates, only the yardstick half is used, and the rest stays with what serves.
 */
export function explorePlan({ share, serving, candidates = [], baseline = null }, opts = {}) {
  const plan = [];
  let used = 0;
  const half = share / 2;
  if (baseline && baseline.id !== serving.id) {
    plan.push({ arm: baseline, p: half, why: 'yardstick' });
    used += half;
  }
  const pool = candidates.filter((c) => c.id !== serving.id && c.id !== baseline?.id);
  if (pool.length) {
    const shares = thompsonShares(pool.map((c) => ({ id: c.id, a: c.post.a, b: c.post.b })), opts);
    for (const c of pool) {
      const p = half * shares.get(c.id);
      if (p > 0) plan.push({ arm: c, p, why: 'candidate' });
      used += p;
    }
  }
  plan.unshift({ arm: serving, p: Math.max(0, 1 - used), why: 'serving' });
  return plan;
}

/** One draw from a plan, by a number between 0 and 1. */
export function pickFrom(plan, u) {
  let acc = 0;
  for (const x of plan) {
    acc += x.p;
    if (u < acc) return x;
  }
  return plan[0];
}
