/* Trying the models that can do the job (30 Sep 2026): what a workload's own results say about how strong a model has
   to be to pass there, the next test climbing after one that found nothing, places kept for the strongest models a
   workload can afford, a model that has to think given room above a tight cap, and what a page says of the models a
   setting kept out. Pure parts, with inputs built by hand, so every answer can be worked out without a database, a
   provider or a penny spent. The workload behind it: a science museum's visitor guide on gpt-5.4, capped at 900
   tokens, where every small model had missed by far and the strong ones were never tried. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
const { thinkingFit, eligibility, chanceOf, selectCandidates, strengthScale, workloadCurve } = await import('../src/eval/select.js');
const { buildUpstream } = await import('../src/openrouter.js');
const { roomOf, roomsOf } = await import('../src/proxy.js');
const { pastCap } = await import('../src/eval/replay.js');
const { strongerKeptOut } = await import('../src/workloadPage.js');
const { default: config } = await import('../src/config.js');

const REF = 'openai/gpt-5.4';
const ep = (over = {}) => ({
  tag: 'p', provider: 'P', price_in: 1e-7, price_out: 4e-7, overrides: null, status: 0,
  uptime_1d: 99.9, uptime_30m: 100, ttft_p50: 500, ttft_p90: 900, tps_p50: 60, ...over,
});
// a model at one price, the same at its one provider that keeps nothing
const model = (id, { price = 1e-7, ...over } = {}) => ({
  id, name: id, priceIn: price, priceOut: price * 4, overrides: null, description: '', params: ['response_format', 'max_tokens'],
  inputs: ['text'], contextLen: 128000, maxOutput: 16000, reasoning: null, expiresAt: null,
  endpoints: [ep({ price_in: price, price_out: price * 4 })], ...over,
});
const profile = (over = {}) => ({
  tools: false, toolChoice: false, json: 'none', images: false, outCap: null, promptAvg: 60, promptMax: 200,
  outAvg: 45, outP50: 45, outP95: 90, hours: null, streamed: false, ...over,
});
const factsOf = (list) => ({ models: new Map(list.map((m) => [m.id, m])), zdrKnown: true });
const ref = () => model(REF, { price: 2.5e-6, endpoints: [ep({ price_in: 2.5e-6, price_out: 1.5e-5 })] });
const select = (list, over = {}) => selectCandidates({
  facts: factsOf([ref(), ...list]), profile: profile(), reference: REF, enabled: null, want: 10, tryMultiple: 3, config,
  at: Date.now(), ...over,
});

test('a model that has to think is given room above a tight cap, rather than left out', () => {
  const capped = profile({ outCap: 900 });
  const must = model('x/must', { reasoning: { mandatory: true, supported_efforts: ['low', 'high'], default_effort: 'high' } });
  const fit = thinkingFit(must, capped, 4000, false, 2000);
  assert.equal(fit.ok, true);
  assert.equal(fit.mustThink, true);
  assert.deepEqual(fit.recipe, { reasoning: { effort: 'low' }, room: 2000 }, 'thinking as little as it allows, with room to do it in');
  assert.match(fit.note, /room to think beyond your 900-token cap/);
  // with no allowance it is left out, as it was
  const none = thinkingFit(must, capped, 4000, false, 0);
  assert.equal(none.ok, false);
  assert.match(none.reason, /capped at 900 tokens/);
  // one that cannot write the cap and the room together cannot do it, and says so
  const terse = thinkingFit(model('x/terse', { maxOutput: 2400, reasoning: { mandatory: true } }), capped, 4000, false, 2000);
  assert.equal(terse.ok, false);
  assert.match(terse.reason, /writes at most 2,400 tokens, too few to think in and still give your 900-token answers/);
  // nothing to set its thinking with, or already at its lightest: only the room
  assert.deepEqual(thinkingFit(model('x/plain', { reasoning: { mandatory: true } }), capped, 4000, false, 2000).recipe, { room: 2000 });
  const low = model('x/low', { reasoning: { mandatory: true, supported_efforts: ['low'], default_effort: 'low' } });
  assert.deepEqual(thinkingFit(low, capped, 4000, false, 2000).recipe, { room: 2000 });
  // one that can be told not to think still is, with no room: the rule that kept answers quick is unchanged
  const optional = model('x/opt', { reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['none', 'low'] } });
  assert.deepEqual(thinkingFit(optional, capped, 4000, false, 2000).recipe, { reasoning: { effort: 'none' } });
  // a roomy cap, or none, is as before: no room added
  assert.equal(thinkingFit(must, profile({ outCap: 8000 }), 4000, false, 2000).recipe?.room, undefined);
  /* the room goes on every request capped below 4,000, so the largest of those has to fit: 3,000 and 2,000 more is 5,000,
     more than a model that writes 4,096 can */
  const mixed = profile({ outCap: 900, outCapMax: 3000 });
  assert.equal(thinkingFit(model('x/4k', { maxOutput: 4096, reasoning: { mandatory: true } }), mixed, 4000, false, 2000).ok, false);
  assert.equal(thinkingFit(model('x/8k', { maxOutput: 8192, reasoning: { mandatory: true } }), mixed, 4000, false, 2000).need, 5000);
  // requests above the room get none, so a cap of 16,000 elsewhere asks nothing more of it
  assert.equal(thinkingFit(model('x/8k', { maxOutput: 8192, reasoning: { mandatory: true } }), profile({ outCap: 900, outCapMax: 16000 }), 4000, false, 2000).need, 5999);
});

