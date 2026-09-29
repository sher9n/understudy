import test from 'node:test';
import assert from 'node:assert/strict';
import { betaCdf, chanceWithin, safeSaving } from '../src/eval/confidence.js';
import { partsOf, scoreOf, rankByScore, optimizeFor, optimizeValue, beatsServing, PRESETS, p50Of } from '../src/eval/score.js';
import { askedText, featuresRaw, idfOf, weigh, chooseKinds, learnRouter, routeOf, simulateRoutes, crossFitRouter, familiarLine } from '../src/learn/kinds.js';
import { bestFor, pickFor } from '../src/workloadPage.js';

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

/* The score every setup a test tries is given (src/eval/score.js), worked by hand on two real tests from production,
   25 Sep 2026: the tool-call workload (GPT-5.4 at $1.43 a thousand requests and 1.62 s, 4.63% allowed) and the invoice
   workload (GPT-5.4 at $2.43 a thousand and 2.01 s, 3% allowed). */
const TOOL = { floorPct: 4.6296, refP50: 1617, ref: 1.42519 };
const INVOICE = { floorPct: 3, refP50: 2014, ref: 2.43416 };
const res = (id, gap, per1k, p50, t, extra = {}) => ({ model_id: id, gap_pct: gap, cost_ratio: per1k / t.ref, latency_p50: p50, chance: 0.999, ...extra });

test('each part is out of 100: quality against the allowed difference, cost and speed against the original model', () => {
  // gemma-4-31b-it on the tool-call test: no answer differed, $0.110 against $1.425, 0.738 s against 1.617 s
  assert.deepEqual(partsOf({ gapPct: 0, floorPct: 4.6296, costRatio: 0.11 / 1.42519, p50: 738, refP50: 1617 }), { quality: 100, cost: 92, speed: 54 });
  // at the allowed difference quality is 50, and at twice it 0, never below
  assert.equal(partsOf({ gapPct: 4.6296, floorPct: 4.6296, costRatio: 0.5 }).quality, 50);
  assert.equal(partsOf({ gapPct: 10, floorPct: 4.6296, costRatio: 0.5 }).quality, 0);
  // dearer than the original model saves nothing, and slower gains nothing
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 1.3 }).cost, 0);
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 0.2, p50: 2300, refP50: 2014 }).speed, 0);
  // what cannot be known is null, never a zero
  assert.deepEqual(partsOf({ gapPct: null, floorPct: 3, costRatio: null, p50: null, refP50: null }), { quality: null, cost: null, speed: null });
  assert.equal(partsOf({ gapPct: 1, floorPct: 0, costRatio: 0.2 }).quality, null, 'no allowed difference, no quality score');
  /* but where the original model was timed, a setup with no time of its own has no speed to its credit: left out, it
     scored on quality and cost alone, and beat every timed setup where speed counts most */
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 0.2, p50: null, refP50: 2014 }).speed, 0);
  const timed = scoreOf({ quality: 90, cost: 80, speed: 0 }, 'speed').exact;
  const untimed = scoreOf(partsOf({ gapPct: 0.6, floorPct: 3, costRatio: 0.2, p50: null, refP50: 2014 }), 'speed').exact;
  assert.equal(untimed, timed, `the same quality and cost, timed slower or not timed: ${untimed} against ${timed}`);
  // never 100 while it costs anything or takes any time: 99.6% less reads "99% less" on every other screen
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 0.004 }).cost, 99);
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 0 }).cost, 100, 'free is free');
  assert.equal(partsOf({ gapPct: 0, floorPct: 3, costRatio: 0.2, p50: 4, refP50: 2014 }).speed, 99);
});

test('the score is the parts weighted by what the workload optimizes for, built from the rounded parts', () => {
  const gemma = { quality: 100, cost: 92, speed: 54 };
  assert.equal(scoreOf(gemma, 'balance').score, 84, '100 x 40% + 92 x 30% + 54 x 30%');
  assert.equal(scoreOf(gemma, 'quality').score, 92);
  assert.equal(scoreOf(gemma, 'cost').score, 88);
  assert.equal(scoreOf(gemma, 'speed').score, 71);
  for (const w of Object.values(PRESETS)) assert.equal(w.quality + w.cost + w.speed, 100);
  // a model that was not timed is scored on the other two, which then count for all of it
  const untimed = scoreOf({ quality: 100, cost: 92, speed: null }, 'balance');
  assert.ok(Math.abs(untimed.exact - (40 * 100 + 30 * 92) / 70) < 1e-9);
  // with quality or cost unknown there is no score at all
  assert.equal(scoreOf({ quality: null, cost: 92, speed: 54 }, 'balance'), null);
  assert.equal(scoreOf({ quality: 100, cost: null, speed: 54 }, 'balance'), null);
});

