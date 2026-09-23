/* The hourly review's decisions, as one pure function, so they can be run ten thousand times over
 * made-up workloads with known truths and asked how often they are wrong (src/eval/harness.js).
 *
 * Every record here is a fair one: calls since learning began, served by chance, whose outcomes could
 * be read and have had time to arrive. Each is a Beta record { a, b, nLive, liveRate } of how often
 * calls worked, and a record may also carry `graded`: calls read by a grader in the background, with
 * how many it found wrong (see src/learn/grade.js).
 *
 * The records are looked at every hour for as long as a workload runs, so every comparison here is a
 * confidence sequence: a range for the true difference that holds at every look at once, not only at
 * one look chosen in advance. A rule that passed one time in twenty per look, looked at hourly for a
 * month, passes by chance almost every month. The rule before this one decided a promotion by expected
 * loss, which has no such guarantee: over a month of hourly looks it promoted a runner-up three points
 * worse than what served in two months out of three, usually on a lucky first thirty calls.
 *
 * Only some failures are ever seen: a wrong but well-formed answer nobody retries or corrects looks
 * like it worked. So differences in what was seen are held to margins scaled by how often failures
 * are seen (`detection`): with one failure in ten seen, a true gap of two points shows as a fifth of
 * a point, and a runner-up has to be shown that close. With none ever seen, what was seen decides
 * nothing, and only graded calls can.
 *
 *   revert   what serves works less often than the customer's model by more than half the tolerance,
 *            clearly: in what was seen, or in what the grader found;
 *   promote  a runner-up that cleared its measurement is shown to work no worse than what serves AND
 *            than the customer's model, each within the tolerance, on enough calls each, with nothing
 *            in the other kind of evidence saying it is worse;
 *   rest     a runner-up is clearly worse than what serves by more than the tolerance, so it can never
 *            be promoted, and its share of the experiments is better spent elsewhere.
 * With too little on either side of a comparison nothing happens: the default is never "pass". */

export const DEFAULTS = {
  minCalls: 30,
  tolerance: 0.02,      // two calls in a hundred, in true (not observed) terms
  alpha: 0.05,          // the chance any one decision is wrong, over every look it will ever get
  rho: 20,              // calls: where the ranges are tightest (small, so a large difference is caught early)
  minDetection: 0.02,   // at least one call in fifty has ever shown a signal, or what was seen decides nothing
  minGraded: 30,        // graded calls a side before grades decide anything
};

/* The failure rate a record says, and how uncertain it is. A record with no failure yet is read as
   having half of one, so it is still uncertain rather than exact; a record's own prior already holds
   at least that much (see posterior in bandit.js), so it is not added twice. */
function failOf(rec) {
  const n = rec.a + rec.b;
  const q = rec.b / n;
  const qv = Math.max(rec.b, 0.5) / n;
  return { q, v: (qv * (1 - qv)) / n, n };
}

/* The normal-mixture confidence sequence (Robbins): at `n` calls, how many standard errors wide a
   range must be to hold at every look with chance 1 - alpha. About 3 at a few hundred calls, growing
   slowly after, which is what being looked at every hour costs. */
export function zSeq(n, { alpha = DEFAULTS.alpha, rho = DEFAULTS.rho } = {}) {
  const m = Math.max(1, n);
  return Math.sqrt(((m + rho) / m) * (Math.log((m + rho) / rho) + 2 * Math.log(1 / alpha)));
}

/** The range for (failure rate of A) - (failure rate of B) that holds at every look. */
export function diffRange(A, B, opts = {}) {
  const x = failOf(A);
  const y = failOf(B);
  const d = x.q - y.q;
  const r = Math.sqrt(x.v + y.v) * zSeq(Math.min(x.n, y.n), opts);
  return { d, lo: d - r, hi: d + r, n: Math.min(x.n, y.n) };
}

