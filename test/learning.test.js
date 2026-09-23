/* Learning, the arithmetic: records, ranges, comparisons and the split of experiment traffic.
   Nothing here touches a database or a model. */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  rngFrom, sampleBeta, betaCdf, betaQuantile, posterior, probAtLeast, thompsonShares, explorePlan, pickFrom,
} = await import('../src/learn/bandit.js');

const close = (x, y, eps, what) => assert.ok(Math.abs(x - y) <= eps, `${what}: ${x} is not within ${eps} of ${y}`);

test('ranges come from the exact distribution', () => {
  close(betaQuantile(0.5, 1, 1), 0.5, 1e-9, 'the middle of a flat record');
  close(betaQuantile(0.05, 1, 1), 0.05, 1e-9, 'a flat record is spread evenly');
  // Beta(a, 1) has cdf x^a, so its median is 0.5^(1/a)
  close(betaQuantile(0.5, 3, 1), 0.5 ** (1 / 3), 1e-9, 'median of Beta(3, 1)');
  for (const [a, b] of [[2, 5], [40, 3], [0.7, 0.9], [300, 12]]) {
    for (const p of [0.05, 0.5, 0.95]) close(betaCdf(betaQuantile(p, a, b), a, b), p, 1e-7, `Beta(${a}, ${b}) at ${p}`);
  }
});

test('draws from a record average out to its mean', () => {
  const rng = rngFrom(3);
  let sum = 0;
  for (let i = 0; i < 20000; i += 1) sum += sampleBeta(9, 3, rng);
  close(sum / 20000, 0.75, 0.01, 'Beta(9, 3)');
  let small = 0;
  for (let i = 0; i < 20000; i += 1) small += sampleBeta(0.5, 0.5, rng);
  close(small / 20000, 0.5, 0.02, 'Beta(0.5, 0.5)');
});

test('a record: older calls count for less, background answers for less again', () => {
  const prior = { mean: 0.5, strength: 2 };
  const fresh = posterior({ live: [{ ageDays: 0, n: 10, s: 10 }] }, { prior });
  close(fresh.a, 11, 1e-12, 'ten fresh calls that worked');
  close(fresh.b, 1, 1e-12, 'nothing against');
  const old = posterior({ live: [{ ageDays: 14, n: 10, s: 10 }] }, { prior, halfLifeDays: 14 });
  close(old.a, 6, 1e-12, 'a fortnight old, they count half');
  const shadow = posterior({ shadow: [{ ageDays: 0, n: 10, s: 5 }] }, { prior, surrogateWeight: 0.3 });
  close(shadow.a, 2.5, 1e-12, 'background answers at three tenths');
  close(shadow.b, 2.5, 1e-12, 'both ways');
  assert.equal(shadow.nShadow, 10);
  assert.equal(shadow.nLive, 0);
  assert.equal(shadow.shadowRate, 0.5);
  assert.ok(fresh.lo < fresh.mean && fresh.mean < fresh.hi, 'the range holds the mean');
  // no evidence: the workload's own rate, held lightly
  const none = posterior({}, { prior: { mean: 0.95, strength: 4 } });
  close(none.mean, 3.8 / (3.8 + 0.5), 1e-12, 'the prior alone');
  assert.ok(none.hi - none.lo > 0.2, 'and a wide range, because nothing is known yet');
});

test('the chance one strategy works at least about as often as another', () => {
  const good = posterior({ live: [{ ageDays: 0, n: 400, s: 392 }] });
  const worse = posterior({ live: [{ ageDays: 0, n: 400, s: 340 }] });
  assert.ok(probAtLeast(good, worse, 0) > 0.99, 'clearly better');
  assert.ok(probAtLeast(worse, good, 0.02) < 0.01, 'clearly worse, even allowing two points');
  const twin = posterior({ live: [{ ageDays: 0, n: 400, s: 392 }] });
  close(probAtLeast(good, twin, 0), 0.5, 0.04, 'the same record');
  assert.ok(probAtLeast(good, twin, 0.02) > 0.9, 'the same record, allowing two points');
});

