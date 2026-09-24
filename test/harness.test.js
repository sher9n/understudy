/* How often are we wrong? These are the numbers that must stay true, from the same simulations
   `node scripts/harness.mjs` prints. Pure: no database, no model. */

import test from 'node:test';
import assert from 'node:assert/strict';

const { verdictWith, wilson, callsToClear } = await import('../src/eval/compare.js');
const { verdictSim, learnRates, choiceSim, routerSim, REQUEST_KINDS } = await import('../src/eval/harness.js');
const { decide, zSeq, diffRange } = await import('../src/learn/decide.js');
const { posterior, expectedLoss, zDiff } = await import('../src/learn/bandit.js');
const { crossFit, simulateCascade, bestOf } = await import('../src/learn/simulate.js');

test('a verdict says how sure it is, and says "not enough" rather than clearing on a few calls', () => {
  assert.equal(verdictWith([], 3.75).verdict, 'insufficient');
  assert.equal(verdictWith(Array(10).fill(0), 3.75).verdict, 'insufficient', 'ten perfect calls cannot show a 3.75% bar');
  assert.equal(verdictWith(Array(10).fill(0), 3.75).need, callsToClear(3.75));
  assert.ok(callsToClear(3.75) >= 65 && callsToClear(3.75) <= 75, `${callsToClear(3.75)}`);
  assert.equal(verdictWith(Array(80).fill(0), 3.75).verdict, 'cleared');
  const one = verdictWith([1, ...Array(99).fill(0)], 3.75);
  assert.equal(one.verdict, 'review', 'one wrong in a hundred: the range straddles a 3.75% bar');
  assert.ok(one.hi > 3.75 && one.lo < 1);
  assert.equal(verdictWith([...Array(5).fill(1), ...Array(95).fill(0)], 3.75).verdict, 'review', 'five in a hundred could still be under 4.7%');
  assert.equal(verdictWith([...Array(15).fill(1), ...Array(85).fill(0)], 3.75).verdict, 'missed');
  // a candidate that differs slightly on a few calls is judged on how often and by how much, not as if
  // each of those calls were a wholly different answer
  const slight = verdictWith([...Array(5).fill(0.17), ...Array(95).fill(0)], 3);
  assert.equal(slight.verdict, 'cleared', `five slightly different answers in a hundred: ${slight.hi.toFixed(2)}% at most`);
  assert.ok(slight.hi < wilson(0.05, 100).hi * 100, 'and the bound is below the count alone');
  // every one of them differing outright is another matter
  assert.equal(verdictWith([...Array(12).fill(1), ...Array(88).fill(0)], 3).verdict, 'missed');
});

test('a candidate exactly at the bar clears about one time in twenty, never one in two', () => {
  const at = verdictSim({ gap: 0.0375, n: 100, floorPct: 3.75, trials: 3000 });
  assert.ok(at.withIntervals.cleared <= 0.07, `false clears ${at.withIntervals.cleared}`);
  assert.ok(at.pointEstimate.cleared > 0.4, 'the old rule cleared it about half the time');
  const twice = verdictSim({ gap: 0.075, n: 100, floorPct: 3.75, trials: 3000 });
  assert.ok(twice.withIntervals.cleared <= 0.005, `a candidate twice the bar: ${twice.withIntervals.cleared}`);
  const clean = verdictSim({ gap: 0, n: 80, floorPct: 3.75, trials: 1000 });
  assert.equal(clean.withIntervals.cleared, 1, 'a perfect candidate on enough calls clears');
});