test('given room, a model has to take it at a provider that keeps nothing, and within what it can read', () => {
  const ctx = { profile: profile({ outCap: 900 }), reference: REF, zdrKnown: true, zdrOnly: true, room: 4000, allowance: 2000,
    expiryMs: 30 * 86400000, at: Date.now(), minUptime: 99 };
  const must = (over) => model('x/must', { reasoning: { mandatory: true }, ...over });
  // its only provider that keeps nothing writes 2,400: too few for 900 and 2,000
  const short = eligibility(must({ endpoints: [ep({ max_output: 2400 })] }), ctx);
  assert.equal(short.ok, false);
  assert.equal(short.step, 'thinking');
  assert.match(short.reason, /providers that keep nothing write too few tokens/);
  // one of two can: that one is kept, the other left
  const two = eligibility(must({ endpoints: [ep({ tag: 'a', max_output: 2400 }), ep({ tag: 'b', max_output: 8000 })] }), ctx);
  assert.equal(two.ok, true);
  assert.deepEqual(two.routes.map((e) => e.tag), ['b']);
  // a window too small for the longest prompt and the room
  const narrow = eligibility(must({ contextLen: 2500 }), { ...ctx, profile: profile({ outCap: 900, promptMax: 200 }) });
  assert.equal(narrow.ok, false);
  assert.match(narrow.reason, /too few for your longest prompt and room to think/);
});

test("an answer given room is read as cut off where it runs past the customer's own cap", () => {
  const json = (content) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  const body = { max_tokens: 900 };
  const room = { room: 2000 };
  // 1,200 written, 200 of it thinking: a 1,000-token answer where 900 are allowed
  const past = pastCap({ json: json('long'), completionTokens: 1200, reasoningTokens: 200 }, body, room);
  assert.equal(past.choices[0].finish_reason, 'length');
  assert.deepEqual(past.understudy_past_cap, { cap: 900, written: 1000 });
  // an 800-token answer is within it
  assert.equal(pastCap({ json: json('ok'), completionTokens: 1000, reasoningTokens: 200 }, body, room).choices[0].finish_reason, 'stop');
  // no thinking said: read from its length, with a tenth to spare
  assert.equal(pastCap({ json: json('x'.repeat(4 * 1000)), completionTokens: null, reasoningTokens: null }, body, room).choices[0].finish_reason, 'length');
  assert.equal(pastCap({ json: json('x'.repeat(4 * 950)), completionTokens: null, reasoningTokens: null }, body, room).choices[0].finish_reason, 'stop');
  // no room given, or a cap roomy enough to have none: as it came
  assert.equal(pastCap({ json: json('long'), completionTokens: 1200, reasoningTokens: 200 }, body, null).choices[0].finish_reason, 'stop');
  assert.equal(pastCap({ json: json('long'), completionTokens: 9000, reasoningTokens: 0 }, { max_tokens: 8000 }, room).choices[0].finish_reason, 'stop');
});

