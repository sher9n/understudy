/* Strategies, end to end, against a provider and a Jev we control.

   A cheap model that is wrong on one call in eight misses the bar on its own. Two strategies
   keep most of its saving anyway: a cascade (it answers, Jev checks the answer, and a doubtful
   one is sent on to the customer's own model) and a router (a small model of the workload's
   calls sends the ones it gets wrong straight to the customer's own model). These tests run a
   real measurement that finds them, switch to what cleared, and then send live calls through the
   real proxy, ordinary and streamed, to see each strategy serve, send on, charge and record. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';

const PORT = 4795;
const PROXY_PORT = 4796;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_strat_${process.pid}`;
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
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.MODEL_MIN_GAP_MS = '0';
process.env.EVAL_SAMPLE_SIZE = '80';
process.env.EVAL_MIN_RUNS = '80';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
// Jev through "OpenRouter", which here is the stand-in below: never the real one
process.env.JEV_VIA = 'openrouter';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { move, withFee } = await import('../src/billing.js');
const { default: v1 } = await import('../src/proxy.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/mostly-small';
const hard = (i) => i % 8 === 3;
const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const COST = { [REF]: 0.002, [CHEAP]: 0.0002, 'vendor/drifty-small': 0.0001 };
const JEV_COST = 0.00001;

/* The customer's model is right and a touch unstable with itself, which sets the bar; the cheap
   one is wrong in every field on the hard calls; the drifting one is wrong on all of them. */
let refCalls = 0;
const answerOf = (model, i) => {
  if (model === REF) {
    refCalls += 1;
    return i % 20 === 0 && refCalls % 2 === 0 ? { ...right(i), lines: 9 } : right(i);
  }
  if (model === CHEAP) return hard(i) ? { total: 0, currency: 'EUR', lines: 0 } : right(i);
  return { total: 999, currency: 'EUR', lines: 0 };
};

/* Jev reads the request and the answer and says how likely the answer is fine: sure of the right
   ones, except a few it is only half sure of, and doubtful of the wrong ones. */
let jevAsked = 0;
let jevRefuse = 0;
const jevReading = (state) => {
  const i = Number((String(state.request).match(/#(\d+)/) || [])[1] || 0);
  let ans = null;
  try { ans = JSON.parse(state.answer); } catch { ans = null; }
  const ok = ans && ans.total === 100 + i && ans.currency === 'USD';
  const fine = ok ? (i % 16 === 5 ? 0.55 : 0.93) : 0.15;
  return { type: 'choice', choice: fine >= 0.5 ? 'fine' : 'doubtful', confidence: Math.max(fine, 1 - fine),
    probabilities: { fine, doubtful: Math.round((0.99 - fine) * 100) / 100, fails: 0.01 } };
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    if (req.url.endsWith('/systemone')) {
      jevAsked += 1;
      if (jevRefuse > 0) {
        jevRefuse -= 1;
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { check: jevReading(payload.state) },
        usage: { input_tokens: 240, cost: JEV_COST } }));
      return;
    }
    const model = payload.model;
    const text = payload.messages.find((m) => m.role === 'user')?.content || '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    const content = JSON.stringify(answerOf(model, i));
    const usage = { prompt_tokens: 800, completion_tokens: 60, cost: COST[model] ?? 0.001 };
    const id = `gen-${Math.random().toString(36).slice(2, 10)}`;
    if (!payload.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: content.slice(0, 10) }));
    res.write(chunk({ content: content.slice(10) }));
    res.write(`data: ${JSON.stringify({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

const app = express();
app.use('/v1', v1);
let proxy = null;

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { proxy = app.listen(PROXY_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'mostly', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/drifty-small', name: 'drifty', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => proxy.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

/* One call of the workload. `long` makes the hard calls look different before they are sent,
   which is what a router needs; without it every call looks the same from outside. */
const request = (i, { long = false, stream = false } = {}) => ({
  model: REF,
  messages: [
    { role: 'system', content: `Extract the totals from invoice ${900000 + i}.` },
    { role: 'user', content: `document #${String(i).padStart(4, '0')}${long && hard(i) ? ` ${'with a long table of line items, '.repeat(24)}` : ''}` },
  ],
  response_format: { type: 'json_object' },
  ...(stream ? { stream: true } : {}),
});

async function seed(tag, { long = false } = {}) {
  const { workspace } = await createAccount({
    email: `strat-${tag}-${process.pid}@understudy.dev`, password: 'correct-horse', name: tag,
  });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  let workload = null;
  for (let i = 0; i < 160; i += 1) {
    const body = request(i, { long });
    workload = workload || await workloadFor(workspace.id, body);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'routed',
      requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0.002,
      request: body, response: { choices: [{ message: { content: '{}' } }] },
    });
  }
  await learningSettled();
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ?').run(now() - 14 * 86400000, workload.id);
  const key = await issueKey(workspace.id, 'strategies');
  return { workspace, workload, secret: key.secret };
}