test('on the tool-call test the best balance is gemma, not the cheapest', () => {
  const rows = [
    res('google/gemma-4-31b-it', 0, 0.110, 738, TOOL), res('qwen/qwen3-coder', 0, 0.304, 1038, TOOL),
    res('nvidia/nemotron-3-ultra-550b-a55b', 0, 0.714, 705, TOOL), res('openai/gpt-3.5-turbo-0613', 0.9259, 0.434, 921, TOOL),
  ];
  const r = rankByScore(rows, { optimize: 'balance', floorPct: TOOL.floorPct, refP50: TOOL.refP50 });
  assert.deepEqual(r.order.map((x) => x.model_id), ['google/gemma-4-31b-it', 'qwen/qwen3-coder', 'nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-3.5-turbo-0613']);
  assert.deepEqual(r.order.map((x) => r.scores.get(x).score.score), [84, 75, 72, 70]);
  // the cheapest model tested, $0.013 a thousand, 4.63% of its answers different: right at the limit, 70
  const cheapest = res('upstage/solar-mini4', 4.6296, 0.013, 540, TOOL);
  assert.equal(rankByScore([cheapest], { floorPct: TOOL.floorPct, refP50: TOOL.refP50 }).scores.get(cheapest).score.score, 70);
});

test('on the invoice test balance picks the much faster model, and cost the checked one, never simply the cheapest', () => {
  const rows = [
    res('inclusionai/ling-3.0-flash-vl', 0, 0.041, 2297, INVOICE), res('upstage/solar-mini4', 0, 0.054, 1763, INVOICE),
    res('bytedance-seed/seed-2.0-mini', 0, 0.103, 1120, INVOICE), res('cascade:inception/mercury-2.5', 0, 0.125, 886, INVOICE),
    res('inception/mercury-2', 0, 0.245, 678, INVOICE),
  ];
  const top = (optimize) => rankByScore(rows, { optimize, floorPct: INVOICE.floorPct, refP50: INVOICE.refP50 }).order[0].model_id;
  assert.equal(top('balance'), 'inception/mercury-2');
  assert.equal(top('cost'), 'cascade:inception/mercury-2.5');
  assert.equal(top('speed'), 'inception/mercury-2');
  // quality and cost both 100 and near 95 for all of them: the tie between the two Mercury setups goes to the exact figure
  assert.equal(top('quality'), 'inception/mercury-2');
  // the cheapest, slower than GPT-5.4, comes last on balance
  const order = rankByScore(rows, { optimize: 'balance', floorPct: INVOICE.floorPct, refP50: INVOICE.refP50 }).order;
  assert.equal(order[order.length - 1].model_id, 'inclusionai/ling-3.0-flash-vl');
});

test('optimizing for quality leaves out what it is not sure enough of, and the order does not depend on arrival', () => {
  const sure = res('sure', 0, 0.3, 900, TOOL, { chance: 0.995 });
  const unsure = res('unsure', 0, 0.1, 700, TOOL, { chance: 0.93 });
  const q = rankByScore([sure, unsure], { optimize: 'quality', floorPct: TOOL.floorPct, refP50: TOOL.refP50, cautiousChance: 0.99 });
  assert.deepEqual(q.order.map((x) => x.model_id), ['sure']);
  assert.deepEqual(q.left.map((x) => x.row.model_id), ['unsure']);
  assert.match(q.left[0].why, /not sure enough for a workload optimized for quality/);
  // any other choice keeps both
  assert.equal(rankByScore([sure, unsure], { optimize: 'balance', floorPct: TOOL.floorPct, refP50: TOOL.refP50 }).order.length, 2);
  const many = [sure, unsure, res('a', 1, 0.2, 800, TOOL), res('b', 1, 0.2, 800, TOOL), res('c', 0.5, 0.25, 1500, TOOL)];
  const once = rankByScore(many, { floorPct: TOOL.floorPct, refP50: TOOL.refP50 }).order.map((x) => x.model_id);
  assert.deepEqual(rankByScore([...many].reverse(), { floorPct: TOOL.floorPct, refP50: TOOL.refP50 }).order.map((x) => x.model_id), once);
  // one with no score (not priced) comes after every one with one
  const unpriced = { model_id: 'unpriced', gap_pct: 0, cost_ratio: null, latency_p50: 500, chance: 0.999 };
  assert.equal(rankByScore([unpriced, ...many], { floorPct: TOOL.floorPct, refP50: TOOL.refP50 }).order.at(-1).model_id, 'unpriced');
  // streamed workloads are timed to the first word
  assert.equal(p50Of({ latency_p50: 4000, ttft_p50: 300 }, 'ttft'), 300);
  assert.equal(p50Of({ latency_p50: 4000, ttft_p50: null }, 'ttft'), 4000);
});

