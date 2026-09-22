/* How calls turn out: read from the traffic that follows them, and reported by the customer.
   Calls are recorded here exactly as the proxy records them, with requests and answers made by
   hand, so nothing is sent to any model and nothing is spent. */

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_outcomes_${process.pid}`;
const adminUrl = new URL(ADMIN);
adminUrl.pathname = '/postgres';
{
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
}
const testUrl = new URL(ADMIN);
testUrl.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = testUrl.toString();
process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.ALERTS_ENABLED = 'false';
process.env.OPENROUTER_API_KEY = 'test-key';

const { db } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { onFollowUp, report, saveDef, rewardOf, defOf } = await import('../src/learn/outcomes.js');
const { outcomeSummary, tasksFor } = await import('../src/learn/views.js');
const { toolFailed, beforeHash, afterHash, requestHash, problemsIn, refOf } = await import('../src/learn/threads.js');

await migrate({ quiet: true });

test.after(async () => {
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

let n = 0;
async function space() {
  n += 1;
  const { workspace } = await createAccount({ email: `out-${n}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `o${n}` });
  return workspace.id;
}
const answer = (content, extra = {}) => ({ id: 'gen', model: 'm', choices: [{ index: 0, finish_reason: extra.finish || 'stop', message: { role: 'assistant', content, ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } });
async function call(ws, request, response, extra = {}) {
  const workload = await workloadFor(ws, request);
  const id = await recordCall({
    workspaceId: ws, workloadId: workload.id, source: 'routed', requestedModel: request.model, servedModel: request.model,
    statusCode: 200, promptTokens: 10, completionTokens: 5, costUsd: 0.0001, chargedUsd: 0.000101, latencyMs: 400,
    request, response, ...extra,
  });
  await learningSettled();
  return { id, workload };
}
const get = async (id) => db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
const outcomesOf = async (id) => (await db.prepare('SELECT kind, event, value FROM outcomes WHERE call_id = ? ORDER BY kind').all(id));

test('the fingerprints: a follow-up starts where the call before it ended, whatever the spacing', () => {
  const first = [{ role: 'system', content: 'Help.' }, { role: 'user', content: 'Find order 4.' }];
  const said = { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'lookup', arguments: '{"id":4}' } }] };
  // the client echoes the tool call back with other spacing and another id, and adds the result
  const next = [...first, { role: 'assistant', content: '', tool_calls: [{ id: 'zz', type: 'function', function: { name: 'lookup', arguments: '{ "id": 4 }' } }] },
    { role: 'tool', tool_call_id: 'zz', content: '{"error":"not found"}' }];
  assert.equal(beforeHash(next), afterHash(first, said));
  assert.equal(beforeHash(first), null, 'a first turn continues nothing');
  assert.equal(requestHash({ model: 'a', messages: first, stream: true }), requestHash({ model: 'b', messages: first }), 'the same request to another model, streamed or not');
  assert.notEqual(requestHash({ messages: first }), requestHash({ messages: first, temperature: 0.2 }));
});

test('a tool result says whether the tool worked, read conservatively', () => {
  assert.equal(toolFailed('{"error":"not found"}'), true);
  assert.equal(toolFailed('{"ok":false,"reason":"timeout"}'), true);
  assert.equal(toolFailed('{"status":"failed"}'), true);
  assert.equal(toolFailed('Error: connection refused'), true);
  assert.equal(toolFailed('404 Not Found'), true);
  assert.equal(toolFailed('{"error":null,"rows":[1,2]}'), false);
  assert.equal(toolFailed('Found 3 log lines mentioning error'), false, 'mentioning an error is not being one');
  assert.equal(toolFailed('{"items":[]}'), false);
  assert.deepEqual(problemsIn({ response_format: { type: 'json_object' } }, answer('not json at all')), ['broken']);
  assert.deepEqual(problemsIn({}, answer('I can\'t help with that.')), ['refused']);
  assert.deepEqual(problemsIn({}, answer('The capital is Canberra', { finish: 'length' })), ['cut_off']);
  assert.deepEqual(problemsIn({ response_format: { type: 'json_object' } }, answer('```json\n{"a":1}\n```')), [], 'fenced JSON is still JSON');
  assert.equal(refOf({ 'x-understudy-ref': 'ticket-9' }, {}), 'ticket-9');
  assert.equal(refOf({}, { metadata: { ref: 42 } }), '42');
  assert.equal(refOf({}, {}), null);
});

test('the same request sent again straight away marks the first answer as not used', async () => {
  const ws = await space();
  const req = { model: 'openai/gpt-4.1', messages: [{ role: 'system', content: 'Summarise the ticket.' }, { role: 'user', content: 'Ticket 1: printer on fire.' }] };
  const a = await call(ws, req, answer('A printer is on fire.'));
  const b = await call(ws, req, answer('The printer is burning.'));
  assert.deepEqual(await outcomesOf(a.id), [{ kind: 'retry', event: '', value: 0 }]);
  assert.equal((await get(a.id)).reward, 0);
  assert.equal((await get(b.id)).reward, null, 'the second answer is not known either way yet');
});