test('the decision rule: nothing on too little, nothing by default, and the customer\'s model is always the yardstick', () => {
  const rec = (n, s, prior = { mean: 0.97, strength: 4 }) => posterior({ live: [{ ageDays: 0, n, s }] }, { prior, quantiles: false });
  const serving = { id: 's', fair: rec(3000, 2910) };
  const base = { id: 'b', fair: rec(20, 20) };
  assert.deepEqual(decide({ serving, base, runners: [], detection: 1 }), [], 'the yardstick has under 30 calls');
  // a runner-up shown as good as what serves, but the yardstick still thin: no promotion
  const runner = { id: 'r', fair: rec(3000, 2940), ratio: 0.5, verdict: 'cleared' };
  assert.deepEqual(decide({ serving, base, runners: [runner], detection: 1 }), []);
  // a few hundred calls a side cannot show a runner-up within two points, looked at every hour
  assert.deepEqual(decide({ serving: { id: 's', fair: rec(300, 291) }, base: { id: 'b', fair: rec(120, 116) },
    runners: [{ ...runner, fair: rec(400, 392) }], detection: 1 }), [], 'the rule before this promoted here');
  // enough on every side: promoted
  const d = decide({ serving, base: { id: 'b', fair: rec(2000, 1940) }, runners: [runner], detection: 1 });
  assert.equal(d[0]?.kind, 'promote');
  assert.equal(d[0]?.by, 'seen');
  // the same runner-up with nothing ever seen on this workload: live results decide nothing
  assert.deepEqual(decide({ serving, base: { id: 'b', fair: rec(2000, 1940) }, runners: [runner], detection: 0 }), []);
  // one that only came close in its measurement is never promoted on live results
  assert.deepEqual(decide({ serving, base: { id: 'b', fair: rec(2000, 1940) }, runners: [{ ...runner, verdict: 'review' }], detection: 1 }), []);
  // what serves clearly worse than the customer's model: switched back
  const bad = { id: 's', fair: rec(600, 540) };
  const r = decide({ serving: bad, base: { id: 'b', fair: rec(300, 292) }, runners: [runner], detection: 1 });
  assert.equal(r[0]?.kind, 'revert');
  // a runner-up clearly worse than what serves is set aside
  const worse = { id: 'w', fair: rec(600, 530), ratio: 0.4, verdict: 'cleared' };
  assert.equal(decide({ serving: { id: 's', fair: rec(900, 873) }, base: { id: 'b', fair: rec(2000, 1940) }, runners: [worse], detection: 1 })[0]?.kind, 'rest');
  // graded calls decide where nothing is ever seen: a runner-up the grader finds as good, on enough of them
  const g = (n, bad) => ({ n, bad });
  const quiet = (id, n, extra = {}) => ({ id, fair: rec(n, n), ...extra });
  const byGrade = decide({ serving: quiet('s', 3000, { graded: g(1500, 30) }), base: quiet('b', 2000, { graded: g(1500, 30) }),
    runners: [quiet('r', 3000, { graded: g(1500, 25), ratio: 0.5, verdict: 'cleared' })], detection: 0 });
  assert.equal(byGrade[0]?.kind, 'promote');
  assert.equal(byGrade[0]?.by, 'graded');
  // and what serves, graded clearly worse than the customer's own model, goes back
  const gradedBad = decide({ serving: quiet('s', 3000, { graded: g(600, 60) }), base: quiet('b', 2000, { graded: g(600, 12) }), runners: [], detection: 0 });
  assert.equal(gradedBad[0]?.kind, 'revert');
  assert.equal(gradedBad[0]?.by, 'graded');
});

test('the ranges hold at every look: about three standard errors, growing slowly', () => {
  assert.ok(zSeq(300) > 2.9 && zSeq(300) < 3.4, `${zSeq(300)}`);
  assert.ok(zSeq(30000) > zSeq(300), 'looked at longer, the range is a little wider in standard errors');
  assert.ok(zSeq(30000) < 4, `${zSeq(30000)}`);
  const r = diffRange({ a: 970, b: 30 }, { a: 940, b: 60 });
  assert.ok(r.d < 0 && r.lo < r.d && r.hi > r.d);
});