test('what serves is only replaced by a setup that scores clearly better', () => {
  const s = (exact) => ({ score: { exact, score: Math.round(exact) } });
  assert.equal(beatsServing(s(86), s(84), { margin: 3 }), false, 'two points ahead is not enough');
  assert.equal(beatsServing(s(87), s(84), { margin: 3 }), true);
  // with either score unknown, the older rule: only something cheaper
  assert.equal(beatsServing(s(99), { score: null }, { margin: 3, cheaper: false }), false);
  assert.equal(beatsServing({ score: null }, s(50), { margin: 3, cheaper: true }), true);
});

test('the page names as the pick what a test switches to: past a first in line its second look could not stand behind', () => {
  // a test page's rows as runPageOf gives them: scores per choice, whether each could be picked, and how its looks went
  const cand = (key, balance, extra = {}) => ({ key, scores: { balance, quality: balance, cost: balance, speed: balance }, eligible: true,
    sure: true, confirmed: false, serving: false, parts: { quality: 90, cost: 90, speed: 50 }, tone: 'ok', ...extra });
  const top = cand('top', 90);
  const twice = cand('twice', 85, { confirmed: true });
  const third = cand('third', 80);
  // the test looked at "top" again and had too few new requests to go on, so it switched to "twice", next in line
  assert.equal(bestFor([top, twice, third], 'balance', { settled: true }), 'twice');
  // for a choice the test did not make, the best score, its second look still to come
  assert.equal(bestFor([top, twice, third], 'cost'), 'top');
  // nothing looked at twice (the test was cut short): the best score, waiting for its look
  assert.equal(bestFor([top, third], 'balance', { settled: true }), 'top');
  // what served when the test ran keeps serving unless one scores clearly better: 88 is not 3 points over 86
  const inUse = cand('inUse', 86);
  const held = { settled: true, inUse: 'inUse' };
  assert.deepEqual(pickFor([cand('a', 88, { confirmed: true }), inUse], 'balance', held), { key: 'inUse', kept: true });
  assert.deepEqual(pickFor([cand('a', 89, { confirmed: true }), inUse], 'balance', held), { key: 'a', kept: false });
  // one clearly better whose look could not be read, and what serves after it: what serves, as the test left it
  assert.equal(bestFor([cand('a', 95), inUse], 'balance', held), 'inUse');
  // the best of all, kept: nothing scores more, so it is simply the best
  assert.deepEqual(pickFor([cand('a', 80, { confirmed: true }), inUse], 'balance', held), { key: 'inUse', kept: false });
  // optimized for quality, what serves keeps serving though it is not sure enough to be picked afresh
  const unsure = cand('unsure', 86, { sure: false });
  assert.equal(bestFor([cand('b', 87, { confirmed: true }), unsure], 'quality', { settled: true, inUse: 'unsure' }), 'unsure');
  // what serves with no score: only a cheaper one is looked at in its place, as before there were scores
  const unscored = cand('unscored', null, { costMonth: 20 });
  assert.equal(bestFor([cand('dearer', 95, { costMonth: 30, confirmed: true }), unscored], 'balance', { settled: true, inUse: 'unscored' }), 'unscored');
  assert.equal(bestFor([cand('cheaper', 70, { costMonth: 10, confirmed: true }), unscored], 'balance', { settled: true, inUse: 'unscored' }), 'cheaper');
  // what the test wrote down that it chose is its pick, for what it optimized for, whatever the rows say
  assert.equal(bestFor([top, twice, third], 'balance', { settled: true, chosen: 'third' }), 'third');
  assert.equal(bestFor([top, twice, third], 'cost', { chosen: 'third' }), 'top', 'for another choice, the rule');
  // one that could not be picked at all never is, and with none that could, there is no pick
  assert.equal(bestFor([cand('failed', 99, { eligible: false }), third], 'balance'), 'third');
  assert.equal(bestFor([cand('failed', 99, { eligible: false })], 'balance'), null);
});

test('what a workload optimizes for is its own, then its workspace\'s, then the deployment\'s, and the old names still read', () => {
  assert.equal(optimizeFor({ routing_mode: 'speed' }, { default_routing_mode: 'cost' }), 'speed');
  assert.equal(optimizeFor({ routing_mode: null }, { default_routing_mode: 'cost' }), 'cost');
  assert.equal(optimizeFor({}, {}, 'balance'), 'balance');
  assert.equal(optimizeFor({ routing_mode: 'reckless' }, null, 'balance'), 'balance', 'anything else is read as the default');
  // the routing priorities from before
  assert.equal(optimizeValue('balanced'), 'balance');
  assert.equal(optimizeValue('cautious'), 'quality');
  assert.equal(optimizeValue('savings'), 'cost');
  assert.equal(optimizeFor({ routing_mode: 'cautious' }, { default_routing_mode: 'savings' }), 'quality');
  assert.equal(optimizeValue(' Speed '), 'speed');
  assert.equal(optimizeValue(null), null);
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
