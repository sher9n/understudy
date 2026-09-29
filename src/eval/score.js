/* Which model is best for a workload: every setup a test tries is given a score out of 100 for quality, cost and
 * speed, and one overall score, and the best overall score is picked rather than the cheapest. What the workload
 * optimizes for sets how much each part counts. Pure, so every figure on a test's page can be worked out by hand.
 *
 *   quality  100 when none of its answers differed from the original model's (or, judged "at least as good", none was
 *            clearly worse); it falls as more do, to 50 at the most the test allows and 0 at twice that
 *   cost     how much less it costs than the original model on the same requests: 92 is 92% less, and one that costs
 *            as much or more scores 0
 *   speed    how much sooner its typical answer arrives than the original model's: 54 is 54% sooner, and one that is
 *            slower scores 0 (the test's speed rule is what keeps a much slower one out altogether)
 *
 * The overall score is the three parts weighted by what the workload optimizes for. Each part is rounded once and the
 * score is built from the rounded parts, so the parts on a page always add up to it; the order is read on the exact
 * figure, so two that both show 93 still come in their right order. Cost and speed are never rounded up to 100 while
 * there is any cost or any wait: 99.6% less is "99% less" on every other screen. Speed is left out, for every setup
 * alike, only where the original model was not timed, and quality and cost then share its weight; a setup that was not
 * timed itself, where the original model was, has no speed to its credit and scores 0 for it, since left out it scored
 * on quality and cost alone and beat every timed setup where speed counts most. A setup whose quality or cost is not
 * known has no score.
 *
 * Only a setup that passed its test can be picked. Optimizing for quality also asks that a setup be at least
 * CAUTIOUS_MIN_CHANCE sure to keep the allowed difference, and holds its second look to a stricter bound (run.js): what
 * a workload set to Cautious had before. And what serves a workload now is only replaced by a setup that scores clearly
 * better, by SCORE_SWITCH_MARGIN points: one a point or two ahead on one test would switch a workload back and forth for
 * nothing. */

/** How much each part counts, in percent, for each thing a workload can optimize for. */
export const PRESETS = {
  balance: { quality: 40, cost: 30, speed: 30 },
  quality: { quality: 70, cost: 15, speed: 15 },
  cost: { quality: 25, cost: 60, speed: 15 },
  speed: { quality: 25, cost: 15, speed: 60 },
};
export const OPTIMIZE_FOR = Object.keys(PRESETS);

/* What a workload set before there were scores reads as: the routing priorities balanced, cautious and savings. */
const LEGACY = { balanced: 'balance', cautious: 'quality', savings: 'cost' };

/** One stored or asked-for value as what it optimizes for: one of OPTIMIZE_FOR, or null for anything else. */
export function optimizeValue(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (OPTIMIZE_FOR.includes(s)) return s;
  return LEGACY[s] ?? null;
}

/** What a workload optimizes for: its own choice, else its workspace's, else the deployment's, else balance. */
export function optimizeFor(workload, workspace = null, fallback = 'balance') {
  return optimizeValue(workload?.routing_mode) || optimizeValue(workspace?.default_routing_mode)
    || optimizeValue(fallback) || 'balance';
}

const clamp = (x) => Math.max(0, Math.min(100, x));
const finite = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));

/**
 * A setup's three parts, each a whole number from 0 to 100, or null where it cannot be known.
 * gapPct: how often it differed (or was clearly worse), in percent; floorPct: the most the test allowed, in percent;
 * costRatio: what it cost against the original model on the same requests; p50 and refP50: its typical time and the
 * original model's, measured the same way.
 */
export function partsOf({ gapPct, floorPct, costRatio, p50, refP50 }) {
  const quality = finite(gapPct) && finite(floorPct) && Number(floorPct) > 0
    ? Math.round(clamp(100 * (1 - Number(gapPct) / (2 * Number(floorPct))))) : null;
  const cost = finite(costRatio) && Number(costRatio) >= 0
    ? Math.min(Number(costRatio) > 0 ? 99 : 100, Math.round(clamp(100 * (1 - Number(costRatio))))) : null;
  const timedRef = finite(refP50) && Number(refP50) > 0;
  const speed = !timedRef ? null
    : finite(p50) && Number(p50) > 0 ? Math.min(99, Math.round(clamp(100 * (1 - Number(p50) / Number(refP50))))) : 0;
  return { quality, cost, speed };
}

/**
 * The overall score of a setup's parts under what the workload optimizes for: { exact, score, weights }, where `exact`
 * orders setups and `score` is what a page shows; null where quality or cost is not known.
 */