test('a test tries it, priced with its thinking: one that thinking makes dearer than the customer model is left out', () => {
  // gpt-5.4 on these calls: 60 x 2.5e-6 + 45 x 1.5e-5 = $0.000825 a call
  const must = (id, price) => model(id, { price, reasoning: { mandatory: true, supported_efforts: ['low', 'high'], default_effort: 'high' } });
  const sel = select([must('x/affordable', 5e-7), must('x/dear-when-thinking', 1e-6)], { profile: profile({ outCap: 900 }) });
  const tried = sel.order.find((r) => r.model === 'x/affordable');
  assert.ok(tried, `measured: ${JSON.stringify(sel.excluded)}`);
  assert.deepEqual(tried.recipe, { reasoning: { effort: 'low' }, room: config.EVAL_THINK_ALLOWANCE_TOKENS });
  assert.equal(tried.mustThink, true);
  // priced on 45 tokens of answer and 200 of thinking: 60 x 5e-7 + 245 x 2e-6 = $0.00052
  assert.ok(Math.abs(tried.price - (60 * 5e-7 + 245 * 2e-6)) < 1e-12, `${tried.price}`);
  // on its answer alone it would be cheaper (60 x 1e-6 + 45 x 4e-6 = $0.00024); with its thinking dearer ($0.00104)
  const dear = sel.excluded.find((e) => e.model === 'x/dear-when-thinking');
  assert.equal(dear?.step, 'price', JSON.stringify(sel.excluded));
  assert.equal(sel.excluded.some((e) => e.step === 'thinking'), false, 'nothing is left out for thinking any more');
});

test('the room reaches the request as sent, and nothing else about the request changes', () => {
  const messages = [{ role: 'user', content: 'What is a black hole?' }];
  const body = { model: REF, messages, max_tokens: 900 };
  const up = buildUpstream(body, 'x/must', { reasoning: { effort: 'low' }, room: 2000 });
  assert.equal(up.max_tokens, 2900, 'thinking and answer together get the cap and the room');
  assert.deepEqual(up.reasoning, { effort: 'low' });
  assert.equal(body.max_tokens, 900, "the customer's own request is never changed");
  // under the name the request used
  const newer = buildUpstream({ model: REF, messages, max_completion_tokens: 700 }, 'x/must', { room: 2000 });
  assert.equal(newer.max_completion_tokens, 2700);
  assert.equal(newer.max_tokens, undefined);
  // no cap: it already has the room, and nothing is added
  assert.equal(buildUpstream({ model: REF, messages }, 'x/must', { room: 2000 }).max_tokens, undefined);
  // a roomy cap already has room to think: nothing added, which asked more than a model could write
  assert.equal(buildUpstream({ model: REF, messages, max_tokens: 16000 }, 'x/must', { room: 2000 }).max_tokens, 16000);
  // no room: as ever
  assert.equal(buildUpstream(body, 'x/m', { reasoning: { effort: 'none' } }).max_tokens, 900);
  assert.equal(buildUpstream(body, 'x/m', null).max_tokens, 900);
});