test('experiments go mostly to the candidate most likely to be best', () => {
  const shares = thompsonShares([
    { id: 'strong', a: 196, b: 4 },
    { id: 'weak', a: 150, b: 50 },
    { id: 'unknown', a: 3, b: 1 },
  ], { draws: 2000, rng: rngFrom(5) });
  const total = [...shares.values()].reduce((x, y) => x + y, 0);
  close(total, 1, 1e-12, 'the shares add up');
  assert.ok(shares.get('strong') > 0.5, `strong ${shares.get('strong')}`);
  assert.ok(shares.get('weak') < 0.01, `weak ${shares.get('weak')}`);
  /* three calls that worked: it beats a strategy right on 196 of 200 about one draw in seventeen,
     since a draw from its record lands above 0.98 with chance 1 - 0.98^3, so it is still tried */
  close(shares.get('unknown'), 1 - 0.98 ** 3, 0.02, 'something barely known still gets tried');
});

test('careful stays at the share it promises, normal grows on a quiet workload, and "never switch" tries nothing unless asked', async () => {
  const { exploreOf } = await import('../src/learn/explore.js');
  const { default: config } = await import('../src/config.js');
  // careful: never more than its share, whatever the volume, which is what the page says it is
  for (const perDay of [5, 100, 1000, 100000]) {
    assert.equal(exploreOf({ explore_mode: 'careful' }, { perDay }).share, config.EXPLORE_SHARE_CAREFUL, `careful at ${perDay} calls a day`);
  }
  // normal: grows until the customer's own model answers EXPLORE_YARDSTICK_PER_DAY a day, never past EXPLORE_SHARE_MAX
  assert.equal(exploreOf({ explore_mode: 'normal' }, { perDay: 100000 }).share, config.EXPLORE_SHARE_NORMAL, 'a busy workload keeps the base share');
  assert.equal(exploreOf({ explore_mode: 'normal' }, { perDay: 10 }).share, config.EXPLORE_SHARE_MAX, 'a very quiet one stops at the most there is');
  const mid = (2 * config.EXPLORE_YARDSTICK_PER_DAY) / 0.07;
  close(exploreOf({ explore_mode: 'normal' }, { perDay: mid }).share, 0.07, 1e-12, 'grown to what the yardstick needs');
  // what each way of switching implies where nobody chose
  assert.equal(exploreOf({ optimize_mode: 'auto' }).mode, 'careful');
  assert.equal(exploreOf({ optimize_mode: 'ask' }).mode, 'shadow');
  const never = exploreOf({ optimize_mode: 'off' }, { perDay: 100 });
  assert.deepEqual([never.mode, never.live, never.share], ['off', false, 0], 'a workload that never switches tries nothing by itself');
  // a person can still choose experiments for one
  assert.equal(exploreOf({ optimize_mode: 'off', explore_mode: 'careful' }).mode, 'careful');
});

test('the split of one call: the yardstick, the candidates, and what serves', () => {
  const serving = { id: 's', post: { a: 90, b: 10 } };
  const baseline = { id: 'b', post: { a: 95, b: 5 } };
  const cand = { id: 'c', post: { a: 9, b: 1 } };
  const plan = explorePlan({ share: 0.04, serving, candidates: [cand], baseline });
  const p = Object.fromEntries(plan.map((x) => [x.arm.id, x.p]));
  close(p.s, 0.96, 1e-12, 'what serves keeps the rest');
  close(p.b, 0.02, 1e-12, 'half the experiments are the yardstick');
  close(p.c, 0.02, 1e-12, 'half go to the one candidate');
  // no candidates: only the yardstick half is used
  const lone = explorePlan({ share: 0.04, serving, candidates: [], baseline });
  close(lone.find((x) => x.arm.id === 's').p, 0.98, 1e-12, 'nothing else to try');
  // the draw follows the chances
  assert.equal(pickFrom(plan, 0.5).arm.id, 's');
  assert.equal(pickFrom(plan, 0.97).arm.id, 'b');
  assert.equal(pickFrom(plan, 0.99).arm.id, 'c');
  // nothing at all to compare with: always what serves
  const alone = explorePlan({ share: 0.04, serving, candidates: [], baseline: null });
  assert.deepEqual(alone.map((x) => [x.arm.id, x.p]), [['s', 1]]);
});
