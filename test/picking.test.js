/* Choosing which models to measure: the pure parts, with inputs built by hand so every answer
   can be checked without a database, a provider or a penny spent. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
const { thinkingFit, eligibility, chanceOf, selectCandidates } = await import('../src/eval/select.js');
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