test("the room is counted in a live call's hold for the setup given it, and never for the customer's own model", () => {
  assert.equal(roomOf({ served: 'x/must', recipe: { room: 2000 } }), 2000);
  assert.equal(roomOf({ served: 'x/m', recipe: { reasoning: { effort: 'none' } } }), 0);
  assert.equal(roomOf({ served: REF, recipe: null, strategy: null }), 0);
  const cascade = { spec: { kind: 'cascade', first: { model: 'x/must', recipe: { room: 1500 } }, fallback: { model: REF } } };
  assert.equal(roomOf({ served: 'x/must', recipe: { room: 1500 }, strategy: cascade }), 1500);
  // by model: the one given room is held at the raised cap, the customer's model it falls back to at the request's own
  const rooms = roomsOf({ served: 'x/must', recipe: { room: 1500 }, strategy: cascade });
  assert.equal(rooms.get('x/must'), 1500);
  assert.equal(rooms.has(REF), false);
  // a router by kind of request can send a call to any of its setups
  const router = { spec: { kind: 'router', options: [{ model: 'x/a' }, { model: 'x/must', recipe: { room: 2000 } }] } };
  assert.equal(roomOf({ recipe: null, strategy: router }), 2000);
  // and a strategy's fallback, one step on
  assert.equal(roomOf({ recipe: null, strategy: { spec: { kind: 'model', model: 'x/a' }, fallback: { spec: { kind: 'model', model: 'x/m', recipe: { room: 800 } } } } }), 800);
});

// a leaderboard where the dearer models are the stronger ones, as it is on the whole
const LADDER = [
  ['v1/tiny-3b', 1150, 2e-8], ['v2/small-8b', 1200, 3e-8], ['v3/mini-24b', 1260, 6e-8], ['v4/mid-70b', 1320, 1.5e-7],
  ['v5/large-235b', 1400, 3e-7], ['v6/ultra-550b', 1430, 4e-7], ['v7/haiku', 1440, 1e-6], ['v8/flash', 1450, 6e-7],
  ['v9/pro', 1475, 1.2e-6], ['v10/strong', 1480, 1.4e-6],
];
const ladderModels = () => LADDER.map(([id, , price]) => model(id, { price }));
const ladderArena = () => new Map([[REF, 1452], ...LADDER.map(([id, r]) => [id, r])]);

test('every model gets a strength: its leaderboard rating, or one read from its price along the rated ones', () => {
  const unrated = model('v0/unrated', { price: 5e-7 });
  const strength = strengthScale([...ladderModels(), unrated], ladderArena());
  assert.deepEqual(strength('v9/pro'), { value: 1475, read: false });
  const read = strength('v0/unrated');
  assert.equal(read.read, true);
  assert.ok(read.value > 1320 && read.value < 1480, `read from its price, between the rated ones either side: ${read.value}`);
  // with too few rated models to draw a line, an unrated model has no strength
  assert.equal(strengthScale([unrated, ...ladderModels().slice(0, 5)], ladderArena())('v0/unrated'), null);
  // nor when the rated ones say the dearer are the weaker
  const falling = new Map([[REF, 1452], ...LADDER.map(([id, r], i) => [id, 1500 - i * 30])]);
  assert.equal(strengthScale([unrated, ...ladderModels()], falling)('v0/unrated'), null);
});

test("a workload's own results say how strong a model has to be to pass there, and how hard the task turned out", () => {
  const strength = strengthScale(ladderModels(), ladderArena());
  // the museum guide: every model below about 1420 missed, the one at 1430 passed, the one at 1400 came close
  const own = new Map([
    ['v1/tiny-3b', { verdict: 'missed' }], ['v2/small-8b', { verdict: 'missed' }], ['v3/mini-24b', { verdict: 'missed' }],
    ['v4/mid-70b', { verdict: 'missed' }], ['v5/large-235b', { verdict: 'review' }], ['v6/ultra-550b', { verdict: 'cleared' }],
    // stopped for speed before its answers were judged: says nothing about them
    ['v8/flash', { verdict: 'slower', stopped: 'speed' }],
  ]);
  const here = workloadCurve(own, strength, REF, 60);
  assert.equal(here.n, 6, 'the one never judged on its answers is not counted');
  assert.ok(here.theta > -80 && here.theta < 0, `an even chance a little below gpt-5.4's rating: ${here.theta}`);
  assert.ok(here.curve(1150 - 1452) < 0.05, 'a tiny model has almost no chance here');
  assert.ok(here.curve(1480 - 1452) > 0.75, 'a model stronger than gpt-5.4 very likely passes');
  assert.ok(Math.abs(here.difficulty - (1 - 1.5 / 6)) < 1e-9, `four missed and one and a half passed of six: ${here.difficulty}`);
  // fewer than four placed: nothing to say
  assert.equal(workloadCurve(new Map([...own].slice(0, 3)), strength, REF, 60), null);
});