test('over a month of hourly looks, equal strategies are almost never switched, and a bad one is caught', () => {
  const equal = learnRates({ volume: 1000, share: 0.05, rates: { base: 0.97, serving: 0.97, runner: null } }, { trials: 60 });
  assert.ok(equal.revert <= 0.05, `false switch-backs ${equal.revert}`);
  const bad = learnRates({ volume: 1000, share: 0.05, rates: { base: 0.97, serving: 0.92, runner: null } }, { trials: 60 });
  assert.ok(bad.revert >= 0.7, `a strategy five points worse is switched back ${bad.revert}`);
  const worseRunner = learnRates({ volume: 1000, share: 0.05, rates: { base: 0.97, serving: 0.97, runner: 0.94 } }, { trials: 60 });
  assert.ok(worseRunner.promote <= 0.03, `a runner-up three points worse is promoted ${worseRunner.promote}`);
  // and one as good is promoted, where there are calls enough to show it
  const busy = learnRates({ volume: 5000, share: 0.05, rates: { base: 0.97, serving: 0.97, runner: 0.97 } }, { trials: 40 });
  assert.ok(busy.promote >= 0.6, `an equal runner-up on a busy workload is promoted ${busy.promote}`);
  // failures seen one time in ten: a runner-up five points worse looks nearly equal, and is never promoted
  const blind = learnRates({ volume: 1000, share: 0.05, rates: { base: 0.97, serving: 0.97, runner: 0.92 }, detection: 0.1 }, { trials: 40 });
  assert.equal(blind.promote, 0, `promoted on silence ${blind.promote}`);
});

test('expected loss and z agree with what the records say', () => {
  const A = { a: 97, b: 3 };
  const B = { a: 92, b: 8 };
  assert.ok(expectedLoss(A, B) < 0.002, 'A is better: little to lose by serving it');
  assert.ok(expectedLoss(B, A) > 0.04, 'B is worse: about five points to lose');
  assert.ok(zDiff(A, B).z > 1.5 && zDiff(A, B).z < 2.5);
  assert.ok(Math.abs(expectedLoss(A, B) - expectedLoss(A, B, { draws: 30000 })) < 0.002, 'closed form matches draws');
});

test('cross-fitting reports a held-out gap, not the one the threshold was tuned on', () => {
  const ref = { cost: 0.002, latency: 1000, ttft: 800, noise: 0 };
  // Jev reads the wrong answers as doubtful only some of the time: a threshold tuned in-sample looks better than it is
  const calls = Array.from({ length: 40 }, (_, i) => {
    const wrong = i % 8 === 3;
    const p = wrong ? (i % 16 === 3 ? 0.2 : 0.75) : 0.9;
    return { ok: true, score: wrong ? 1 : 0, cost: 0.0002, latency: 400, ttft: 300, check: { structureOk: true, p }, ref, liveCost: 0.00001, ms: 100 };
  });
  const readingsOf = (cs) => simulateCascade(cs, { checkCost: (c) => c.liveCost, checkMs: (c) => c.ms });
  const cf = crossFit(calls, readingsOf, (rs) => bestOf(rs, { floor: 3, reviewBand: 1.25 }));
  assert.equal(cf.heldOut.scores.length, 40, 'every call scored once, by a threshold chosen without it');
  assert.ok(cf.heldOut.gap >= cf.inSample.gap - 1e-9, `held-out ${cf.heldOut.gap} is never rosier than in-sample ${cf.inSample.gap}`);
  assert.ok([0.5, 0.6, 0.7, 0.8, 0.9].includes(cf.threshold));
});

/* Which setup is switched to (src/eval/confidence.js), and the second look that stands behind it. The
   numbers the How models are routed page quotes come from these, with more workloads. */
const between = (rng, a, b) => a + (b - a) * rng();

test('of two setups that save about the same, balanced switches to the faster, for under a point of saving', () => {
  const setups = () => [
    { id: 'slow', rate: 0.001, ratio: 0.2, p50: 1.8 }, { id: 'fast', rate: 0.001, ratio: 0.206, p50: 0.5 },
    { id: 'bad', rate: 0.06, ratio: 0.05, p50: 0.6 }, { id: 'dear', rate: 0.005, ratio: 0.4, p50: 0.9 },
  ];
  const old = choiceSim({ setups, mode: 'savings', tries: 2, trials: 1500, seed: 11, best: () => 'fast' });
  const bal = choiceSim({ setups, mode: 'balanced', tries: 3, trials: 1500, seed: 11, best: () => 'fast' });
  assert.ok(bal.right >= 0.75, `balanced picked the faster ${bal.right}`);
  assert.ok(old.right <= 0.2, `cheapest first picked it ${old.right}`);
  assert.ok(old.saving - bal.saving < 0.01, `and gave up ${((old.saving - bal.saving) * 100).toFixed(2)} points of saving`);
  assert.ok(bal.speed < old.speed / 2, `for answers ${old.speed / bal.speed}x as fast`);
});

