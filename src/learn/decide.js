import { expectedLoss, zDiff } from './bandit.js';

/* The hourly review's decisions, as one pure function, so they can be run ten thousand times over
 * made-up workloads with known truths and asked how often they are wrong (src/eval/harness.js).
 *
 * Every record here is a fair one: calls since learning began, served by chance, whose outcomes
 * could be read and have had time to arrive. Each is a Beta posterior { a, b, nLive, liveRate }.
 *
 * Three things make a rule honest here. First, a switch back or a setting aside is only made when
 * the difference between two records is large against its own uncertainty (a z of 3 for a switch
 * back, 2.5 to set aside): the records are looked at every hour for weeks, and a rule that passed
 * one time in twenty per look would pass almost every week by chance. Second, a promotion is judged
 * by expected loss against the tolerance: what we expect to give up, in calls that work, by serving
 * the runner-up rather than something two points worse than what serves now. That promotes an equal
 * runner-up on about a hundred calls a side and refuses one three points worse at any count, where a
 * z-test would need a thousand calls to promote anything. Third, only some failures are ever seen (a
 * wrong but well-formed answer nobody retries or corrects looks like it worked), so every margin is
 * scaled by the workload's detection rate: with one failure in ten seen, an observed gap of 0.2% is
 * a true gap of 2%, and a runner-up has to be shown as good in observed units that small.
 *
 *   revert   what serves is worse than the customer's model by more than the tolerance, clearly;
 *   promote  a runner-up that cleared its measurement is expected to lose almost nothing against
 *            what serves AND against the customer's model, each allowed the tolerance, on enough
 *            calls each, where outcomes are seen often enough for "worked" to mean anything;
 *   rest     a runner-up is clearly worse than what serves by more than the tolerance.
 * With too little on either side of a comparison nothing happens: the default is never "pass". */

export const DEFAULTS = {
  minCalls: 30,
  tolerance: 0.02,      // two calls in a hundred, in true (not observed) terms
  zRevert: 3,
  zRest: 2.5,
  promoteLoss: 0.005,   // half a call in a hundred, against a yardstick allowed the tolerance
  minDetection: 0.02,   // at least one call in fifty has ever shown a signal, or live results decide nothing
};

// expected to lose almost nothing by serving A rather than B allowed a margin
const goodAs = (A, B, margin, loss) => expectedLoss(A, B, { shift: margin }) < loss;
// shown to be worse than B by more than `margin`
const worse = (A, B, margin, z) => (zDiff(B, A).mu - margin) / zDiff(B, A).sigma >= z;

/**
 * @param {object} st  { serving, base, runners: [{ id, fair, ratio, verdict }], detection, hasEvents }
 * @returns [{ kind: 'revert' | 'promote' | 'rest', armId, loss }]
 */
export function decide(st, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const { serving, base } = st;
  if (!serving || !base) return out;
  const enough = (r) => (r?.fair?.nLive ?? 0) >= o.minCalls;
  // margins in observed units: a failure is only seen `detection` of the time
  const seen = Math.max(o.minDetection, Math.min(1, st.detection ?? 0));
  const margin = o.tolerance * seen;
  const canPromote = (st.detection ?? 0) >= o.minDetection || !!st.hasEvents;

  if (enough(serving) && enough(base) && worse(serving.fair, base.fair, margin, o.zRevert)) {
    return [{ kind: 'revert', armId: serving.id, loss: expectedLoss(serving.fair, base.fair) }];
  }

  const runners = [...(st.runners || [])].filter((r) => r.id !== serving.id).sort((x, y) => (x.ratio ?? 1) - (y.ratio ?? 1));
  for (const r of runners) {
    if (!enough(r)) continue;
    if (worse(r.fair, serving.fair, margin, o.zRest)) { out.push({ kind: 'rest', armId: r.id, loss: expectedLoss(r.fair, serving.fair) }); continue; }
    if (!canPromote || !enough(base) || (r.verdict ?? 'cleared') !== 'cleared') continue;
    if (goodAs(r.fair, serving.fair, margin, o.promoteLoss) && goodAs(r.fair, base.fair, margin, o.promoteLoss)) {
      out.push({ kind: 'promote', armId: r.id, loss: Math.max(expectedLoss(r.fair, serving.fair), expectedLoss(r.fair, base.fair)) });
      break;
    }
  }
  return out;
}