test('with those results, a strong untried model is likelier to pass there than a small one, however little either costs', () => {
  const models = [...ladderModels(), model('v11/untried-small', { price: 2.5e-8 }), model('v12/untried-strong', { price: 1.1e-6 })];
  const arena = new Map([...ladderArena(), ['v11/untried-small', 1190], ['v12/untried-strong', 1462]]);
  const own = new Map([
    ['v1/tiny-3b', { verdict: 'missed' }], ['v2/small-8b', { verdict: 'missed' }], ['v3/mini-24b', { verdict: 'missed' }],
    ['v4/mid-70b', { verdict: 'missed' }], ['v5/large-235b', { verdict: 'review' }], ['v6/ultra-550b', { verdict: 'cleared' }],
  ]);
  const strength = strengthScale(models, arena);
  const here = workloadCurve(own, strength, REF, 60);
  // Jev reads both as a good fit, as it read every model on the museum guide
  const fits = new Map([['v11/untried-small', { fit: 0.66, label: 'Good fit' }], ['v12/untried-strong', { fit: 0.66, label: 'Good fit' }]]);
  const ctx = (over) => ({ reference: REF, history: { own, shape: new Map() }, fits, arena, difficulty: 0.37, strength, ...over });
  const small = chanceOf(models.find((m) => m.id === 'v11/untried-small'), ctx({ here }));
  const strong = chanceOf(models.find((m) => m.id === 'v12/untried-strong'), ctx({ here }));
  assert.ok(strong.chance > small.chance + 0.3, `${strong.chance} against ${small.chance}`);
  assert.ok(small.parts.some((p) => p.source === 'here'), 'said as what this workload showed');
  // without them, the two read about the same, which is how the small ones took every place
  const before = [chanceOf(models.find((m) => m.id === 'v11/untried-small'), ctx({})).chance,
    chanceOf(models.find((m) => m.id === 'v12/untried-strong'), ctx({})).chance];
  assert.ok(Math.abs(before[0] - before[1]) < 0.2, `before: ${before}`);
  // a model tested here is read from its own result, not the curve
  assert.equal(chanceOf(models.find((m) => m.id === 'v6/ultra-550b'), ctx({ here })).parts.some((p) => p.source === 'here'), false);
});

test('a model stopped before its answers were all read counts as a miss where those it gave were far outside the bar', () => {
  const m = model('x/stopped');
  const read = (h) => chanceOf(m, { reference: REF, history: { own: new Map([['x/stopped', h]]), shape: new Map() } });
  // stopped for speed with 96% of 25 answers worse against 20.8% allowed, as llama-3.1-8b was on the museum guide: a miss
  const far = read({ verdict: 'slower', stopped: 'speed', gap: 96, floor: 20.8, runs: 25 });
  assert.deepEqual(far.parts.map((p) => [p.source, p.p, p.note]), [['before', 0.1, 'missed before it was stopped']]);
  // on three answers, too few to read: nothing, as a verdict needs ten
  assert.equal(read({ verdict: 'slower', stopped: 'speed', gap: 66, floor: 20.8, runs: 3 }).parts.length, 0);
  // stopped with its answers inside twice the bar says nothing about them, as before
  assert.equal(read({ verdict: 'slower', stopped: 'speed', gap: 18.5, floor: 20.8, runs: 27 }).parts.length, 0);
  // a provider that failed it is written as a 100% difference, which says nothing about the model
  assert.equal(read({ verdict: 'failed', stopped: 'errors', gap: 100, floor: 20.8, runs: 2 }).parts.length, 0);
  assert.equal(read({ verdict: 'failed', stopped: 'refused', gap: 100, floor: 20.8, runs: 30 }).parts.length, 0);
  // with the workload's results to read, one that said nothing is read from them, like one never tested
  const strength = strengthScale(ladderModels(), ladderArena());
  const here = { n: 8, ref: 1452, curve: () => 0.2 };
  const quiet = chanceOf(model('v5/large-235b'), { reference: REF, strength, here,
    history: { own: new Map([['v5/large-235b', { verdict: 'slower', stopped: 'speed', gap: 18.5, floor: 20.8, runs: 27 }]]), shape: new Map() } });
  assert.deepEqual(quiet.parts.map((p) => p.source), ['here']);
  // and so is one its provider failed
  const failed = chanceOf(model('v5/large-235b'), { reference: REF, strength, here,
    history: { own: new Map([['v5/large-235b', { verdict: 'failed', stopped: 'errors', gap: 100, floor: 20.8, runs: 2 }]]), shape: new Map() } });
  assert.deepEqual(failed.parts.map((p) => p.source), ['here']);
});