const send = async (secret, body) => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const callId = res.headers.get('x-understudy-call-id');
  if (body.stream) {
    const text = await res.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    const content = events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    const usage = events.map((e) => e.usage).filter(Boolean).pop() || null;
    return { status: res.status, callId, content, usage, events };
  }
  const json = await res.json();
  return { status: res.status, callId, content: json.choices?.[0]?.message?.content ?? null, usage: json.usage ?? null, json };
};

/* A streamed call is recorded just after its last piece is sent, so the row can land a moment
   after the customer has the whole answer. */
const callRow = async (callId) => {
  assert.ok(callId, 'the answer carries its call id');
  for (let t = 0; t < 250; t += 1) {
    await learningSettled();
    const row = await db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`call ${callId} was never recorded`);
};

let cascadeShop = null;

test('a measurement finds a cascade for a cheap model that is wrong one time in eight, and switches to it', async () => {
  cascadeShop = await seed('cascade');
  const { workload } = cascadeShop;
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));

  const rows = await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(out.runId);
  const alone = rows.find((r) => r.model_id === CHEAP);
  assert.ok(alone, 'the cheap model was measured on its own');
  assert.equal(alone.verdict, 'missed', `on its own it misses: ${alone.gap_pct}% against ${out.floor}%`);

  const cascade = rows.find((r) => r.model_id === `cascade:${CHEAP}`);
  assert.ok(cascade, `a cascade was worked out: ${rows.map((r) => r.model_id).join(', ')}`);
  assert.equal(cascade.verdict, 'cleared', `the cascade clears: ${cascade.gap_pct}% against ${out.floor}%`);
  assert.equal(cascade.runs, 80, 'on every sampled call');
  const spec = JSON.parse(cascade.arm_json);
  assert.equal(spec.kind, 'cascade');
  assert.equal(spec.first.model, CHEAP);
  assert.equal(spec.fallback.model, REF);
  assert.equal(spec.threshold, 0.5, 'the least strict check that stays inside the bar, because it sends the fewest calls on');
  assert.ok(cascade.escalated_pct > 5 && cascade.escalated_pct < 25, `about one call in eight is sent on, got ${cascade.escalated_pct}%`);
  assert.ok(cascade.cost_ratio > 0.1 && cascade.cost_ratio < 0.4, `most of the saving is kept, got ${cascade.cost_ratio}`);
  assert.ok(!rows.some((r) => r.model_id === 'cascade:vendor/drifty-small'), 'a model wrong on everything is not worth a cascade');

  // every call looks the same from outside, so a router has nothing to go on and is not kept
  assert.ok(!rows.some((r) => r.model_id.startsWith('router:')), 'no router without something to tell the calls apart');

  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  assert.equal(w.routed_model, CHEAP, 'the cheap model leads the switch');
  assert.ok(w.routed_arm_id, 'and the switch names the strategy');
  const arm = await db.prepare('SELECT * FROM arms WHERE id = ?').get(w.routed_arm_id);
  assert.equal(arm.kind, 'cascade');
  assert.equal(arm.status, 'serving');
  assert.equal(arm.label, 'mostly-small, checked, gpt-5.4 when unsure');
  const promo = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? AND action = 'promote'`).get(workload.id);
  assert.equal(promo.to_model, `cascade:${CHEAP}`);
});

test('the cascade serves live calls: keeps the sure answers, sends the doubtful ones on, charges for all of it', async () => {
  const { secret, workload } = cascadeShop;
  const before = jevAsked;
  const since = now();

  const easy = await send(secret, request(500));
  assert.equal(easy.status, 200);
  assert.deepEqual(JSON.parse(easy.content), right(500), 'the cheap answer, which was right');
  const easyRow = await callRow(easy.callId);
  assert.equal(easyRow.served_model, CHEAP);
  assert.equal(Number(easyRow.escalated), 0);
  assert.ok(easyRow.arm_id, 'the call says which strategy answered it');
  assert.equal(Number(easyRow.propensity), 1);
  assert.equal(JSON.parse(easyRow.check_json).by, 'jev');
  assert.ok(Math.abs(Number(easyRow.cost_usd) - (COST[CHEAP] + JEV_COST)) < 1e-9, `the cheap call and the check: ${easyRow.cost_usd}`);
  assert.ok(Math.abs(Number(easy.usage.cost) - (COST[CHEAP] + JEV_COST)) < 1e-9, 'and the answer says so');

  const tough = await send(secret, request(507));
  assert.deepEqual(JSON.parse(tough.content), right(507), 'the customer model\'s answer, because the cheap one was doubtful');
  const toughRow = await callRow(tough.callId);
  assert.equal(toughRow.served_model, REF);
  assert.equal(Number(toughRow.escalated), 1);
  assert.equal(JSON.parse(toughRow.check_json).by, 'unsure');
  const total = COST[CHEAP] + JEV_COST + COST[REF];
  assert.ok(Math.abs(Number(toughRow.cost_usd) - total) < 1e-9, `both calls and the check: ${toughRow.cost_usd}`);
  assert.ok(Math.abs(Number(tough.usage.cost) - total) < 1e-9, `the answer carries the whole cost: ${tough.usage.cost}`);
  assert.equal(jevAsked - before, 2, 'one check for each live call');

  // the balance paid for exactly that, plus the routing fee, and nothing else
  const charged = await db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND kind = 'call'
      AND created_at >= ?`).get(workload.workspace_id, since);
  const due = withFee(COST[CHEAP] + JEV_COST) + withFee(total);
  assert.ok(Math.abs(-Number(charged.s) - due) < 1e-8, `charged ${-Number(charged.s)}, due ${due}`);

  // streamed: worked out whole, then sent as a stream
  const streamed = await send(secret, request(515, { stream: true }));
  assert.equal(streamed.status, 200);
  assert.deepEqual(JSON.parse(streamed.content), right(515), '515 is hard, so it streams the customer model\'s answer');
  assert.ok(Math.abs(Number(streamed.usage.cost) - total) < 1e-9, 'the last piece carries the whole cost');
  const streamedRow = await callRow(streamed.callId);
  assert.equal(Number(streamedRow.escalated), 1);
  assert.equal(streamedRow.served_model, REF);
});