test('the second look stops the setup that passed by luck, in every routing priority', () => {
  // ten setups each a quarter past the pass mark, and one that is well inside it but dearer
  const setups = (rng) => [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `edge${i}`, rate: 0.0375, ratio: between(rng, 0.03, 0.15), p50: 1 })),
    { id: 'good', rate: 0.002, ratio: 0.3, p50: 1 },
  ];
  const once = choiceSim({ setups, mode: 'savings', secondLook: false, trials: 1500, seed: 11 });
  assert.ok(once.broken >= 0.05, `tested once, a lucky one was switched to ${once.broken}`);
  for (const mode of ['savings', 'balanced', 'cautious']) {
    const r = choiceSim({ setups, mode, tries: 3, trials: 1500, seed: 11 });
    assert.ok(r.broken <= 0.002, `${mode}: switched past the mark ${r.broken}`);
  }
});

test('cautious switches less often than balanced, and never to more that break the promise', () => {
  const setups = (rng) => Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, rate: between(rng, 0, 0.06), ratio: between(rng, 0.03, 0.6), p50: between(rng, 0.3, 2) }));
  const bal = choiceSim({ setups, mode: 'balanced', trials: 1500, seed: 11 });
  const cau = choiceSim({ setups, mode: 'cautious', trials: 1500, seed: 11 });
  assert.ok(cau.switched < bal.switched, `cautious ${cau.switched} against balanced ${bal.switched}`);
  assert.ok(cau.broken <= bal.broken, `and breaks the promise no more often: ${cau.broken} against ${bal.broken}`);
});

/* Routing by kind of request (src/learn/kinds.js): learned, cross-fitted, looked at twice, and judged on the
   truth. A router whose kinds matter is found; one that would only hide a worse model's mistakes is not. */
test('a router by kind of request is found where the kinds matter, and saves most of the cost without breaking the promise', () => {
  const K = REQUEST_KINDS;
  const r = routerSim({ kinds: [{ make: K.order, share: 0.6 }, { make: K.refund, share: 0.4 }],
    options: [{ ratio: 0.05, rates: [0, 0.35] }, { ratio: 0.3, rates: [0, 0] }], trials: 16, seed: 31 });
  assert.ok(r.withCheck.switched >= 0.7, `switched to ${r.withCheck.switched}`);
  assert.equal(r.withCheck.broken, 0);
  assert.ok(r.withCheck.saving > 0.75, `saving ${r.withCheck.saving}`);
  assert.ok(r.kindsZ > 3, `its kinds mattered by ${r.kindsZ} spreads`);
});

test('a router whose kinds mean nothing is never switched to, and requests that all read alike make no router', () => {
  const K = REQUEST_KINDS;
  // a cheap model a little worse than the mark on every kind alike: routing would only dilute its mistakes
  const spurious = routerSim({ floorPct: 5, refNoise: 0.03, kinds: [{ make: K.order, share: 0.5 }, { make: K.refund, share: 0.5 }],
    options: [{ ratio: 0.05, rates: [0.07, 0.07] }], trials: 16, seed: 31 });
  assert.equal(spurious.withCheck.broken, 0, 'no router past the mark');
  assert.equal(spurious.withCheck.diluted, 0, 'and none that hides a worse model among good answers');
  const alike = routerSim({ kinds: [{ make: K.document, share: 1 }], options: [{ ratio: 0.05, rates: [0.02] }], trials: 8, seed: 31 });
  assert.equal(alike.formed, 0, 'every request is "document #N": one kind, so no router');
});