/* The same range for graded calls: `graded` is { n, bad }, a plain count, each read by the same
   grader whichever strategy answered, so a difference between two strategies is theirs. */
function gradedRec(g) {
  if (!g || !(g.n > 0)) return null;
  // held lightly at the grader's own average, as a live record is held at the workload's
  return { a: g.n - g.bad + 0.5, b: g.bad + 0.5 };
}

/**
 * @param {object} st  { serving, base, runners: [{ id, fair, graded?, ratio, verdict }], detection, hasEvents }
 *                     serving and base are { id, fair, graded? }
 * @returns [{ kind: 'revert' | 'promote' | 'rest', armId, by, range }]
 */
export function decide(st, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const { serving, base } = st;
  if (!serving || !base) return out;
  // two kinds of evidence share the chance of being wrong, so together they are wrong no more often than one
  const seqOpts = { alpha: o.alpha / 2, rho: o.rho };
  /* Enough evidence is counted in tasks where a record says how many it holds: the steps of one
     conversation were given to one strategy together, and one forty step task is not forty calls'
     worth of evidence (see src/learn/fair.js). A record that only counts calls is read as it was. */
  const enough = (r) => (r?.fair?.tasks ?? r?.fair?.nLive ?? 0) >= o.minCalls;
  const graded = (r) => (r?.graded?.n ?? 0) >= o.minGraded;
  // what was seen counts where failures are seen often enough, or the customer reports outcomes themselves
  const seen = st.hasEvents ? 1 : Math.max(0, Math.min(1, st.detection ?? 0));
  const useSeen = st.hasEvents || seen >= o.minDetection;
  const margin = o.tolerance * Math.max(seen, o.minDetection);
  const seenRange = (A, B) => (useSeen && enough(A) && enough(B) ? diffRange(A.fair, B.fair, seqOpts) : null);
  const gradedRange = (A, B) => (graded(A) && graded(B) ? diffRange(gradedRec(A.graded), gradedRec(B.graded), seqOpts) : null);

  // what serves, against the customer's own model
  {
    const s = seenRange(serving, base);
    const g = gradedRange(serving, base);
    const bySeen = s && s.lo > margin / 2;
    const byGrade = g && g.lo > o.tolerance / 2;
    if (bySeen || byGrade) {
      return [{ kind: 'revert', armId: serving.id, by: bySeen ? 'seen' : 'graded', range: bySeen ? s : g }];
    }
  }

  const runners = [...(st.runners || [])].filter((r) => r.id !== serving.id).sort((x, y) => (x.ratio ?? 1) - (y.ratio ?? 1));
  for (const r of runners) {
    const sv = seenRange(r, serving);
    const gv = gradedRange(r, serving);
    // clearly worse than what serves by more than the tolerance: it can never be promoted
    if ((sv && sv.lo > margin) || (gv && gv.lo > o.tolerance)) {
      out.push({ kind: 'rest', armId: r.id, by: sv && sv.lo > margin ? 'seen' : 'graded', range: sv && sv.lo > margin ? sv : gv });
      continue;
    }
    if ((r.verdict ?? 'cleared') !== 'cleared') continue;
    const sb = seenRange(r, base);
    const gb = gradedRange(r, base);
    // shown no worse than both, within the tolerance, by one kind of evidence ...
    const okSeen = sv && sb && sv.hi < margin && sb.hi < margin;
    const okGrade = gv && gb && gv.hi < o.tolerance && gb.hi < o.tolerance;
    // ... and not shown worse than either by the other
    const worseSeen = (sv && sv.lo > 0) || (sb && sb.lo > 0);
    const worseGrade = (gv && gv.lo > 0) || (gb && gb.lo > 0);
    if ((okSeen && !worseGrade) || (okGrade && !worseSeen)) {
      out.push({ kind: 'promote', armId: r.id, by: okSeen ? 'seen' : 'graded', range: okSeen ? sb : gb });
      break;
    }
  }
  return out;
}