test('a tool loop becomes one task, and a failing tool marks the step that called it', async () => {
  const ws = await space();
  const sys = { role: 'system', content: 'You are an order assistant with tools.' };
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'number' } } } } }];
  const r1 = { model: 'openai/gpt-4.1', tools, messages: [sys, { role: 'user', content: 'Where is order 4?' }] };
  const said = [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"id":4}' } }];
  const s1 = await call(ws, r1, answer(null, { tool_calls: said, finish: 'tool_calls' }));
  const r2 = { ...r1, messages: [...r1.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{ "id": 4 }' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"error":"order service unavailable"}' }] };
  const s2 = await call(ws, r2, answer('Sorry, I could not look that up just now.'));
  const second = await get(s2.id);
  assert.equal(second.parent_call_id, s1.id, 'the second step continues the first');
  assert.equal(second.task_id, s1.id);
  assert.equal(second.step, 2);
  assert.deepEqual(await outcomesOf(s1.id), [{ kind: 'tool_error', event: '', value: 0 }]);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(s1.id);
  assert.equal(task.steps, 2);
  assert.equal(task.tool_calls, 1);
  assert.equal(task.tool_errors, 1);
  assert.ok(Math.abs(task.cost_usd - 0.000202) < 1e-9, `${task.cost_usd}`);
  // the page's reading of it: one task of two steps, the failing tool named on the step that called it
  const seen = await tasksFor(s1.workload.id);
  assert.equal(seen.overall.tasks, 1);
  assert.equal(seen.recent[0].detail.length, 2);
  assert.deepEqual(seen.recent[0].detail[0].tools, ['lookup']);
  assert.match(seen.recent[0].detail[0].why.join(' '), /called a tool that then failed/);
  const summary = await outcomeSummary(s1.workload.id);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.signals.map((x) => x.kind), ['tool_error']);
});

test('an answer that is not the JSON asked for is a failure at once', async () => {
  const ws = await space();
  const req = { model: 'openai/gpt-4.1', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Extract as JSON.' }, { role: 'user', content: 'Invoice 7, total 12.' }] };
  const c = await call(ws, req, answer('Sure! The total is 12.'));
  assert.deepEqual(await outcomesOf(c.id), [{ kind: 'broken', event: '', value: 0 }]);
  assert.equal((await get(c.id)).reward, 0);
});

test('a person\'s reply after an answer is sent to be read, with the answer beside it', async () => {
  const ws = await space();
  const seen = [];
  onFollowUp(async (p) => { seen.push(p); });
  const r1 = { model: 'openai/gpt-4.1', messages: [{ role: 'system', content: 'You answer billing questions.' }, { role: 'user', content: 'Why was I charged twice?' }] };
  const c1 = await call(ws, r1, answer('You were charged once; the second line is a hold.'));
  const r2 = { ...r1, messages: [...r1.messages, { role: 'assistant', content: 'You were charged once; the second line is a hold.' }, { role: 'user', content: 'No, that is wrong, both charges went through.' }] };
  await call(ws, r2, answer('Apologies, let me check again.'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].callId, c1.id);
  assert.match(seen[0].reply, /that is wrong/);
  assert.match(seen[0].answer, /charged once/);
  onFollowUp(null);
});

test('an outcome reported by reference waits for a meaning, and then decides', async () => {
  const ws = await space();
  const req = { model: 'openai/gpt-4.1', messages: [{ role: 'system', content: 'Draft a reply to the customer.' }, { role: 'user', content: 'Ticket 88: refund please.' }] };
  const c = await call(ws, req, answer('We have issued your refund.'), { ref: 'ticket-88' });
  const first = await report(ws, [{ ref: 'ticket-88', event: 'resolved' }]);
  assert.equal(first.accepted, 1);
  assert.deepEqual(first.unmapped, ['resolved'], 'nobody has said what resolved means yet');
  assert.equal((await get(c.id)).reward, null);
  await saveDef(c.workload.id, { events: [{ event: 'resolved', means: 'worked' }, { event: 'reopened', means: 'failed' }] });
  assert.equal((await get(c.id)).reward, 1, 'once resolved means worked, the call it was reported on worked');
  await report(ws, [{ call_id: c.id, event: 'reopened', at: Date.now() + 1000 }]);
  assert.equal((await get(c.id)).reward, 0, 'the latest word from the customer decides');
  const nobody = await report(ws, [{ ref: 'no-such-ticket', event: 'resolved' }, { call_id: c.id }]);
  assert.equal(nobody.accepted, 0);
  assert.equal(nobody.rejected.length, 2);
  // another workspace cannot report on this one's calls
  const other = await space();
  const stranger = await report(other, [{ call_id: c.id, event: 'resolved' }]);
  assert.equal(stranger.accepted, 0);
});

test('a reading is made from what counts: certain failures decide, the rest are weighed', async () => {
  assert.equal(rewardOf([]).reward, null);
  assert.equal(rewardOf([{ kind: 'tool_ok', value: 1 }, { kind: 'broken', value: 0 }]).reward, 0);
  assert.equal(rewardOf([{ kind: 'tool_ok', value: 1 }, { kind: 'continued', value: 1 }]).reward, 1);
  const mixed = rewardOf([{ kind: 'tool_ok', value: 1 }, { kind: 'retry', value: 0 }]).reward;
  assert.equal(mixed, 0.5);
  // a signal switched off does not count
  const def = { ...(await defOf(null)), signals: { retry: false } };
  assert.equal(rewardOf([{ kind: 'retry', value: 0 }], def).reward, null);
});
