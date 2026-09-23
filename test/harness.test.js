/* How often are we wrong? These are the numbers that must stay true, from the same simulations
   `node scripts/harness.mjs` prints. Pure: no database, no model. */

import test from 'node:test';
import assert from 'node:assert/strict';

const { verdictWith, wilson, callsToClear } = await import('../src/eval/compare.js');
const { verdictSim, learnRates } = await import('../src/eval/harness.js');
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
