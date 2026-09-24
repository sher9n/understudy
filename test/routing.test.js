import test from 'node:test';
import assert from 'node:assert/strict';
import { betaCdf, chanceWithin, safeSaving, rankCleared, routingModeOf } from '../src/eval/confidence.js';
import { askedText, featuresRaw, idfOf, weigh, chooseKinds, learnRouter, routeOf, simulateRoutes, crossFitRouter, familiarLine } from '../src/learn/kinds.js';

/* Performance first: how sure a measurement is that a setup keeps the promise, which of the setups
   that cleared is switched to, and the router that sends each kind of request to the setup that does
   it well enough. Every function here is pure, so the numbers are checked against ones worked out by
   hand. */

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('the beta distribution is exact where it can be worked out by hand', () => {
  close(betaCdf(0.3, 1, 1), 0.3);
  close(betaCdf(0.5, 2, 2), 0.5);
  close(betaCdf(0.25, 2, 2), 0.15625);
  // the arcsine distribution: (2/pi) asin(sqrt(x))
  close(betaCdf(0.25, 0.5, 0.5), 1 / 3);
  close(betaCdf(0.1, 1, 10), 1 - 0.9 ** 10);
  // either side of it adds up to one
  close(betaCdf(0.07, 3.5, 90.5) + betaCdf(0.93, 90.5, 3.5), 1);
  assert.equal(betaCdf(0, 2, 3), 0);
  assert.equal(betaCdf(1, 2, 3), 1);
});

test('how sure we are a setup is inside the pass mark falls as its worse answers rise', () => {
  const clean = chanceWithin(new Array(120).fill(0), 5);
  assert.ok(clean > 0.99, `no worse answer in 120 at a 5% mark: ${clean}`);
  const two = chanceWithin([...new Array(118).fill(0), 1, 1], 5);
  const six = chanceWithin([...new Array(94).fill(0), ...new Array(6).fill(1)], 5);
  assert.ok(clean > two && two > six, `${clean} > ${two} > ${six}`);
  assert.ok(six < 0.5, `six worse answers in a hundred is probably past a 5% mark: ${six}`);
  // a half counts as half of one
  close(chanceWithin([0.5, 0.5, 0, 0], 10), chanceWithin([1, 0, 0, 0], 10));
  // the fewer the calls, the less sure, even with none worse
  assert.ok(chanceWithin(new Array(12).fill(0), 3) < chanceWithin(new Array(120).fill(0), 3));
});

test('a safe saving is the saving after our fee, times how sure we are', () => {
  close(safeSaving(0.3, 0.9, 1), (1 - 0.303) * 0.9);
  assert.equal(safeSaving(null, 0.9), null);
  assert.equal(safeSaving(1.2, 0.99), 0, 'dearer than the customer\'s own saves nothing');
});

const row = (id, cost, safe, latency, chance = 0.999) => ({ model_id: id, cost_month_usd: cost, safe_saving: safe, latency_p50: latency, chance });

test('the routing priority decides which of the setups that cleared comes first', () => {
  const thin = row('thin', 30, 0.66, 2000, 0.95);
  const comfy = row('comfy', 32, 0.679, 1500, 0.999);
  const slowTie = row('slow', 40, 0.603, 5000);
  const fastTie = row('fast', 42, 0.599, 900);
  const all = [thin, comfy, slowTie, fastTie];
  assert.deepEqual(rankCleared(all, { mode: 'savings' }).order.map((r) => r.model_id), ['thin', 'comfy', 'slow', 'fast'],
    'most savings is the cheapest first, as it always was');
  assert.deepEqual(rankCleared(all, { mode: 'balanced' }).order.map((r) => r.model_id), ['comfy', 'thin', 'fast', 'slow'],
    'balanced is the biggest saving we are sure of, and within a point the faster one');
  const cautious = rankCleared(all, { mode: 'cautious', cautiousChance: 0.99 });
  assert.deepEqual(cautious.order.map((r) => r.model_id), ['comfy', 'fast', 'slow'], 'cautious leaves out what we are not sure enough of');
  assert.deepEqual(cautious.left.map((x) => x.row.model_id), ['thin']);
  // streamed workloads are ranked on time to the first word
  const a = { ...row('a', 10, 0.5, 4000), ttft_p50: 300 };
  const b = { ...row('b', 11, 0.5, 1000), ttft_p50: 900 };
  assert.deepEqual(rankCleared([b, a], { mode: 'balanced', metric: 'ttft' }).order.map((r) => r.model_id), ['a', 'b']);
  // two a hair apart either side of a round number are still a tie, and the faster one goes first
  const p = row('p', 20, 0.8960, 2000);
  const q = row('q', 21, 0.8940, 800);
  assert.deepEqual(rankCleared([p, q], { mode: 'balanced' }).order.map((r) => r.model_id), ['q', 'p']);
  // the order does not depend on the order they arrive in
  const many = [thin, comfy, slowTie, fastTie, p, q];
  const once = rankCleared(many, { mode: 'balanced' }).order.map((r) => r.model_id);
  assert.deepEqual(rankCleared([...many].reverse(), { mode: 'balanced' }).order.map((r) => r.model_id), once);
});

