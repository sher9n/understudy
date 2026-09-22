/* Choosing which models to measure: the pure parts, with inputs built by hand so every answer
   can be checked without a database, a provider or a penny spent. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
const { thinkingFit, eligibility, chanceOf, selectCandidates, refThinksOf, speedChanceOf, recipeKind } = await import('../src/eval/select.js');
const { slowEndCount } = await import('../src/eval/run.js');
const { failingClearly, tailAtLeast } = await import('../src/eval/promote.js');
const { thinkingAsked, profileFromRows } = await import('../src/eval/profile.js');
const { callPrice, routedCallPrice, healthOf } = await import('../src/models/facts.js');
const { numbersOf, numbersDiffer } = await import('../src/eval/judge.js');
const { replayKey } = await import('../src/eval/replay.js');
const { core } = await import('../src/models/arena.js');
const { sampleCalls } = await import('../src/eval/compare.js');
const { default: config } = await import('../src/config.js');

const ep = (over = {}) => ({
  tag: 'p', provider: 'P', price_in: 1e-7, price_out: 4e-7, overrides: null, status: 0,
  uptime_1d: 99.9, uptime_30m: 100, ttft_p50: 500, ttft_p90: 900, tps_p50: 60, ...over,
});
const model = (id, over = {}) => ({
  id, name: id, priceIn: 1e-7, priceOut: 4e-7, overrides: null, description: '', params: ['response_format', 'tools', 'tool_choice', 'structured_outputs', 'max_tokens'],
  inputs: ['text'], contextLen: 128000, maxOutput: 16000, reasoning: null, expiresAt: null, endpoints: [ep()], ...over,
});
const profile = (over = {}) => ({
  tools: false, toolChoice: false, json: 'none', images: false, outCap: null, promptAvg: 60, promptMax: 200,
  outAvg: 45, outP50: 45, outP95: 90, hours: null, streamed: false, ...over,
});
const ctx = (over = {}) => ({
  profile: profile(), reference: 'openai/gpt-5.4', zdrKnown: true, zdrOnly: true, room: 4000,
  expiryMs: 30 * 86400000, at: Date.now(), minUptime: 99, ...over,
});

test('a thinking model with a tight answer cap is measured with its thinking off, or left out', () => {
  const capped = profile({ outCap: 180 });
  // thinks unless told otherwise, and can be told with effort none
  const a = thinkingFit(model('x/a', { reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['none', 'low'] } }), capped, 4000);
  assert.deepEqual(a.recipe, { reasoning: { effort: 'none' } });
  // says nothing about its default, which on production meant it thought: switched off another way
  const b = thinkingFit(model('x/b', { reasoning: { mandatory: false, supported_efforts: ['high', 'xhigh'], default_effort: 'high' } }), capped, 4000);
  assert.deepEqual(b.recipe, { reasoning: { enabled: false } });
  // cannot be told not to think: out
  const c = thinkingFit(model('x/c', { reasoning: { mandatory: true, default_enabled: true } }), capped, 4000);
  assert.equal(c.ok, false);
  assert.match(c.reason, /capped at 180 tokens/);
  // off unless asked: nothing to do
  const d = thinkingFit(model('x/d', { reasoning: { mandatory: false, default_enabled: false, default_effort: 'medium' } }), capped, 4000);
  assert.equal(d.recipe, null);
  const e = thinkingFit(model('x/e', { reasoning: { mandatory: false, default_effort: 'none' } }), capped, 4000);
  assert.equal(e.recipe, null);
  // no cap, or a roomy one: left to think
  assert.equal(thinkingFit(model('x/f', { reasoning: { mandatory: true } }), profile({ outCap: null }), 4000).ok, true);
  assert.equal(thinkingFit(model('x/g', { reasoning: { mandatory: true } }), profile({ outCap: 8000 }), 4000).ok, true);
  // a model that never thinks is untouched
  assert.equal(thinkingFit(model('x/h'), capped, 4000).recipe, null);
});

test('every rule that rules a model out says why, in words', () => {
  const at = Date.now();
  const cases = [
    [model('x/no-provider', { endpoints: [] }), ctx(), 'private', /keeps nothing/],
    [model('x/no-tools', { params: ['response_format'] }), ctx({ profile: profile({ tools: true }) }), 'features', /cannot call tools/],
    [model('x/no-schema', { params: ['tools'] }), ctx({ profile: profile({ json: 'schema' }) }), 'features', /JSON schema/],
    [model('x/no-json', { params: ['tools'] }), ctx({ profile: profile({ json: 'object' }) }), 'features', /asked for JSON/],
    [model('x/no-images'), ctx({ profile: profile({ images: true }) }), 'features', /images/],
    [model('x/short', { contextLen: 4000 }), ctx({ profile: profile({ promptMax: 5000 }) }), 'features', /can read 4,000 tokens/],
    [model('x/terse', { maxOutput: 100 }), ctx({ profile: profile({ outCap: 180 }) }), 'features', /writes at most 100 tokens/],
    [model('x/must-think', { reasoning: { mandatory: true } }), ctx({ profile: profile({ outCap: 180 }) }), 'thinking', /cannot be told not to/],
    [model('x/retiring', { expiresAt: at + 5 * 86400000 }), ctx({ at }), 'retiring', /retired soon/],
    [model('x/flaky', { endpoints: [ep({ uptime_1d: 92.8 })] }), ctx(), 'health', /92\.8%/],
    [model('x/down', { endpoints: [ep({ status: -5, uptime_1d: 99.5 })] }), ctx(), 'health', /reliably/],
  ];
  for (const [m, c, step, words] of cases) {
    const e = eligibility(m, c);
    assert.equal(e.ok, false, m.id);
    assert.equal(e.step, step, m.id);
    assert.match(e.reason, words, m.id);
  }
  // the customer's own model is never a candidate
  assert.equal(eligibility(model('openai/gpt-5.4'), ctx()).step, 'current');
  // with no list of private providers read yet, nobody is ruled out for want of one
  assert.equal(eligibility(model('x/unknown', { endpoints: [] }), ctx({ zdrKnown: false })).ok, true);
  // a healthy, capable model passes
  assert.equal(eligibility(model('x/fine'), ctx()).ok, true);
});

test('a price is the one actually charged: long prompts and hours of the week', () => {
  const tiered = { priceIn: 1e-6, priceOut: 2e-6, overrides: [{ min_prompt_tokens: 200000, prompt: 2e-6, completion: 4e-6 }] };
  assert.equal(callPrice(tiered, 1000, 100), 1e-6 * 1000 + 2e-6 * 100);
  assert.equal(callPrice(tiered, 250000, 100), 2e-6 * 250000 + 4e-6 * 100);
  // twice the price on weekdays 01:00 to 04:00 UTC: 15 of 168 hours
  const timed = {
    priceIn: 1e-6, priceOut: 1e-6,
    overrides: [{ utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], utc_start: 100, utc_end: 400, prompt: 2e-6, completion: 2e-6 }],
  };
  const flat = 1e-6 * 100;
  const blended = callPrice(timed, 50, 50);
  assert.ok(Math.abs(blended - flat * (1 + 15 / 168)) < 1e-12, `${blended}`);
  // a workload whose calls all arrive at 02:00 on a Tuesday pays the dear rate
  const hours = new Array(168).fill(0);
  hours[2 * 24 + 2] = 10;
  assert.ok(Math.abs(callPrice(timed, 50, 50, hours) - flat * 2) < 1e-12);
  // and one whose calls arrive on Sunday pays the cheap one
  const sunday = new Array(168).fill(0);
  sunday[3] = 5;
  assert.ok(Math.abs(callPrice(timed, 50, 50, sunday) - flat) < 1e-12);
});

test('a routed price follows OpenRouter: private providers only, the cheap ones weighted most', () => {
  const m = model('x/m', {
    priceIn: 1e-9, priceOut: 1e-9, // the headline, from a provider we are not allowed to use
    endpoints: [ep({ price_in: 1e-7, price_out: 1e-7 }), ep({ tag: 'q', price_in: 3e-7, price_out: 3e-7 })],
  });
  const p = routedCallPrice(m, 100, 100);
  const a = 2e-5;
  const b = 6e-5;
  const expected = (a / (a * a) + b / (b * b)) / (1 / (a * a) + 1 / (b * b));
  assert.ok(Math.abs(p - expected) < 1e-15, `${p} against ${expected}`);
  assert.ok(p < (a + b) / 2, 'nearer the cheaper provider than the middle');
  // an unhealthy provider is left out while a healthy one exists
  const n = model('x/n', { endpoints: [ep({ price_in: 1e-7, price_out: 1e-7 }), ep({ tag: 'bad', price_in: 1e-9, price_out: 1e-9, uptime_1d: 40 })] });
  assert.ok(Math.abs(routedCallPrice(n, 100, 100) - 2e-5) < 1e-15);
  // no private provider at all: no price we can pay
  assert.equal(routedCallPrice(model('x/none', { endpoints: [] }), 100, 100), null);
  // the best provider's figures describe the model
  const h = healthOf(model('x/h', { endpoints: [ep({ uptime_1d: 97, ttft_p50: 800 }), ep({ tag: 'q', uptime_1d: 99.9, ttft_p50: 400 })] }));
  assert.equal(h.bestUptime, 99.9);
  assert.equal(h.ttftP50, 400);
});

test('the chance of matching weighs what was measured over what was read', () => {
  const m = model('x/m');
  const none = chanceOf(m, { reference: 'openai/gpt-5.4' });
  assert.equal(none.chance, 0.3, 'no evidence at all is a plain 0.3');
  const own = new Map([['x/m', { verdict: 'cleared' }]]);
  const fits = new Map([['x/m', { fit: 0, label: 'Poor fit' }]]);
  const both = chanceOf(m, { reference: 'openai/gpt-5.4', history: { own, shape: new Map() }, fits });
  assert.ok(both.chance > 0.6, 'clearing on these very calls outweighs a poor reading of its description');
  const sibling = chanceOf(model('openai/gpt-4.1-nano'), { reference: 'openai/gpt-5.4' });
  assert.ok(sibling.chance > none.chance && sibling.family, 'a sibling of the customer model gets a lift');
  // the leaderboard: a model rated well below the customer's is less likely, more so on a hard task
  const arena = new Map([['x/m', 1300], ['openai/gpt-5.4', 1450]]);
  const easy = chanceOf(m, { reference: 'openai/gpt-5.4', arena, difficulty: 0 });
  const hard = chanceOf(m, { reference: 'openai/gpt-5.4', arena, difficulty: 1 });
  assert.ok(easy.chance > hard.chance, 'a routine task forgives a weaker model');
});

test('the ranking is by expected saving, at most two from one maker in front, the serving model first', () => {
  const models = new Map();
  const ref = model('openai/gpt-5.4', { endpoints: [ep({ price_in: 2.5e-6, price_out: 1.5e-5 })] });
  models.set(ref.id, ref);
  for (const [id, price] of [['m/a', 1e-7], ['m/b', 1.2e-7], ['m/c', 1.4e-7], ['n/d', 2e-7], ['o/e', 3e-6]]) {
    models.set(id, model(id, { endpoints: [ep({ price_in: price, price_out: price })] }));
  }
  const facts = { models, zdrKnown: true };
  const sel = selectCandidates({
    facts, profile: profile(), reference: 'openai/gpt-5.4', enabled: null, want: 2, tryMultiple: 3,
    serving: 'n/d', config, at: Date.now(),
  });
  assert.equal(sel.order[0].model, 'n/d', 'the model serving the workload is always checked again first');
  const vendors = sel.order.slice(1, 3).map((r) => r.model.split('/')[0]);
  assert.deepEqual(vendors, ['m', 'm'], 'two from one maker in front');
  assert.ok(sel.order.findIndex((r) => r.model === 'm/c') > sel.order.findIndex((r) => r.model === 'n/d'));
  // the dear one cannot save anything and is ruled out with the reason
  const dear = sel.excluded.find((e) => e.model === 'o/e');
  assert.equal(dear, undefined, 'o/e is cheaper than gpt-5.4 here, so it stays in');
  assert.equal(sel.funnel[0].left, 5, 'every switched-on model except the customer model');
  assert.ok(sel.order.length <= 6, 'at most three times the number wanted');
});

test('numbers are checked in code, and only when the two answers state the same count of them', () => {
  assert.deepEqual(numbersOf('The total is $1,234.50.'), ['1234.5']);
  assert.deepEqual(numbersOf('Total: USD 1234.50'), ['1234.5']);
  assert.deepEqual(numbersOf('Summe: 1.234,50 EUR'), ['1234.5']);
  assert.equal(numbersDiffer('The total is $1,234.50.', 'The total is $1,243.50.'), true);
  assert.equal(numbersDiffer('The total is $1,234.50.', 'Total: USD 1234.50'), false);
  assert.equal(numbersDiffer('You have 14 days.', 'You have 40 days.'), true);
  assert.equal(numbersDiffer('Fixed in 2.4.1', 'Fixed in 2.4.7'), true);
  // written differently, not different: left to the reading
  assert.equal(numbersDiffer('4 March 2026', '2026-03-04'), false);
  assert.equal(numbersDiffer('You have 30 days.', 'You have thirty days.'), false);
  assert.equal(numbersDiffer('2026-03-04', '2026-04-03'), false, 'a date with its parts swapped is the reading\'s to catch');
});

test('a paid answer is kept for its own workspace, whatever else is in the request', () => {
  const body = { model: 'openai/gpt-5.4', stream: true, user: 'u1', messages: [{ role: 'user', content: 'hi' }] };
  const same = { messages: [{ role: 'user', content: 'hi' }], model: 'anything', stream: false, user: 'u2' };
  assert.equal(replayKey('ws_1', body, 'x/m'), replayKey('ws_1', same, 'x/m'), 'streaming, the user field and the model named do not change the answer');
  assert.notEqual(replayKey('ws_1', body, 'x/m'), replayKey('ws_2', body, 'x/m'), 'never shared between workspaces');
  assert.notEqual(replayKey('ws_1', body, 'x/m', null, 0), replayKey('ws_1', body, 'x/m', null, 1), 'the two answers that set the bar are kept apart');
  assert.notEqual(replayKey('ws_1', body, 'x/m'), replayKey('ws_1', body, 'x/m', { reasoning: { effort: 'none' } }), 'thinking off is a different request');
  assert.notEqual(replayKey('ws_1', body, 'x/m'), replayKey('ws_1', { ...body, temperature: 0 }, 'x/m'), 'a setting that changes the answer changes the key');
});

test('leaderboard names are matched on their core', () => {
  assert.equal(core('openai/gpt-4.1-nano'), core('gpt-4.1-nano-2025-04-14'));
  assert.equal(core('google/gemini-3.7-flash'), 'gemini-3-7-flash');
  assert.equal(core('mistralai/mistral-small-3.2-24b-instruct'), core('mistral-small-3.2-24b-instruct'));
  assert.notEqual(core('openai/gpt-4.1-nano'), core('gpt-4.1-mini'));
});

test('a sample prefers calls already paid for, without changing its spread across answer lengths', () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, response_json: 'x'.repeat(i * 10) }));
  const plain = sampleCalls(calls, 12, 1);
  const paid = new Set(['c1', 'c2', 'c3', 'c11', 'c12', 'c13', 'c21', 'c22', 'c23', 'c31', 'c32', 'c33']);
  const preferring = sampleCalls(calls, 12, 1, paid);
  assert.equal(preferring.length, 12);
  assert.equal(preferring.filter((c) => paid.has(c.id)).length, 12, 'every paid call is used');
  const bands = (xs) => [0, 1, 2, 3].map((q) => xs.filter((c) => c.quartile === q).length);
  assert.deepEqual(bands(preferring), bands(plain), 'the same number from each length band');
});

test('a thinking model is asked to think the way the customer model does', () => {
  const plain = profile();
  const r = { mandatory: false, default_enabled: true, supported_efforts: ['none', 'low', 'high'], default_effort: 'high' };
  // the customer model answers straight away: this one is told not to think
  assert.deepEqual(thinkingFit(model('x/a', { reasoning: r }), plain, 4000, false).recipe, { reasoning: { effort: 'none' } });
  // not known yet is treated the same, and the measurement corrects it once it has timed the customer model
  assert.deepEqual(thinkingFit(model('x/a', { reasoning: r }), plain, 4000, null).recipe, { reasoning: { effort: 'none' } });
  // the customer model thinks too: left as it comes
  assert.equal(thinkingFit(model('x/a', { reasoning: r }), plain, 4000, true).recipe, null);
  // the customer's own requests say how much to think: sent as they are
  assert.equal(thinkingFit(model('x/a', { reasoning: r }), profile({ reasoningSet: true }), 4000, false).recipe, null);
  // has to think: as little as it allows
  const must = thinkingFit(model('x/b', { reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' } }), plain, 4000, false);
  assert.deepEqual(must.recipe, { reasoning: { effort: 'low' } });
  assert.equal(must.mustThink, true);
  assert.equal(recipeKind(must.recipe), 'light');
  // has to think and says nothing about how much: left as it comes
  assert.equal(thinkingFit(model('x/c', { reasoning: { mandatory: true } }), plain, 4000, false).recipe, null);
  // already at its lightest: nothing to change
  assert.equal(thinkingFit(model('x/d', { reasoning: { mandatory: true, supported_efforts: ['low', 'high'], default_effort: 'low' } }), plain, 4000, false).recipe, null);
  // a tight cap still decides first
  assert.deepEqual(thinkingFit(model('x/a', { reasoning: r }), profile({ outCap: 180 }), 4000, true).recipe, { reasoning: { effort: 'none' } });
  // a model that does not think by default is never touched
  assert.equal(thinkingFit(model('x/e', { reasoning: { mandatory: false, default_enabled: false } }), plain, 4000, false).recipe, null);
});

test('whether the customer model thinks is measured first and read second', () => {
  const gpt41 = model('openai/gpt-4.1');
  assert.equal(refThinksOf(gpt41), false, 'no reasoning block: answers straight away');
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: false, default_enabled: false, default_effort: 'medium' } })), false);
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: false, default_effort: 'high' } })), true);
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: true } })), true);
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: false } })), null, 'says nothing either way');
  assert.equal(refThinksOf(null), null, 'not in the catalogue');
  // what it did on the calls beats what its entry says
  assert.equal(refThinksOf(gpt41, { share: 0.9, n: 10 }), true);
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: true } }), { share: 0, n: 10 }), false);
  // two answers are too few to go on
  assert.equal(refThinksOf(gpt41, { share: 1, n: 2 }), false);
});

test('the chance of being quick enough comes from measurements first and published speeds second', () => {
  const sp = { factor: 1.5, metric: 'latency' };
  const base = { speed: sp, refHealth: healthOf(model('ref')), profile: profile({ refLatencyP50: 1400 }), config };
  const m = model('x/m');
  const hist = (latency, n = 4) => new Map([['x/m|default', { latency, ttft: latency, n }]]);
  const unknown = speedChanceOf(m, null, base);
  const fast = speedChanceOf(m, null, { ...base, speedHistory: hist(0.7) });
  const slow = speedChanceOf(m, null, { ...base, speedHistory: hist(3) });
  assert.ok(fast.p > unknown.p && unknown.p > slow.p, `${fast.p} ${unknown.p} ${slow.p}`);
  assert.ok(fast.p > 0.9, `measured quicker than the customer model: ${fast.p}`);
  assert.ok(slow.p < 0.2, `measured three times slower, four times over: ${slow.p}`);
  // one measurement is less sure than four
  assert.ok(speedChanceOf(m, null, { ...base, speedHistory: hist(3, 1) }).p > slow.p);
  // timings taken while it thought say nothing about it with its thinking off
  const off = speedChanceOf(m, { reasoning: { effort: 'none' } }, { ...base, speedHistory: hist(3) });
  assert.equal(off.measured, null);
  // when speed does not matter there is nothing to weigh
  assert.equal(speedChanceOf(m, null, { ...base, speed: { factor: null } }), null);
  // timed to the first word for streamed calls
  const ttft = speedChanceOf(m, null, { ...base, speed: { factor: 1.2, metric: 'ttft' }, speedHistory: new Map([['x/m|default', { latency: 0.8, ttft: 4, n: 4 }]]) });
  assert.ok(ttft.p < 0.2, 'a quick finish does not make up for a slow start');
});

test('a model likely to be too slow, or whose provider was busy lately, waits behind the rest', () => {
  const models = new Map();
  const ref = model('openai/gpt-5.4', { endpoints: [ep({ price_in: 2.5e-6, price_out: 1.5e-5 })] });
  models.set(ref.id, ref);
  for (const id of ['a/quick', 'b/slow', 'c/busy', 'd/plain']) models.set(id, model(id));
  const facts = { models, zdrKnown: true };
  const input = {
    facts, profile: profile({ refLatencyP50: 1400 }), reference: 'openai/gpt-5.4', enabled: null, want: 4, tryMultiple: 1,
    speed: { factor: 1.5, metric: 'latency' }, config, at: Date.now(),
    speedHistory: new Map([['a/quick|default', { latency: 0.8, n: 3 }], ['b/slow|default', { latency: 3.5, n: 3 }]]),
    busy: new Map([['c/busy', { n: 2, at: Date.now() }]]),
  };
  const order = selectCandidates(input).order.map((r) => r.model);
  assert.equal(order[0], 'a/quick');
  assert.ok(order.indexOf('b/slow') > order.indexOf('d/plain'), order.join(' '));
  assert.ok(order.indexOf('c/busy') > order.indexOf('d/plain'), order.join(' '));
  // with speed not mattering, a slow model is ranked on its answers and saving alone
  const any = selectCandidates({ ...input, speed: { factor: null }, busy: null }).order;
  const chances = new Set(any.map((r) => r.chance.toFixed(6)));
  assert.equal(chances.size, 1, 'the same price and the same evidence rank the same');
});

test('one slow call is never enough to call a model slow', () => {
  assert.equal(slowEndCount(3), 2);
  assert.equal(slowEndCount(6), 3);
  assert.equal(slowEndCount(12), 4);
  for (let n = 1; n <= 40; n += 1) assert.ok(slowEndCount(n) >= 2, `n=${n}`);
});

test('what a model can do is read from the providers every call has to use', () => {
  // the catalogue says it calls tools; its only providers that keep nothing do not
  const mini = model('openai/gpt-4o-mini', {
    endpoints: [ep({ params: ['response_format', 'structured_outputs'] }), ep({ tag: 'q', params: ['response_format'] })],
  });
  const e = eligibility(mini, ctx({ profile: profile({ tools: true }) }));
  assert.equal(e.ok, false);
  assert.equal(e.step, 'features');
  assert.match(e.reason, /cannot call tools at any provider that keeps nothing/);
  // one private provider that can is enough, and only that one is priced and timed
  const some = model('x/some', {
    endpoints: [ep({ params: ['response_format'], price_in: 1e-9, price_out: 1e-9 }), ep({ tag: 'q', params: ['tools', 'response_format'] })],
  });
  const ok = eligibility(some, ctx({ profile: profile({ tools: true }) }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.routes.map((r) => r.tag), ['q']);
  // a shorter context at the private provider than in the catalogue
  const short = model('x/short-private', { contextLen: 131072, endpoints: [ep({ context_len: 40960, params: ['tools'] })] });
  const s = eligibility(short, ctx({ profile: profile({ promptMax: 60000 }) }));
  assert.equal(s.ok, false);
  assert.match(s.reason, /can read 40,960 tokens at any provider that keeps nothing/);
  // hearing is not seeing
  const eyes = model('x/eyes', { inputs: ['text', 'image'] });
  assert.equal(eligibility(eyes, ctx({ profile: profile({ inputs: ['audio'] }) })).step, 'features');
  assert.equal(eligibility(eyes, ctx({ profile: profile({ inputs: ['image'] }) })).ok, true);
});

test('the model serving a workload is always measured again, whatever it costs now', () => {
  const models = new Map();
  const ref = model('openai/gpt-5.4', { endpoints: [ep({ price_in: 1e-7, price_out: 1e-7 })] });
  models.set(ref.id, ref);
  // dearer than the customer's model now, switched off in Models, and set aside before
  models.set('x/serving', model('x/serving', { endpoints: [ep({ price_in: 5e-7, price_out: 5e-7 })] }));
  models.set('x/cheap', model('x/cheap', { endpoints: [ep({ price_in: 1e-8, price_out: 1e-8 })] }));
  const sel = selectCandidates({
    facts: { models, zdrKnown: true }, profile: profile(), reference: 'openai/gpt-5.4', enabled: new Set(['x/cheap']),
    want: 2, serving: 'x/serving', reverted: new Set(['x/serving']), config, at: Date.now(),
  });
  assert.equal(sel.order[0].model, 'x/serving');
  assert.ok(sel.order.some((r) => r.model === 'x/cheap'));
});

test('a customer model the catalogue cannot price is priced from what its calls cost', () => {
  const models = new Map([['x/cheap', model('x/cheap', { endpoints: [ep({ price_in: 1e-8, price_out: 1e-8 })] })],
    ['x/dear', model('x/dear', { endpoints: [ep({ price_in: 1e-5, price_out: 1e-5 })] })]]);
  const sel = selectCandidates({
    facts: { models, zdrKnown: true }, profile: profile({ refCostPerCall: 1e-4 }), reference: 'someone/unlisted',
    enabled: null, want: 2, config, at: Date.now(),
  });
  assert.deepEqual(sel.order.map((r) => r.model), ['x/cheap']);
  assert.equal(sel.excluded.find((e) => e.model === 'x/dear')?.step, 'price');
});

test('on at an effort of none is off, and the customer saying so decides', () => {
  const gpt51 = model('openai/gpt-5.1', { reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['high', 'none'], default_effort: 'none' } });
  assert.equal(refThinksOf(gpt51), false);
  assert.equal(thinkingFit(gpt51, profile(), 4000, false).recipe, null, 'nothing to switch off');
  assert.equal(refThinksOf(model('openai/gpt-4.1'), null, 'on'), true);
  assert.equal(refThinksOf(model('x/r', { reasoning: { mandatory: true } }), { share: 1, n: 9 }, 'off'), false);
});

test('the live watch switches back on clear evidence only', () => {
  assert.equal(failingClearly(2, 20, 0), false, 'two failures in twenty is a blip, not a pattern');
  assert.equal(failingClearly(4, 20, 0), false, 'still fewer than five');
  assert.equal(failingClearly(8, 40, 0), true, 'eight in forty against a clean record is');
  assert.equal(failingClearly(5, 100, 0.04), false, 'five in a hundred is what it did before');
  assert.equal(failingClearly(12, 100, 0.04), true, 'three times the rate before is not chance');
  assert.ok(tailAtLeast(0, 10, 0.5) === 1 && tailAtLeast(11, 10, 0.5) === 0);
  assert.ok(Math.abs(tailAtLeast(1, 3, 0.5) - 0.875) < 1e-12);
});

test('a request says whether to think only when it says so', () => {
  assert.equal(thinkingAsked({ reasoning: { enabled: false } }), 'off');
  assert.equal(thinkingAsked({ reasoning_effort: 'none' }), 'off');
  assert.equal(thinkingAsked({ reasoning: { effort: 'low' } }), 'on');
  assert.equal(thinkingAsked({ reasoning: { max_tokens: 2000 } }), 'on');
  assert.equal(thinkingAsked({ reasoning: { exclude: true } }), null, 'hiding the notes is not a thinking setting');
  assert.equal(thinkingAsked({ include_reasoning: false }), null);
  const rows = (bodies) => bodies.map((b, i) => ({ request_json: JSON.stringify(b), created_at: Date.now() - i, status_code: 200 }));
  const w = { id: 'wl_x', slug: 'x', shape_kind: 'free_text', reference_model: 'm/ref' };
  assert.equal(profileFromRows(w, rows([{ reasoning: { exclude: true } }, {}])).reasoningSet, false);
  assert.equal(profileFromRows(w, rows([{ reasoning: { effort: 'high' } }])).reasoningSet, true);
  assert.equal(profileFromRows(w, rows([{ reasoning: { enabled: false } }])).thinking, 'off');
  assert.equal(profileFromRows(w, rows([{ reasoning: { enabled: false } }, { reasoning: { effort: 'high' } }])).thinking, 'mixed');
  // what a request sends besides text, each kind on its own
  const audio = profileFromRows(w, rows([{ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }]));
  assert.deepEqual(audio.inputs, ['audio']);
  assert.equal(audio.images, false);
  // the key Jev's readings are kept under does not move with every new call
  const k1 = profileFromRows(w, rows([{ messages: [{ role: 'user', content: 'a' }] }])).taskKey;
  const k2 = profileFromRows(w, rows([{ messages: [{ role: 'user', content: 'b' }] }, { messages: [{ role: 'user', content: 'a' }] }])).taskKey;
  assert.equal(k1, k2);
});

test('price windows that end at midnight, or name no days, are read', () => {
  const hy3 = { priceIn: 1.32e-7, priceOut: 0, overrides: [
    { utc_start: 0, utc_end: 1600, prompt: '0.000000132', completion: '0' },
    { utc_start: 1600, utc_end: 0, prompt: '0.0000000825', completion: '0' }] };
  const at = (day, hour) => { const h = new Array(168).fill(0); h[day * 24 + hour] = 1; return h; };
  assert.ok(Math.abs(callPrice(hy3, 1e6, 0, at(1, 20)) - 0.0825) < 1e-9, 'evening, every day');
  assert.ok(Math.abs(callPrice(hy3, 1e6, 0, at(4, 9)) - 0.132) < 1e-9, 'morning');
  const wrap = { priceIn: 1e-6, priceOut: 0, overrides: [{ utc_days: ['monday'], utc_start: 2200, utc_end: 200, prompt: '0.0000005', completion: '0' }] };
  assert.ok(Math.abs(callPrice(wrap, 1e6, 0, at(1, 23)) - 0.5) < 1e-9, 'a window past midnight');
  assert.ok(Math.abs(callPrice(wrap, 1e6, 0, at(1, 12)) - 1) < 1e-9);
});