export function scoreOf(parts, optimize = 'balance') {
  const w = PRESETS[optimizeValue(optimize) || 'balance'];
  if (!parts || parts.quality === null || parts.quality === undefined || parts.cost === null || parts.cost === undefined) return null;
  const known = ['quality', 'cost', 'speed'].filter((k) => parts[k] !== null && parts[k] !== undefined);
  const total = known.reduce((s, k) => s + w[k], 0);
  const exact = known.reduce((s, k) => s + w[k] * parts[k], 0) / total;
  return { exact, score: Math.round(exact), weights: w };
}

/** The typical time a setup is scored on: to the first word where the workload is timed that way, else the whole answer. */
export function p50Of(row, metric = 'latency') {
  const v = metric === 'ttft' ? (row?.ttft_p50 ?? row?.latency_p50) : row?.latency_p50;
  return finite(v) && Number(v) > 0 ? Number(v) : null;
}

/**
 * What a test found about one setup, kept with it (arms.offline_json) for live experiments to score it by the same
 * rule (worthTrying in src/learn/explore.js): its figures, the allowed difference and the original model's time they
 * are read against, how that time was taken, and how sure the test was that it keeps the allowed difference. Written
 * the same way at the end of a test and by a switch, which used to keep only some of it, so what served could not be
 * scored and was compared with nothing. `ratio`, where given, is its cost against the original model's worked out by
 * the caller.
 */
export function offlineOf(row, { floor = null, metric = 'latency', refP50 = null, runId = null, ratio, at = null } = {}) {
  return {
    verdict: row?.verdict ?? null, gap: finite(row?.gap_pct) ? Number(row.gap_pct) : null,
    floor: finite(floor) ? Number(floor) : null,
    ratio: ratio !== undefined ? ratio : (finite(row?.cost_ratio) ? Number(row.cost_ratio) : null),
    escalatedPct: row?.escalated_pct ?? null, runs: row?.runs ?? null, runId, at,
    p50: p50Of(row, metric), refP50: finite(refP50) && Number(refP50) > 0 ? Number(refP50) : null, metric,
    chance: finite(row?.chance) ? Number(row.chance) : null,
  };
}

/** One eval_results row's parts and score: { parts, score } with score null where it has none. */
export function rowScore(row, { floorPct, refP50, metric = 'latency', optimize = 'balance' }) {
  const parts = partsOf({ gapPct: row?.gap_pct, floorPct, costRatio: row?.cost_ratio, p50: p50Of(row, metric), refP50 });
  return { parts, score: scoreOf(parts, optimize) };
}

/* Best first: the higher exact score, then the better quality, then the cheaper, then the faster, then by name, so the
   order never depends on the order they arrive in. One with no score comes after every one with one. */
function byScore(a, b) {
  const ea = a.s.score ? a.s.score.exact : -Infinity;
  const eb = b.s.score ? b.s.score.exact : -Infinity;
  if (ea !== eb) return eb - ea;
  const d = (k) => (b.s.parts[k] ?? -1) - (a.s.parts[k] ?? -1);
  return d('quality') || d('cost') || d('speed') || String(a.r.model_id).localeCompare(String(b.r.model_id));
}

/**
 * The setups that passed, in the order they are looked at again and switched to: best score first.
 * rows: eval_results rows (gap_pct, cost_ratio, latency_p50, ttft_p50, chance). Answers { order, left, scores }:
 * `left` are the ones a workload optimizing for quality would not switch to, with why; `scores` maps each row to
 * its { parts, score }.
 */
export function rankByScore(rows, { optimize = 'balance', floorPct, refP50 = null, metric = 'latency', cautiousChance = 0.99 } = {}) {
  const mode = optimizeValue(optimize) || 'balance';
  const scores = new Map();
  const items = [...(rows || [])].map((r) => {
    const s = rowScore(r, { floorPct, refP50, metric, optimize: mode });
    scores.set(r, s);
    return { r, s };
  });
  const left = [];
  let pool = items;
  if (mode === 'quality') {
    pool = items.filter((x) => finite(x.r.chance) && Number(x.r.chance) >= cautiousChance);
    for (const x of items) {
      if (!pool.includes(x)) left.push({ row: x.r, why: 'not sure enough for a workload optimized for quality' });
    }
  }
  return { order: [...pool].sort(byScore).map((x) => x.r), left, scores };
}

/**
 * Whether a challenger may take the place of what serves now: only when it scores clearly better, by `margin` points.
 * With either score unknown, the older rule decides: only something cheaper.
 */
export function beatsServing(challenger, serving, { margin = 3, cheaper = null } = {}) {
  // a row's { parts, score } (rowScore) or a bare score (scoreOf): the exact figure either way
  const exact = (x) => (x?.score && typeof x.score === 'object' ? x.score.exact : typeof x?.exact === 'number' ? x.exact : null);
  const a = exact(challenger);
  const b = exact(serving);
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b + margin;
  return cheaper === null ? false : !!cheaper;
}