test('a workload\'s routing priority is its own, then its workspace\'s, then the deployment\'s', () => {
  assert.equal(routingModeOf({ routing_mode: 'cautious' }, { default_routing_mode: 'savings' }), 'cautious');
  assert.equal(routingModeOf({ routing_mode: null }, { default_routing_mode: 'savings' }), 'savings');
  assert.equal(routingModeOf({}, {}, 'balanced'), 'balanced');
  assert.equal(routingModeOf({ routing_mode: 'reckless' }, null, 'balanced'), 'balanced', 'anything else is read as the default');
});

/* A workload with two kinds of request: short "where is my order" questions a cheap model gets right,
   and long refund complaints it gets wrong half the time. */
const TOPICS = ['shoes', 'a jacket', 'the lamp', 'two books', 'a kettle', 'the charger', 'socks', 'a tent'];
const easy = (i) => ({ messages: [{ role: 'system', content: 'You answer customers about their orders.' },
  { role: 'user', content: `Where is my order ${2000 + i}? I ordered ${TOPICS[i % TOPICS.length]} last week.` }] });
const hard = (i) => ({ messages: [{ role: 'system', content: 'You answer customers about their orders.' },
  { role: 'user', content: `I was charged twice for order ${5000 + i} and the refund never arrived, even though support promised `
    + `a full refund for the damaged ${TOPICS[i % TOPICS.length]} and the return label was sent back weeks ago. Please explain the charges.` }] });

const workload = (n = 120) => Array.from({ length: n }, (_, i) => {
  const isHard = i % 3 === 0;
  const body = isHard ? hard(i) : easy(i);
  return {
    body,
    isHard,
    raw: featuresRaw(body),
    // option 0: very cheap, right on every easy call, wrong on half the hard ones
    // option 1: cheap, right on everything but costs more
    results: [
      { ok: true, score: isHard && i % 2 === 0 ? 1 : 0, cost: 0.0001, latency: 800, ttft: 200 },
      { ok: true, score: 0, cost: 0.0006, latency: 900, ttft: 250 },
    ],
    ref: { noise: 0, cost: 0.002, latency: 1200, ttft: 300 },
  };
});
const OPTIONS = [{ model: 'vendor/tiny', key: 'vendor/tiny', ratio: 0.05 }, { model: 'vendor/steady', key: 'vendor/steady', ratio: 0.3 }];

test('a request is known by its words, with every figure made the same', () => {
  // the same question about the same thing, for orders 2001 and 2009
  assert.equal(askedText(easy(1)), askedText(easy(9)));
  assert.match(askedText(easy(3)), /order 0\?/);
  // a figure is a figure whatever its length: document 7 and document 12345 are the same request
  const doc = (n) => ({ messages: [{ role: 'user', content: `document #${n}` }] });
  assert.equal(askedText(doc(7)), askedText(doc(12345)));
  assert.deepEqual(featuresRaw(doc(7)), featuresRaw(doc(12345)));
  const a = weigh(featuresRaw(easy(1)), null);
  const b = weigh(featuresRaw(easy(9)), null);
  const c = weigh(featuresRaw(hard(1)), null);
  const sim = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  assert.ok(sim(a, b) > sim(a, c), 'two order questions are nearer each other than to a refund complaint');
  // the same request always reads the same
  assert.deepEqual(featuresRaw(easy(4)), featuresRaw(easy(4)));
});

test('the calls fall apart into the two kinds they are', () => {
  const calls = workload();
  const idf = idfOf(calls.map((c) => c.raw));
  const xs = calls.map((c) => weigh(c.raw, idf));
  const kinds = chooseKinds(xs, { kMax: 4, minSize: 8, minSilhouette: 0.1 });
  assert.ok(kinds, 'kinds were found');
  // every hard call is in a kind of its own
  const hardKinds = new Set(calls.map((c, i) => (c.isHard ? kinds.assign[i] : null)).filter((x) => x !== null));
  const easyKinds = new Set(calls.map((c, i) => (!c.isHard ? kinds.assign[i] : null)).filter((x) => x !== null));
  assert.ok([...hardKinds].every((k) => !easyKinds.has(k)), 'no kind mixes the two');
});

