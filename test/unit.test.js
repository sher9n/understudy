import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf, shapeOf, normalizeSystem, nameFor } from '../src/classify.js';
import { extract, disagreement, gates, floorFrom, verdictFor, sampleCalls, canonical, barIsMeaningful } from '../src/eval/compare.js';

const call = (system, extra = {}) => ({
  model: 'openai/gpt-5.4',
  messages: [{ role: 'system', content: system }, { role: 'user', content: 'anything' }],
  ...extra,
});

test('the same job with different data is one workload', () => {
  const a = signatureOf(call('Extract the line items from invoice 88213 dated 2026-01-04.'));
  const b = signatureOf(call('Extract the line items from invoice 99117 dated 2026-06-22.'));
  assert.equal(a.fingerprint, b.fingerprint);
});

test('a different job is a different workload', () => {
  const a = signatureOf(call('Extract the line items.'));
  const b = signatureOf(call('Write a friendly reply to this customer.'));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('tools and schemas separate workloads that share a prompt', () => {
  const plain = signatureOf(call('Do the thing.'));
  const tooled = signatureOf(call('Do the thing.', {
    tools: [{ type: 'function', function: { name: 'extract_line_items' } }],
  }));
  assert.notEqual(plain.fingerprint, tooled.fingerprint);
  assert.equal(tooled.shapeKind, 'tool_call');
});

test('normalising strips the data and keeps the template', () => {
  assert.equal(normalizeSystem('Order 12345 for "Acme" at https://x.io'), 'order n for str at url');
});

test('shape is read from the request, not guessed', () => {
  assert.equal(shapeOf(call('x')), 'free_text');
  assert.equal(shapeOf(call('x', { response_format: { type: 'json_object' } })), 'json');
  assert.equal(shapeOf(call('x', {
    response_format: { type: 'json_schema', json_schema: { schema: { properties: { label: { enum: ['a', 'b'] } } } } },
  })), 'enum');
});

test('a workload is named from the call itself', () => {
  assert.equal(nameFor(signatureOf(call('x', {
    tools: [{ type: 'function', function: { name: 'extract_line_items' } }],
  }))), 'extract-line-items');
});

test('key order never counts as a difference', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

const ok = (v) => ({ ok: true, value: v });

test('disagreement is measured field by field', () => {
  assert.equal(disagreement(ok({ a: 1, b: 2 }), ok({ a: 1, b: 2 }), 'json'), 0);
  assert.equal(disagreement(ok({ a: 1, b: 2 }), ok({ a: 1, b: 3 }), 'json'), 0.5);
  assert.equal(disagreement(ok({ a: 1, b: 2 }), ok({ a: 9, b: 9 }), 'json'), 1);
});

test('a failure counts as total disagreement, it is never skipped', () => {
  assert.equal(disagreement({ ok: false }, ok({ a: 1 }), 'json'), 1);
  assert.equal(disagreement(ok({ a: 1 }), { ok: false }, 'json'), 1);
});

test('a truncated answer is a failure, not a near miss', () => {
  const r = extract({ choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] }, 'json');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'truncated');
});

test('unparseable json is a failure', () => {
  assert.equal(extract({ choices: [{ message: { content: 'not json' } }] }, 'json').ok, false);
});

test('a fenced json answer still parses', () => {
  const r = extract({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }, 'json');
  assert.deepEqual(r.value, { a: 1 });
});

test('the bar never drops below its minimum, however quiet the model is', () => {
  assert.equal(floorFrom(0, { multiple: 1.25, minPct: 3 }), 3);
  assert.equal(floorFrom(8, { multiple: 1.25, minPct: 3 }), 10);
});

test('a verdict needs enough runs before it means anything', () => {
  const opts = { minRuns: 100, reviewBand: 1.25 };
  assert.equal(verdictFor(1, 3, 12, opts), 'insufficient');
  assert.equal(verdictFor(1, 3, 120, opts), 'cleared');
  assert.equal(verdictFor(3.5, 3, 120, opts), 'review');
  assert.equal(verdictFor(9, 3, 120, opts), 'missed');
});

test('gates are computed from the pairs, not from the gap alone', () => {
  const pairs = [
    { cand: ok({ a: 1 }), ref: ok({ a: 1 }), score: 0 },
    { cand: { ok: false }, ref: ok({ a: 1 }), score: 1 },
  ];
  const g = gates(pairs, 'json');
  assert.equal(g.structure, 0.5);
  assert.equal(g.accuracy, 0.5);
  assert.equal(g.complete, 0.5);
});

test('sampling is seeded, stratified, and repeatable', () => {
  const calls = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, response_json: 'x'.repeat(i) }));
  const a = sampleCalls(calls, 40);
  const b = sampleCalls(calls, 40);
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(a.length, 40);
  assert.equal(new Set(a.map((c) => c.quartile)).size, 4);
});

test('a workload name skips filler words', () => {
  const sig = signatureOf(call('Extract the line items from invoice 88213.'));
  assert.equal(nameFor(sig), 'extract-line-items');
  const sig2 = signatureOf(call('Write a friendly reply to this customer, in our house tone.'));
  assert.equal(nameFor(sig2), 'write-friendly-reply');
});

test('a bar is only meaningful while the reference agrees with itself', () => {
  assert.equal(barIsMeaningful(2.8, 40), true);
  assert.equal(barIsMeaningful(40, 40), true);
  assert.equal(barIsMeaningful(41, 40), false);
  // the case that bit: the reference never produced a usable answer, so the bar was 125%
  assert.equal(barIsMeaningful(100, 40), false);
});