test('when Jev cannot answer, a cascade sends the call on rather than serving an answer nobody checked', async () => {
  const { secret } = cascadeShop;
  jevRefuse = 1;
  const refused = await send(secret, request(521));
  assert.equal(refused.status, 200, 'the customer still gets an answer');
  assert.deepEqual(JSON.parse(refused.content), right(521));
  const row = await callRow(refused.callId);
  assert.equal(row.served_model, REF);
  assert.equal(JSON.parse(row.check_json).by, 'check failed');
  // a refusal like that rests Jev, and while it rests nothing is asked of it at all
  const asked = jevAsked;
  const resting = await send(secret, request(528));
  assert.equal(resting.status, 200);
  const restingRow = await callRow(resting.callId);
  assert.equal(JSON.parse(restingRow.check_json).by, 'unavailable');
  assert.equal(restingRow.served_model, REF);
  assert.equal(jevAsked, asked, 'Jev was not asked while it rests');
});

test('a router is found when the calls a cheap model gets wrong can be told apart before they are sent', async () => {
  // Jev rests after the refusal above; a router needs no Jev, which is part of what this shows
  const shop = await seed('router', { long: true });
  const out = await runEvaluation(shop.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const rows = await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(out.runId);
  const router = rows.find((r) => r.model_id === `router:${CHEAP}`);
  assert.ok(router, `a router was worked out: ${rows.map((r) => `${r.model_id} ${r.verdict}`).join(', ')}`);
  assert.equal(router.verdict, 'cleared', `${router.gap_pct}% against ${out.floor}%`);
  assert.ok(router.cost_ratio < 0.4, `it keeps most of the saving: ${router.cost_ratio}`);
  const spec = JSON.parse(router.arm_json);
  assert.equal(spec.kind, 'router');
  assert.equal(spec.weights.length, 6);

  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(shop.workload.id);
  const arm = await db.prepare('SELECT * FROM arms WHERE id = ?').get(w.routed_arm_id);
  assert.equal(arm.kind, 'router', 'switched to the router');

  // a short call goes to the cheap model, a long one straight to the customer's own, streamed as ever
  const short = await send(shop.secret, request(600));
  assert.deepEqual(JSON.parse(short.content), right(600));
  const shortRow = await callRow(short.callId);
  assert.equal(shortRow.served_model, CHEAP);
  assert.equal(Number(shortRow.escalated), 0);
  assert.equal(JSON.parse(shortRow.check_json).by, 'router');

  const long = await send(shop.secret, request(603, { long: true, stream: true }));
  assert.deepEqual(JSON.parse(long.content), right(603), 'the long call was sent to the customer model');
  const longRow = await callRow(long.callId);
  assert.equal(longRow.served_model, REF);
  assert.equal(Number(longRow.escalated), 1);
  assert.ok(Math.abs(Number(longRow.cost_usd) - COST[REF]) < 1e-9, 'one call, no check');
});