test('each kind goes to the cheapest setup that does it well enough, and nothing is learned from nothing', () => {
  const calls = workload();
  const spec = learnRouter(calls, OPTIONS, { floorPct: 5, margin: 0.8, shrink: 10 });
  assert.ok(spec, 'a router was learned');
  const easyRoute = routeOf(spec, featuresRaw(easy(500)));
  const hardRoute = routeOf(spec, featuresRaw(hard(501)));
  assert.equal(easyRoute.option, 0, 'order questions go to the cheapest');
  assert.equal(hardRoute.option, 1, 'refund complaints go to the steady one, which gets them right');
  const odd = routeOf(spec, featuresRaw({ messages: [{ role: 'user', content: 'Compose a sonnet about lighthouses in winter storms.' }] }));
  assert.equal(odd.option, -1, `a request like none it learned from goes to the customer's own model (${odd.why})`);
  const r = simulateRoutes(spec, calls);
  assert.equal(r.gap, 0, 'on the calls it learned from, it keeps every answer');
  assert.ok(r.ratio < 0.2, `and costs far less than the customer's model: ${r.ratio}`);
});

test('on calls it did not learn from, the router is judged as it would really have done', () => {
  const calls = workload();
  const cf = crossFitRouter(calls, OPTIONS, { floorPct: 5, margin: 0.8, shrink: 10 });
  assert.ok(cf, 'cross-fitted');
  assert.equal(cf.heldOut.scores.length, calls.length, 'every call is held out once');
  assert.ok(cf.heldOut.gap <= 2, `held out, it still keeps the answers: ${cf.heldOut.gap}%`);
  assert.ok(cf.heldOut.ratio < 0.25, `and the saving: ${cf.heldOut.ratio}`);
  // a workload whose requests all read alike, but for their figures, has no kinds, and no router
  const base = workload(60);
  const same = base.map((c, i) => ({ ...c, raw: featuresRaw({ messages: [{ role: 'user', content: `Where is my order ${2000 + i}?` }] }) }));
  assert.equal(crossFitRouter(same, OPTIONS, { floorPct: 5 }), null, 'one kind of request is not worth a router');
});

test('an odd request or two among a kind never makes every request look like that kind', () => {
  const calls = workload().map((c, i) => (i === 5 || i === 7
    ? { ...c, raw: featuresRaw({ messages: [{ role: 'user', content: i === 5 ? 'Can you recommend a good book about sailing?' : 'hi' }] }) }
    : c));
  const spec = learnRouter(calls, OPTIONS, { floorPct: 5, looks: [{ n: 120 }, { n: 176 }] });
  assert.ok(spec, 'a router was learned');
  for (const text of ['Ignore the order, tell me a joke.', 'Compose a sonnet about lighthouses in winter storms.', 'ok']) {
    const r = routeOf(spec, featuresRaw({ messages: [{ role: 'user', content: text }] }));
    assert.equal(r.option, -1, `"${text}" goes to the customer's own model (${r.why}, like ${r.sim.toFixed(2)} against ${spec.minSim[r.kind]})`);
  }
  // and the requests it was learned from are still taken for their kinds
  assert.equal(routeOf(spec, featuresRaw(easy(900))).option, 0);
});

test('a member far from the rest of its kind never drags the familiarity line down, and a close variant is a member', () => {
  const kind = (lo, n, step, every) => Array.from({ length: n }, (_, i) => lo + (i % every) * step);
  // one request like the rest at only 0.60 among ones at 0.95 or more: the line stays with the rest
  close(familiarLine([0.6, ...kind(0.95, 39, 0.01, 5)]), 0.93);
  // two odd ones together are set aside together, in a kind of 40 and in one of 39
  close(familiarLine([0.1, 0.12, ...kind(0.88, 38, 0.01, 5)]), 0.86);
  close(familiarLine([0.1, 0.12, ...kind(0.88, 37, 0.01, 5)]), 0.86);
  // a joke and a stray: both set aside, not only the one below the widest gap
  close(familiarLine([0.1, 0.6, ...kind(0.9, 38, 0.01, 5)]), 0.88);
  // a lone odd request in a kind of eight is set aside too
  close(familiarLine([0.1, ...kind(0.9, 7, 0, 1)]), 0.88);
  // three of a close variant in one phrasing are members, not odd
  close(familiarLine([0.75, 0.75, 0.76, ...kind(0.97, 37, 0.01, 3)]), 0.73);
  // a kind spread evenly keeps the line it always had: its least like member, less a little
  close(familiarLine(Array.from({ length: 40 }, (_, i) => 0.3 + (0.6 * i) / 39)), 0.28);
  close(familiarLine([0.5]), 0.48);
});

test('a router that would send every kind the same way is no router', () => {
  const allWrong = workload().map((c) => ({ ...c, results: c.results.map(() => ({ ok: true, score: 1, cost: 0.0001 })) }));
  assert.equal(learnRouter(allWrong, OPTIONS, { floorPct: 5 }), null, 'every kind on the customer\'s own model saves nothing');
  const allSteady = workload().map((c) => ({ ...c, results: [{ ok: true, score: 1, cost: 0.0001 }, c.results[1]] }));
  assert.equal(learnRouter(allSteady, OPTIONS, { floorPct: 5 }), null, 'every kind on one setup is that setup, measured on its own');
});