test("a model measured with its thinking switched off is left out of the workload's curve, not of its own reading", () => {
  const strength = strengthScale(ladderModels(), ladderArena());
  const own = new Map([
    ['v1/tiny-3b', { verdict: 'missed' }], ['v2/small-8b', { verdict: 'missed' }], ['v3/mini-24b', { verdict: 'missed' }],
    ['v6/ultra-550b', { verdict: 'cleared' }],
    // the strongest two missed with their thinking off: read at their ratings they said nothing short of the best passes
    ['v9/pro', { verdict: 'missed', thinkingOff: true }], ['v10/strong', { verdict: 'missed', thinkingOff: true }],
  ]);
  const here = workloadCurve(own, strength, REF, 60);
  assert.equal(here.n, 4);
  const withThem = workloadCurve(new Map([...own].map(([k, v]) => [k, { ...v, thinkingOff: false }])), strength, REF, 60);
  assert.ok(withThem.theta > here.theta + 20, `counted, they push the even chance up: ${withThem.theta} against ${here.theta}`);
  // asked to think as little as it allows is not the model its rating describes either
  const light = new Map([...own].map(([k, v]) => [k, v.thinkingOff ? { verdict: v.verdict, thinking: 'light' } : v]));
  assert.equal(workloadCurve(light, strength, REF, 60).n, 4);
  // one stopped for speed after missing by far reads as the miss it is, here as for itself
  const stopped = new Map([...own, ['v4/mid-70b', { verdict: 'slower', stopped: 'speed', gap: 96, floor: 20.8, runs: 25 }]]);
  assert.equal(workloadCurve(stopped, strength, REF, 60).n, 5);
});

test('after a test that found nothing, the next tries the likeliest to pass first, the cheaper of two as likely first', () => {
  // three untried models, read by Jev alone: likely and dear, unlikely and cheap, and one as likely as the first but cheaper
  /* expected saving, a call: b $0.00082 x 0.455, c $0.000585 x 0.617, a $0.000537 x 0.608; chances 0.455, 0.617, 0.608,
     so a and c in one band of 0.05 and b two below */
  const list = [model('a/likely-dear', { price: 1.2e-6 }), model('b/unlikely-cheap', { price: 2e-8 }), model('c/likely-cheaper', { price: 1e-6 })];
  const fits = new Map([['a/likely-dear', { fit: 0.62 }], ['b/unlikely-cheap', { fit: 0.45 }], ['c/likely-cheaper', { fit: 0.63 }]]);
  const history = (lastFailed) => ({ own: new Map(), shape: new Map(), lastFailed });
  const saving = select(list, { fits, history: history(false) });
  assert.equal(saving.order[0].model, 'b/unlikely-cheap', 'by expected saving, the cheapest first');
  assert.equal(saving.climb, false);
  const climb = select(list, { fits, history: history(true) });
  assert.equal(climb.climb, true);
  assert.deepEqual(climb.order.map((r) => r.model), ['c/likely-cheaper', 'a/likely-dear', 'b/unlikely-cheap'],
    'the two likeliest first, as likely as each other, so the cheaper of them first');
});

