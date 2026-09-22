/* What a strategy would have done on a measurement's calls, worked out from answers already paid
 * for. Pure: every number can be checked by hand.
 *
 * A measurement has, for every sampled call, the cheap model's answer and how far it was from the
 * customer's model, and the customer's model's own two answers. That is everything a cascade
 * would have seen. For each strictness of the check, a call either keeps the cheap answer (its
 * difference, the cheap price, the check's cost and time) or is sent on (the customer's model's
 * answer, which differs from itself only as much as it ever does, at the price of both calls and
 * the check). The strictness that stays inside the bar for the least money wins. */

export const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * calls: one per measured call, in order:
 *   { ok, score, cost, latency, ttft, check: { pass(t) -> bool } | { structureOk, p }, ref: { cost, latency, ttft, noise } }
 * Returns one reading per threshold: { threshold, gap, escalated, cost, refCost, ratio, latency: [], ttft: [], served: [] }
 */
export function simulateCascade(calls, { thresholds = THRESHOLDS, checkCost = () => 0, checkMs = () => 0 } = {}) {
  return thresholds.map((t) => {
    let sum = 0;
    let n = 0;
    let escalated = 0;
    let cost = 0;
    let refCost = 0;
    const latency = [];
    const ttft = [];
    const served = [];
    calls.forEach((c, i) => {
      refCost += c.ref.cost;
      const passes = c.ok && c.check && c.check.structureOk && Number(c.check.p) >= t;
      const spentCheck = c.ok && c.check?.structureOk ? checkCost(i) : 0;
      const waitedCheck = c.ok && c.check?.structureOk ? checkMs(i) : 0;
      const first = c.cost || 0;
      if (passes) {
        sum += c.score;
        cost += first + spentCheck;
        latency.push((c.latency || 0) + waitedCheck);
        ttft.push((c.latency || 0) + waitedCheck);
        served.push('first');
      } else {
        escalated += 1;
        // the customer's model's own answer: as far from its other answer as it ever is
        sum += c.ref.noise;
        cost += first + spentCheck + c.ref.cost;
        const before = (c.ok ? c.latency || 0 : c.latency || 0) + waitedCheck;
        latency.push(before + (c.ref.latency || 0));
        ttft.push(before + (c.ref.ttft ?? c.ref.latency ?? 0));
        served.push('fallback');
      }
      n += 1;
    });
    return {
      threshold: t,
      gap: n ? (sum / n) * 100 : 100,
      escalated: n ? escalated / n : 1,
      cost,
      refCost,
      ratio: refCost > 0 ? cost / refCost : null,
      latency,
      ttft,
      served,
    };
  });
}

/**
 * The same for a router: each call goes to the cheap model when its predicted chance of matching
 * is at least the threshold, and to the customer's own otherwise. No check, no second call, and so
 * nothing to catch a cheap answer that failed: a call the router sends to the cheap model gets
 * whatever the cheap model gave it, a broken answer or an error included, and that counts as a miss.
 * calls: { ok, score, cost, latency, ttft, p, ref: {...} }
 */
export function simulateRouter(calls, { thresholds = THRESHOLDS } = {}) {
  return thresholds.map((t) => {
    let sum = 0;
    let cost = 0;
    let refCost = 0;
    let toStrong = 0;
    const latency = [];
    const ttft = [];
    for (const c of calls) {
      refCost += c.ref.cost;
      if (c.p >= t) {
        sum += c.ok ? c.score : 1;
        cost += c.cost || 0;
        latency.push(c.latency || 0);
        ttft.push(c.ttft ?? c.latency ?? 0);
      } else {
        toStrong += 1;
        sum += c.ref.noise;
        cost += c.ref.cost;
        latency.push(c.ref.latency || 0);
        ttft.push(c.ref.ttft ?? c.ref.latency ?? 0);
      }
    }
    const n = calls.length;
    return { threshold: t, gap: n ? (sum / n) * 100 : 100, escalated: n ? toStrong / n : 1, cost, refCost,
      ratio: refCost > 0 ? cost / refCost : null, latency, ttft };
  });
}

/**
 * The reading to keep: the cheapest inside the bar and quick enough; else, when the answers were
 * inside the bar and only the time was not, the cheapest of those, marked slow, so it is called
 * slower rather than missed; else the one closest to the bar, marked near when it is within the
 * review band. Near is the most careful such reading, never the least: it is what gets looked at.
 */
export function bestOf(readings, { floor, reviewBand = 1.25, fast = () => true } = {}) {
  const priced = readings.filter((r) => r.ratio !== null);
  const inside = priced.filter((r) => r.gap <= floor).sort((a, b) => a.ratio - b.ratio || a.gap - b.gap);
  const quick = inside.filter(fast);
  if (quick.length) return { ...quick[0], inside: true };
  if (inside.length) return { ...inside[0], inside: true, slow: true };
  const near = priced.filter((r) => r.gap <= floor * reviewBand && fast(r)).sort((a, b) => a.gap - b.gap || a.ratio - b.ratio);
  if (near.length) return { ...near[0], inside: false, near: true };
  return { ...[...readings].sort((a, b) => a.gap - b.gap)[0], inside: false };
}
