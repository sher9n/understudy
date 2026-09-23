/* Strategies, the pure parts: what a cascade or a router would have done on measured calls, the
   check's shape rules, the router's small model, and how strategies are named. Nothing here calls
   a model or a database. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.ALERTS_ENABLED = 'false';

const { simulateCascade, simulateRouter, bestOf } = await import('../src/learn/simulate.js');
const { structureOf } = await import('../src/learn/check.js');
const { featuresOf, train, predict, leaveOneOut } = await import('../src/learn/router.js');
const { armKey, labelOf, leadModel, nameOfResult } = await import('../src/learn/arms.js');
const { keyOfSpec } = await import('../src/eval/promote.js');
const { selectCandidates } = await import('../src/eval/select.js');
const { default: config } = await import('../src/config.js');

const ref = { cost: 0.002, latency: 1000, ttft: 800, noise: 0 };
// ten calls: the cheap model is right on eight, and Jev is sure of those and doubtful of the rest
const calls = Array.from({ length: 10 }, (_, i) => ({
  ok: true, score: i < 8 ? 0 : 1, cost: 0.0002, latency: 400, ttft: 300,
  check: { structureOk: true, p: i < 8 ? 0.95 : 0.2 }, ref,
}));

test('a cascade keeps the cheap answers the check is sure of, and sends the rest on', () => {
  const [at50, , , at80] = simulateCascade(calls, { thresholds: [0.5, 0.6, 0.7, 0.8], checkCost: () => 0.00001, checkMs: () => 300 });
  assert.equal(at80.escalated, 0.2, 'the two doubtful answers go to the customer model');
  assert.equal(at80.gap, 0, 'and what the customer gets matches on every call');
  // cheap on all ten, a check on all ten, and the customer's model on two
  const cost = 10 * 0.0002 + 10 * 0.00001 + 2 * 0.002;
  assert.ok(Math.abs(at80.cost - cost) < 1e-12, `${at80.cost}`);
  assert.ok(Math.abs(at80.ratio - cost / (10 * 0.002)) < 1e-12);
  assert.deepEqual(at80.latency.slice(0, 1), [700], 'a kept answer waits for the check');
  assert.deepEqual(at80.latency.slice(-1), [1700], 'a sent-on answer waits for both calls and the check');
  assert.equal(at50.escalated, 0.2, 'the doubtful answers are below every threshold here');
  // a cheap model that failed outright is sent on, and its failed attempt cost nothing
  const failed = simulateCascade([{ ok: false, score: 1, cost: 0, latency: 50, check: { structureOk: false, p: 0 }, ref }], { thresholds: [0.8] })[0];
  assert.equal(failed.escalated, 1);
  assert.equal(failed.cost, 0.002);
});

test('the kept strictness is the cheapest inside the bar, and only if it is quick enough', () => {
  const readings = [
    { threshold: 0.5, gap: 6, ratio: 0.2, latency: [1], ttft: [1] },
    { threshold: 0.7, gap: 2, ratio: 0.3, latency: [1], ttft: [1] },
    { threshold: 0.9, gap: 1, ratio: 0.5, latency: [1], ttft: [1] },
  ];
  assert.equal(bestOf(readings, { floor: 3 }).threshold, 0.7);
  assert.equal(bestOf(readings, { floor: 3 }).inside, true);
  assert.equal(bestOf(readings, { floor: 3, fast: (r) => r.threshold === 0.9 }).threshold, 0.9);
  const none = bestOf(readings, { floor: 0.5 });
  assert.equal(none.inside, false);
  assert.equal(none.threshold, 0.9, 'the closest to the bar, to show how near it came');
});

test('a router that sends a call to a cheap model that fails it gets the failure, with nothing to catch it', () => {
  const failing = [
    { ok: false, score: 1, cost: 0, latency: 50, p: 0.9, ref },
    { ok: true, score: 0, cost: 0.0002, latency: 400, p: 0.9, ref },
  ];
  const r = simulateRouter(failing, { thresholds: [0.5] })[0];
  assert.equal(r.gap, 50, 'the failed call counts as a miss, not as sent on for free');
  assert.equal(r.escalated, 0);
  assert.ok(Math.abs(r.cost - 0.0002) < 1e-12);
});

test('a cascade whose answers are inside the bar but too slow is slow, not missed', () => {
  const slow = bestOf([{ threshold: 0.5, gap: 1, ratio: 0.3, latency: [9000], ttft: [9000] }], { floor: 3, fast: () => false });
  assert.equal(slow.inside, true);
  assert.equal(slow.slow, true);
  // near the bar, the most careful reading is kept, not the cheapest
  const near = bestOf([
    { threshold: 0.5, gap: 3.6, ratio: 0.2, latency: [1], ttft: [1] },
    { threshold: 0.9, gap: 3.1, ratio: 0.4, latency: [1], ttft: [1] },
  ], { floor: 3 });
  assert.equal(near.near, true);
  assert.equal(near.threshold, 0.9);
});

test('a router sends the calls its small model trusts to the cheap model', () => {
  const rcalls = calls.map((c, i) => ({ ...c, p: i < 8 ? 0.9 : 0.1 }));
  const r = simulateRouter(rcalls, { thresholds: [0.5] })[0];
  assert.equal(r.escalated, 0.2);
  assert.equal(r.gap, 0);
  assert.ok(Math.abs(r.cost - (8 * 0.0002 + 2 * 0.002)) < 1e-12, 'no check and no second call');
});

test('the small model learns which calls a cheap model gets wrong', () => {
  // wrong exactly on the long questions
  const body = (long) => ({ messages: [{ role: 'user', content: long ? 'x'.repeat(900) : 'short question' }] });
  const samples = Array.from({ length: 40 }, (_, i) => ({ x: featuresOf(body(i % 4 === 0)), y: i % 4 === 0 ? 0 : 1 }));
  const m = train(samples);
  assert.ok(predict(m, featuresOf(body(false))) > 0.8);
  assert.ok(predict(m, featuresOf(body(true))) < 0.2);
  const loo = leaveOneOut(samples);
  const right = loo.filter((p, i) => (p >= 0.5 ? 1 : 0) === samples[i].y).length;
  assert.ok(right >= 38, `${right} of 40 predicted right on calls it did not learn from`);
});

test('the shape check: fields, labels, tools and their arguments', () => {
  const answer = (content, tool_calls) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, tool_calls } }] });
  const schema = { response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', required: ['label'], properties: { label: { enum: ['urgent', 'normal'] } } } } } };
  assert.equal(structureOf(schema, answer('{"label":"urgent"}'), 'enum').ok, true);
  assert.equal(structureOf(schema, answer('{"label":"soon"}'), 'enum').reason, 'gave a label that is not one of the choices');
  assert.equal(structureOf(schema, answer('{"other":1}'), 'json').reason, 'left out a field the request asked for');
  assert.equal(structureOf(schema, answer('not json'), 'json').ok, false);
  const tools = { tools: [{ type: 'function', function: { name: 'refund', parameters: { required: ['order'] } } }] };
  const call = (name, args) => answer(null, [{ id: 'c', type: 'function', function: { name, arguments: args } }]);
  assert.equal(structureOf(tools, call('refund', '{"order":7}'), 'tool_call').ok, true);
  assert.equal(structureOf(tools, call('cancel', '{"order":7}'), 'tool_call').reason, 'called a tool that does not exist');
  assert.equal(structureOf(tools, call('refund', '{}'), 'tool_call').reason, 'left out an argument the tool needs');
});

test('strategies have one name each, in words and as a key', () => {
  const cascade = { kind: 'cascade', first: { model: 'google/gemma-4-31b-it', recipe: null }, fallback: { model: 'openai/gpt-4.1', recipe: null }, threshold: 0.8 };
  assert.equal(labelOf(cascade), 'gemma-4-31b-it, checked, gpt-4.1 when unsure');
  assert.equal(keyOfSpec(cascade, 'openai/gpt-4.1'), 'cascade:google/gemma-4-31b-it');
  assert.equal(armKey(cascade), armKey({ ...cascade, threshold: 0.9 }), 'the same strategy, found again at another strictness, is the same arm');
  assert.equal(leadModel(cascade).model, 'google/gemma-4-31b-it');
  const lighter = { kind: 'model', model: 'openai/gpt-5.4', recipe: { reasoning: { effort: 'none' } } };
  assert.equal(labelOf(lighter, 'openai/gpt-5.4'), 'gpt-5.4, thinking less');
  assert.equal(keyOfSpec(lighter, 'openai/gpt-5.4'), 'openai/gpt-5.4#lighter');
  assert.equal(keyOfSpec({ kind: 'model', model: 'm/x', recipe: null }, 'openai/gpt-5.4'), 'm/x');
  const router = { kind: 'router', cheap: { model: 'm/cheap' }, strong: { model: 'openai/gpt-4.1' } };
  assert.equal(labelOf(router), 'cheap or gpt-4.1, picked call by call');
});

test('the customer\'s own model from its cheapest provider is named as that, never as thinking less', () => {
  const REF = 'openai/gpt-5.4';
  const row = (spec) => ({ model_id: keyOfSpec(spec, REF), arm_json: JSON.stringify(spec) });
  const cheapest = { kind: 'model', model: REF, recipe: { providers: ['azure'], pinned: true } };
  assert.equal(keyOfSpec(cheapest, REF), `${REF}#cheapest`);
  assert.deepEqual(nameOfResult(row(cheapest)), { kind: 'cheapest', label: 'gpt-5.4, from its cheapest provider',
    short: 'gpt-5.4, cheapest provider', first: REF });
  assert.equal(labelOf(cheapest, REF), 'gpt-5.4, from its cheapest provider');
  // the lightest thinking a model offers can be "medium", and that is still thinking less
  const medium = { kind: 'model', model: REF, recipe: { reasoning: { effort: 'medium' } } };
  assert.equal(nameOfResult(row(medium)).kind, 'lighter');
  assert.equal(nameOfResult(row(medium)).label, 'gpt-5.4, thinking less');
  assert.equal(labelOf(medium, REF), 'gpt-5.4, thinking less', 'not "(yours)", which reads as the customer\'s own model unchanged');
  assert.equal(nameOfResult(row({ kind: 'model', model: REF, recipe: { reasoning: { enabled: false } } })).kind, 'lighter');
  // a plain model, and a result with no strategy of its own
  assert.equal(nameOfResult({ model_id: 'm/x', arm_json: JSON.stringify({ kind: 'model', model: 'm/x', recipe: null }) }).kind, 'model');
  assert.deepEqual(nameOfResult({ model_id: 'vendor/steady-small', arm_json: null }), { kind: 'model', label: 'vendor/steady-small', short: 'steady-small' });
});

test('the customer model thinking less is offered when it thinks, and only then', () => {
  const ep = { tag: 'p', provider: 'P', price_in: 2e-6, price_out: 8e-6, overrides: null, status: 0, uptime_1d: 99.9, uptime_30m: 100, ttft_p50: 500, tps_p50: 60 };
  const model = (id, over = {}) => ({ id, name: id, priceIn: 2e-6, priceOut: 8e-6, params: ['max_tokens'], inputs: ['text'], contextLen: 128000,
    maxOutput: 16000, reasoning: null, endpoints: [ep], ...over });
  const thinker = model('x/thinker', { reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['high', 'none'], default_effort: 'high' } });
  const cheap = model('y/cheap', { priceIn: 1e-8, priceOut: 1e-8, endpoints: [{ ...ep, price_in: 1e-8, price_out: 1e-8 }] });
  const models = new Map([[thinker.id, thinker], [cheap.id, cheap]]);
  const profile = { tools: false, toolChoice: false, json: 'none', inputs: [], outCap: null, promptAvg: 100, promptMax: 300, outAvg: 200, outP50: 200, outP95: 400, hours: null };
  const base = { facts: { models, zdrKnown: true }, profile, reference: 'x/thinker', enabled: null, want: 3, config, at: Date.now() };
  const thinks = selectCandidates({ ...base, refThinks: true }).order;
  const lighter = thinks.find((r) => r.key === 'x/thinker#lighter');
  assert.ok(lighter, 'offered');
  assert.deepEqual(lighter.recipe, { reasoning: { effort: 'none' } });
  assert.equal(lighter.model, 'x/thinker', 'the same model, asked differently');
  const plain = selectCandidates({ ...base, refThinks: false }).order;
  assert.equal(plain.find((r) => r.key), undefined, 'a model that answers straight away has nothing to think less about');
  // already on the lightest setting it offers, below "none": there is nothing lighter to ask for
  const minimal = model('x/thinker', { reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['minimal', 'low'], default_effort: 'minimal' } });
  const onMinimal = selectCandidates({ ...base, facts: { models: new Map([[minimal.id, minimal], [cheap.id, cheap]]), zdrKnown: true }, refThinks: true }).order;
  assert.equal(onMinimal.find((r) => r.key), undefined, '"low" would be more thinking, not less');
  // and never again once it was switched back
  const back = selectCandidates({ ...base, refThinks: true, reverted: new Set(['x/thinker#lighter']) }).order;
  assert.equal(back.find((r) => r.key), undefined);
});