test("the customer's own model from its cheapest provider is read from what it did here, not a fixed guess", () => {
  // gpt-5.4 at two providers, one a good deal cheaper: the cheaper is tried as the customer's own model from it
  const two = model(REF, { price: 2.5e-6, endpoints: [ep({ tag: 'dear', price_in: 2.5e-6, price_out: 1.5e-5 }), ep({ tag: 'cheap', price_in: 1e-6, price_out: 6e-6 })] });
  const run = (own) => selectCandidates({ facts: factsOf([two, model('x/other')]), profile: profile(), reference: REF, enabled: null, want: 10,
    tryMultiple: 3, config, at: Date.now(), history: { own, shape: new Map(), lastFailed: true } });
  const fresh = run(new Map()).ranked.find((r) => r.key === `${REF}#cheapest`);
  assert.equal(fresh?.chance, 0.8, 'never tried here: the guess');
  const missed = run(new Map([[`${REF}#cheapest`, { verdict: 'missed' }]])).ranked.find((r) => r.key === `${REF}#cheapest`);
  assert.ok(Math.abs(missed.chance - (6 * 0.1 + 0.8) / 7) < 1e-9, `missed here: ${missed.chance}`);
});

test('places are kept in every test for the strongest models a workload can afford, whatever they save', () => {
  const list = [...ladderModels(), model('v13/missed-here', { price: 1.3e-6 })];
  const arena = new Map([...ladderArena(), ['v13/missed-here', 1490]]);
  const own = new Map([['v13/missed-here', { verdict: 'missed' }]]);
  const sel = select(list, { arena, history: { own, shape: new Map() }, serving: 'v1/tiny-3b' });
  assert.equal(sel.order[0].model, 'v1/tiny-3b', 'what serves is still looked at first');
  assert.deepEqual(sel.strong, ['v10/strong', 'v9/pro', 'v8/flash'], 'the three strongest it can afford, strongest first');
  assert.deepEqual(sel.order.slice(1, 4).map((r) => r.model), ['v10/strong', 'v9/pro', 'v8/flash']);
  for (const r of sel.order.slice(1, 4)) {
    assert.equal(r.strongPlace, true);
    assert.match(r.note, /one of the strongest models you can afford/);
  }
  assert.equal(sel.strong.includes('v13/missed-here'), false, 'one that already missed here has said what it can do');
  // none that the evidence holds back: its provider busy lately, or unlikely to be quick enough
  const busy = select(list, { arena, history: { own, shape: new Map() }, busy: new Map([['v10/strong', { n: 2, at: Date.now() }]]) });
  assert.equal(busy.strong.includes('v10/strong'), false);
  // never more than a third of the models measured to the end
  const three = select(list, { arena, history: { own, shape: new Map() }, want: 3 });
  assert.equal(three.strong.length, 1);
  // one from each maker: three versions of one model never take every place
  const same = select([model('g/flash-3.8', { price: 1.4e-6 }), model('g/flash-3.7', { price: 1.3e-6 }), model('g/flash-3.6', { price: 1.2e-6 }),
    model('k/kimi', { price: 1e-6 }), model('z/glm', { price: 9e-7 }), ...ladderModels().slice(0, 4)],
  { arena: new Map([...ladderArena(), ['g/flash-3.8', 1490], ['g/flash-3.7', 1488], ['g/flash-3.6', 1486], ['k/kimi', 1470], ['z/glm', 1465]]) });
  assert.deepEqual(same.strong, ['g/flash-3.8', 'k/kimi', 'z/glm']);
  // none kept with the setting at 0
  const off = selectCandidates({ facts: factsOf([ref(), ...list]), profile: profile(), reference: REF, enabled: null, want: 10,
    tryMultiple: 3, config: { ...config, EVAL_STRONG_PLACES: 0 }, arena, at: Date.now() });
  assert.deepEqual(off.strong, []);
});

test('a test that found nothing says which settings kept models out, naming one of each, and what would let them in', () => {
  const plan = { ruledOut: [
    { step: 'private', count: 90, examples: [{ model: 'anthropic/claude-fable-5.1', reason: 'has no provider that keeps nothing' }] },
    { step: 'thinking', count: 3, examples: [{ model: 'x-ai/grok-4.5', reason: 'thinks before every answer and writes at most 1,200 tokens, too few to think in and still give your 900-token answers' }] },
    { step: 'price', count: 13, dearer: 12, examples: [{ model: 'anthropic/claude-sonnet-4.6', reason: 'costs 2% more than what gpt-5.4 does' },
      { model: 'x/fee', reason: 'would save less than our 5% fee on your calls' }] },
    { step: 'health', count: 15, examples: [{ model: 'x/flaky' }] },
  ] };
  const nothing = [{ key: 'v1', tone: 'bad', confirmed: false }, { key: 'v2', tone: 'ok', confirmed: false }];
  const said = strongerKeptOut(plan, nothing, 'gpt-5.4');
  assert.match(said, /^Some models were not tried: 90 have no provider that deletes requests right away, which Zero data retention requires \(for example anthropic\/claude-fable-5\.1\)/);
  assert.match(said, /3 think before every answer and cannot write or read enough to think and still give your answers \(for example x-ai\/grok-4\.5\)/);
  assert.match(said, /and 12 cost more than gpt-5\.4 on your requests, so switching to them could not save anything \(for example anthropic\/claude-sonnet-4\.6\)\./);
  assert.match(said, /Turning off Zero data retention, under Privacy in Settings, lets those be tried\./);
  // one that cannot write enough to think and answer is not helped by a higher cap, so nothing is suggested for it
  assert.doesNotMatch(said, /max_tokens|next test tries those that think/);
  // left out for having to think at all, in a test from before the room: the next test gives it the room
  const older = strongerKeptOut({ ruledOut: [{ step: 'thinking', count: 48, examples: [{ model: 'google/gemini-3.8-flash',
    reason: 'thinks before every answer and cannot be told not to, and your answers are capped at 900 tokens' }] }] }, nothing, 'gpt-5.4');
  assert.equal(older, 'Some models were not tried: 48 think before every answer, and your answers are capped at 900 tokens '
    + '(for example google/gemini-3.8-flash). The next test can try those that think, with room to think beyond that cap.');
  // requests that ask for zero retention themselves: the setting would not let those in, and the page says so
  assert.match(strongerKeptOut({ ...plan, zdrAsked: true }, nothing, 'gpt-5.4'), /Your own requests ask for zero data retention too/);
  // cheaper by less than the fee is not "costs more": with only those, nothing is said of price
  assert.equal(strongerKeptOut({ ruledOut: [{ step: 'price', count: 2, dearer: 0, examples: [{ model: 'x/fee', reason: 'would save less than our 5% fee' }] }] }, nothing, 'gpt-5.4'), null);
  // a test that did not count them apart says "some" where its examples do not settle how many
  assert.match(strongerKeptOut({ ruledOut: [{ step: 'price', count: 9, examples: [{ model: 'x/fee', reason: 'would save less than our 5% fee' },
    { model: 'x/dear', reason: 'costs 40% more than what gpt-5.4 does' }] }] }, nothing, 'gpt-5.4'),
  /^Some models were not tried: some cost more than gpt-5\.4 on your requests, so switching to them could not save anything \(for example x\/dear\)\.$/);
  assert.doesNotMatch(said, /flaky|answering reliably/, 'only what a setting of theirs decides');
  // something passed twice, or what serves still passes: nothing to say
  assert.equal(strongerKeptOut(plan, [...nothing, { key: 'v3', tone: 'ok', confirmed: true }], 'gpt-5.4'), null);
  assert.equal(strongerKeptOut(plan, [{ key: 'v4', tone: 'ok', serving: true }], 'gpt-5.4'), null);
  // a test from before these were recorded, or with none of them: nothing
  assert.equal(strongerKeptOut({}, nothing, 'gpt-5.4'), null);
  assert.equal(strongerKeptOut({ ruledOut: [{ step: 'health', count: 2, examples: [] }] }, nothing, 'gpt-5.4'), null);
  // one of a kind reads as one
  assert.match(strongerKeptOut({ ruledOut: [{ step: 'price', count: 1, dearer: 1, examples: [{ model: 'x/dear', reason: 'costs 9% more' }] }] }, nothing, 'gpt-5.4'),
    /1 costs more than gpt-5\.4 on your requests, so switching to it could not save anything/);
});
