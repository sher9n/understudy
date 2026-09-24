/* Routing performance first, end to end, against a provider and a Jev we control.

   Which of the setups that clear a workload it switches to (its routing priority), a router that sends
   each kind of request to the setup that does it well enough, written answers judged three ways by Jev,
   the control group that switches back a setup whose answers slip, and a serving router re-checked
   exactly as it serves. Each runs a real measurement, and where it matters real calls through the proxy,
   ordinary and streamed. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';

const PORT = 4861;
const PROXY_PORT = 4862;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_routing_${process.pid}`;
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
process.env.EVAL_MIN_RUNS = '80';
// these tests are about what a switch does, so workloads switch on their own
process.env.DEFAULT_OPTIMIZE_MODE = 'auto';
// two paid answers per call, so every scenario is built on what the stand-in says now
process.env.EVAL_USE_RECORDED = 'false';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
// Jev through "OpenRouter", which here is the stand-in below: never the real one
process.env.JEV_VIA = 'openrouter';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
// a switch serves every call at once; the staged rollout has tests of its own
process.env.ROLLOUT_ENABLED = 'false';
// no test here is about the speed rule: a busy machine must not make a model look too slow
process.env.SPEED_SLACK_MS = '5000';
// the language model that judges where Jev is unsure, answered below
process.env.EVAL_JUDGE_MODEL = 'judge/small';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { move } = await import('../src/billing.js');
const { default: v1 } = await import('../src/proxy.js');
const { onServed } = await import('../src/learn/choose.js');
const { afterServed, reviewWorkload, forgetState } = await import('../src/learn/explore.js');
const { controlRecord } = await import('../src/learn/control.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
// the priority scenario: two that answer everything right, one cheaper by a hair and slow
const THIN = 'vendor/thin-small';
const QUICK = 'vendor/quick-small';
// the router scenario: one right on order questions and wrong on refund complaints, and one right on both but dearer
const CHEAP = 'vendor/cheap-small';
const STEADY = 'vendor/steady-small';
// written answers: one says the same and adds a line that helps, one leaves out when the order arrives
const BETTER = 'vendor/better-writer';
const WORSE = 'vendor/worse-writer';
const MODELS = [REF, THIN, QUICK, CHEAP, STEADY, BETTER, WORSE];
const COST = { [REF]: 0.002, [THIN]: 0.0002, [QUICK]: 0.000205, [CHEAP]: 0.0001, [STEADY]: 0.0006, [BETTER]: 0.0003, [WORSE]: 0.0002 };
// how long each takes to answer, beyond the stand-in's own time
const DELAY = { [THIN]: 40 };
const JEV_COST = 0.00001;

/* The requests. A third of the order workload's requests are long complaints about a refund, the rest
   short questions about where an order is; they read differently before they are sent, which is what a
   router by kind of request goes on. */
const TOPICS = ['shoes', 'a jacket', 'the lamp', 'two books', 'a kettle', 'the charger', 'socks', 'a tent'];
const isRefund = (i) => i % 3 === 0;
const orderText = (i) => (isRefund(i)
  ? `I was charged twice for order #${i} and the refund never arrived, even though support promised a full refund for the damaged `
    + `${TOPICS[i % TOPICS.length]} and the return label was sent back weeks ago. Please explain the charges.`
  : `Where is my order #${i}? I ordered ${TOPICS[i % TOPICS.length]} last week.`);
const right = (i) => ({ order: i, status: 'shipped', refund: isRefund(i) ? 'issued' : null });

// what the stand-in has gone wrong on, for the scenarios that break something after a switch
let quickBroken = false;
let cheapBroken = false;

/* The written answers: the customer's own model says when it arrives; the better writer says the same and
   adds how to follow it; the worse writer leaves out when it arrives. */
const refText = (i) => `Order ${i} shipped today by courier and arrives on Friday.`;
const writerText = (model, i) => (model === BETTER ? `${refText(i)} You can follow it with the tracking link in your email.`
  : model === WORSE ? `Order ${i} shipped today.` : refText(i));
const variant = (t) => (/tracking link/.test(t) ? 'better' : /arrives on Friday/.test(t) ? 'ref' : /shipped today\.\s*$/.test(t) ? 'worse' : 'other');
// the measurement checks its judge with an answer beside itself with a space doubled, which is the same answer
const orderOf = (t) => Number((String(t).match(/Order\s+(\d+)/) || [])[1] ?? NaN);

const answerOf = (model, user, json) => {
  const i = Number((user.match(/#(\d+)/) || [])[1] ?? NaN);
  if (!json) return writerText(model, i);
  if (!Number.isFinite(i)) return JSON.stringify({ order: null, status: 'unknown', refund: null });
  if (model === QUICK && quickBroken) return JSON.stringify({ order: i, status: 'lost', refund: null });
  if (model === CHEAP && (isRefund(i) || cheapBroken)) return JSON.stringify({ order: i, status: 'shipped', refund: 'none' });
  return JSON.stringify(right(i));
};

/* Jev, as the app asks it: which of two answers serve the person as well (noul), what the main difference
   is (choice), which of two serves better (choice, asked in both orders), and whether an answer served
   live is fine (choice). The labels of the answers are shuffled, so they are read from each question. */
let jevAsked = 0;
const labelsIn = (q) => [...String(q?.instructions || '').matchAll(/answers\.(\w+)/g)].map((m) => m[1]);
function jevAnswers(state, questions) {
  const out = {};
  for (const [key, q] of Object.entries(questions || {})) {
    if (key === 'check') {
      const i = Number((String(state.request).match(/#(\d+)/) || [])[1] ?? NaN);
      let ok;
      try { ok = JSON.stringify(JSON.parse(state.answer)) === JSON.stringify(right(i)); } catch { ok = variant(state.answer) !== 'worse'; }
      const fine = ok ? 0.93 : 0.15;
      out.check = { type: 'choice', choice: fine >= 0.5 ? 'fine' : 'doubtful', confidence: Math.max(fine, 1 - fine),
        probabilities: { fine, doubtful: Math.round((0.99 - fine) * 100) / 100, fails: 0.01 } };
    } else if (key.startsWith('same')) {
      const [a, b] = labelsIn(q);
      const ta = state.answers?.[a];
      const tb = state.answers?.[b];
      const alike = orderOf(ta) === orderOf(tb) && variant(ta) === variant(tb);
      out[key] = { type: 'noul', noul: alike ? 0.96 : 0.12 };
    } else if (key === 'refuses' || key === 'cut') {
      out[key] = { type: 'noul', noul: 0.02 };
    } else if (key === 'kind' || key === 'kind1') {
      const [a, b] = labelsIn(q);
      const ta = state.answers?.[a];
      const tb = state.answers?.[b];
      const kind = orderOf(ta) !== orderOf(tb) ? 'unrelated' : variant(ta) !== variant(tb) ? 'omission' : 'wording';
      out[key] = { type: 'choice', choice: kind, confidence: 0.9, probabilities: { [kind]: 0.9 } };
    } else if (key === 'better') {
      const rank = { better: 2, ref: 1, worse: 0, other: 0 };
      const f = rank[variant(state.answers?.first)];
      const s = rank[variant(state.answers?.second)];
      const probabilities = f > s ? { first: 0.86, second: 0.04, equal: 0.1 } : s > f ? { first: 0.04, second: 0.86, equal: 0.1 }
        : { first: 0.08, second: 0.08, equal: 0.84 };
      const choice = f > s ? 'first' : s > f ? 'second' : 'equal';
      out.better = { type: 'choice', choice, confidence: probabilities[choice], probabilities };
    }
    // anything else (what a model suits, what a task demands) is left unanswered, which the app reads as no reading
  }
  return out;
}

const fenced = (text, label) => (text.match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    if (req.url.endsWith('/systemone')) {
      jevAsked += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'typesafe/jev-1.13', answers: jevAnswers(payload.state, payload.questions),
        usage: { input_tokens: 240, cost: JEV_COST } }));
      return;
    }
    const model = payload.model;
    const sys = payload.messages?.find((m) => m.role === 'system')?.content || '';
    const user = String(payload.messages?.filter((m) => m.role === 'user').pop()?.content || '');
    let content;
    if (model === 'judge/small') {
      // only asked where Jev is unsure, which the stand-in never is; answered sensibly all the same
      content = String(sys).includes('say which one serves') ? 'TIE'
        : fenced(user, 'A').trim() === fenced(user, 'B').trim() ? 'SAME' : 'DIFFERENT';
    } else {
      content = answerOf(model, user, payload.response_format?.type === 'json_object');
    }
    const usage = { prompt_tokens: 800, completion_tokens: 60, cost: COST[model] ?? 0.00001 };
    const id = `gen-${Math.random().toString(36).slice(2, 10)}`;
    setTimeout(() => {
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
    }, DELAY[model] || 0);
  });
});

const app = express();
app.use('/v1', v1);
let proxy = null;

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { proxy = app.listen(PROXY_PORT, '127.0.0.1', r); });
  await saveCatalog(MODELS.map((m) => ({
    model_id: m, name: m.split('/').pop(), context_len: 200000,
    price_in: (COST[m] / 1000) * 0.9, price_out: (COST[m] / 1000) * 0.1 * (1000 / 60), open_weights: 1, zdr: 1,
  })));
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

/* A workspace with one workload of `n` calls through Understudy, spread over a fortnight, where only the
   models named can be tried. */
let seq = 0;
async function seed({ enabled, n = 320, text = false, routing = null, workspaceRouting = null, speed = 'any' }) {
  seq += 1;
  const { workspace } = await createAccount({ email: `route-${seq}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `r${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET zdr_required = 0, default_routing_mode = ? WHERE id = ?').run(workspaceRouting, workspace.id);
  for (const m of MODELS) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, enabled.includes(m) ? 1 : 0, now());
  }
  const request = (i) => (text
    ? { model: REF, messages: [{ role: 'system', content: `Tell the customer where their order is, in a sentence or two. Shop ${seq}.` },
      { role: 'user', content: `Where is my order #${i}?` }] }
    : { model: REF, messages: [{ role: 'system', content: `You answer customers about their orders, as JSON. Shop ${seq}.` },
      { role: 'user', content: orderText(i) }], response_format: { type: 'json_object' } });
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const body = request(i);
    workload = workload || await workloadFor(workspace.id, body);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'routed', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: COST[REF], chargedUsd: COST[REF],
      request: body, response: { choices: [{ message: { content: text ? refText(i) : JSON.stringify(right(i)) } }] },
    });
  }
  await learningSettled();
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14) * 86400000 WHERE workload_id = ?')
    .run(now() - 86400000, workload.id);
  await db.prepare(`UPDATE workloads SET state = 'live', routing_mode = ?, speed_pref = ? WHERE id = ?`).run(routing, speed, workload.id);
  const key = await issueKey(workspace.id, 'routing');
  return { workspace, workload: await load(workload.id), secret: key.secret, request };
}

const load = (id) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(id);
const runOf = (id) => db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id);
const resultsOf = (runId) => db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId);
const resultOf = async (runId, model) => (await resultsOf(runId)).find((r) => r.model_id === model);
const armOf = async (workloadId) => {
  const w = await load(workloadId);
  return w.routed_arm_id ? db.prepare('SELECT * FROM arms WHERE id = ?').get(w.routed_arm_id) : null;
};

const send = async (secret, body) => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const callId = res.headers.get('x-understudy-call-id');
  if (body.stream) {
    const t = await res.text();
    const events = t.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    return { status: res.status, callId, content: events.map((e) => e.choices?.[0]?.delta?.content || '').join('') };
  }
  const json = await res.json();
  return { status: res.status, callId, content: json.choices?.[0]?.message?.content ?? null };
};
// a streamed call is recorded just after its last piece is sent, so the row can land a moment later
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

/* 1. The routing priority ------------------------------------------------------------------------ */

let balanced = null;

test('balanced switches to the biggest saving we are sure of, and of two that save about the same, the faster', async () => {
  balanced = await seed({ enabled: [THIN, QUICK] });
  const out = await runEvaluation(balanced.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  balanced.runId = out.runId;
  const run = await runOf(out.runId);
  assert.equal(run.routing_mode, 'balanced', 'nobody chose, so the default');
  const thin = await resultOf(out.runId, THIN);
  const quick = await resultOf(out.runId, QUICK);
  assert.equal(thin.verdict, 'cleared');
  assert.equal(quick.verdict, 'cleared');
  assert.ok(Number(thin.cost_ratio) < Number(quick.cost_ratio), `thin is the cheaper: ${thin.cost_ratio} against ${quick.cost_ratio}`);
  assert.ok(Number(thin.latency_p50) > Number(quick.latency_p50) + 20, `and the slower: ${thin.latency_p50} against ${quick.latency_p50} ms`);
  // how sure the measurement is, and what that makes the saving, on every setup that cleared
  for (const r of [thin, quick]) {
    assert.ok(Number(r.chance) > 0.99, `${r.model_id}: sure it keeps the bar, ${r.chance}`);
    assert.ok(Math.abs(Number(r.safe_saving) - (1 - Number(r.cost_ratio) * 1.01) * Number(r.chance)) < 1e-6, `${r.model_id}: safe saving ${r.safe_saving}`);
  }
  assert.ok(Number(thin.safe_saving) - Number(quick.safe_saving) < 0.01, 'within a point of each other');
  assert.equal(quick.choice_rank, 1, 'the faster one comes first');
  assert.equal(thin.choice_rank, 2);
  const choice = JSON.parse(run.choice_json);
  assert.deepEqual(choice.order.map((x) => x.model), [QUICK, THIN]);
  assert.equal(quick.confirm_verdict, 'cleared', 'it passed its second look');
  assert.equal(thin.confirm_verdict, 'not_reached', 'and the one after it never needed one');
  const w = await load(balanced.workload.id);
  assert.equal(w.routed_model, QUICK, 'switched to the faster one');
});

test('most savings switches to the cheapest that clears, whatever its speed', async () => {
  const shop = await seed({ enabled: [THIN, QUICK], routing: 'savings' });
  const out = await runEvaluation(shop.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runOf(out.runId)).routing_mode, 'savings', 'the workload\'s own choice');
  assert.equal((await resultOf(out.runId, THIN)).choice_rank, 1);
  assert.equal((await load(shop.workload.id)).routed_model, THIN);
});

test('cautious, from the workspace, holds the second look to a stricter bound on the same number of calls', async () => {
  const shop = await seed({ enabled: [THIN, QUICK], workspaceRouting: 'cautious' });
  const out = await runEvaluation(shop.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runOf(out.runId)).routing_mode, 'cautious', 'the workspace\'s choice, the workload having none');
  const quick = await resultOf(out.runId, QUICK);
  assert.equal(quick.choice_rank, 1, 'both are sure enough, so the faster comes first');
  assert.equal(quick.confirm_verdict, 'cleared');
  const easy = await resultOf(balanced.runId, QUICK);
  assert.equal(quick.confirm_runs, easy.confirm_runs, `the same number of calls as a balanced look: ${quick.confirm_runs} and ${easy.confirm_runs}`);
  assert.ok(Number(quick.confirm_hi) > Number(easy.confirm_hi),
    `the same clean record reads as less certain under the stricter bound: at most ${quick.confirm_hi}% against ${easy.confirm_hi}%`);
  assert.equal((await load(shop.workload.id)).routed_model, QUICK);
});

/* 2. A router by kind of request ------------------------------------------------------------------ */

let kinds = null;

test('a measurement finds the kinds of request a cheap model gets right, and switches to routing by them', async () => {
  kinds = await seed({ enabled: [CHEAP, STEADY] });
  const out = await runEvaluation(kinds.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const rows = await resultsOf(out.runId);
  const cheap = rows.find((r) => r.model_id === CHEAP);
  assert.notEqual(cheap.verdict, 'cleared', `on its own the cheap one misses: ${cheap.gap_pct}%`);
  const key = `router:${CHEAP}+${STEADY}~kinds`;
  const router = rows.find((r) => r.model_id === key);
  assert.ok(router, `a router was worked out: ${rows.map((r) => `${r.model_id} ${r.verdict}`).join(', ')}`);
  assert.equal(router.verdict, 'cleared', `${router.gap_pct}%`);
  const steady = rows.find((r) => r.model_id === STEADY);
  assert.ok(Number(router.cost_ratio) <= Number(steady.cost_ratio) * 0.95, `it saves more than the steady one alone: ${router.cost_ratio} against ${steady.cost_ratio}`);
  const spec = JSON.parse(router.arm_json);
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.options.map((o) => o.model), [CHEAP, STEADY], 'only the setups its table uses');
  const rank = JSON.parse(router.rank_json);
  assert.ok(rank.kindsZ >= 1.645, `its kinds mattered: ${rank.kindsZ}`);
  assert.equal(router.choice_rank, 1, 'the biggest saving we are sure of');
  assert.equal(router.confirm_verdict, 'cleared', 'it passed a second look of its own');
  const arm = await armOf(kinds.workload.id);
  assert.equal(arm.kind, 'router', 'switched to it');
  assert.match(arm.label, /picked by kind of request/);
});

test('the router serves live calls by their kind, plain and streamed, and anything unfamiliar goes to the customer\'s model', async () => {
  const { secret, request } = kinds;
  const order = await send(secret, request(601));
  assert.deepEqual(JSON.parse(order.content), right(601));
  const orderRow = await callRow(order.callId);
  assert.equal(orderRow.served_model, CHEAP, 'an order question goes to the cheap model');
  assert.equal(Number(orderRow.escalated), 0);
  const orderCheck = JSON.parse(orderRow.check_json);
  assert.equal(orderCheck.by, 'router');
  assert.equal(orderCheck.why, 'kind');

  const refund = await send(secret, request(603));
  assert.deepEqual(JSON.parse(refund.content), right(603), 'the steady model gets refunds right');
  assert.equal((await callRow(refund.callId)).served_model, STEADY, 'a refund complaint goes to the steady model');

  const streamed = await send(secret, { ...request(606), stream: true });
  assert.deepEqual(JSON.parse(streamed.content), right(606));
  assert.equal((await callRow(streamed.callId)).served_model, STEADY, 'picked before the stream is sent');

  const odd = await send(secret, { ...request(1), messages: [request(1).messages[0], { role: 'user', content: 'Compose a sonnet about lighthouses in winter storms.' }] });
  assert.equal(odd.status, 200);
  const oddRow = await callRow(odd.callId);
  assert.equal(oddRow.served_model, REF, 'a request like none it learned from');
  assert.equal(Number(oddRow.escalated), 1);
  assert.equal(JSON.parse(oddRow.check_json).why, 'unfamiliar');
});

/* 3. Written answers, judged three ways ----------------------------------------------------------- */

test('a written answer that adds what helps is counted better, and one that leaves out a fact is worse', async () => {
  const shop = await seed({ enabled: [BETTER, WORSE], text: true });
  const before = jevAsked;
  const out = await runEvaluation(shop.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(jevAsked > before, 'Jev judged the answers');
  const run = await runOf(out.runId);
  assert.equal(Number(run.noise_pct), 0, 'the customer\'s model says the same both times');
  const better = await resultOf(out.runId, BETTER);
  const worse = await resultOf(out.runId, WORSE);
  assert.equal(better.verdict, 'cleared', `a different answer that serves the person better is not a worse one: ${better.gap_pct}%`);
  assert.ok(Number(better.better_pct) > 90, `where it differed, it was the better one: ${better.better_pct}%`);
  assert.ok(['missed', 'review'].includes(worse.verdict), `leaving out when it arrives is never forgiven: ${worse.verdict}, ${worse.gap_pct}%`);
  assert.notEqual(worse.verdict, 'cleared');
  assert.equal((await load(shop.workload.id)).routed_model, BETTER);
});

/* 4. The control group ------------------------------------------------------------------------------ */

test('after a switch, answers checked against the customer\'s model in the background switch back one that slipped', async () => {
  const { secret, request, workload } = balanced;
  assert.equal((await load(workload.id)).routed_model, QUICK, 'serving the quick one from the first test');
  // every answer the switch serves is also asked of the customer's model, in the background
  onServed((info) => afterServed(info, { control: { rng: () => 0 } }));
  quickBroken = true;
  try {
    for (let i = 0; i < 32; i += 1) {
      const r = await send(secret, request(700 + i));
      assert.equal(r.status, 200);
    }
    await learningSettled();
    const rec = await controlRecord(await load(workload.id));
    assert.ok(rec.n >= 30, `the checks: ${rec.n}`);
    assert.ok(rec.worse >= 30, `every one of them worse: ${rec.worse}`);
    assert.ok(rec.lo * 100 > rec.floorPct, `the whole range past the bar: at least ${(rec.lo * 100).toFixed(1)}% against ${rec.floorPct}%`);
    const cost = await db.prepare(`SELECT COUNT(*) AS n FROM control_checks WHERE workload_id = ? AND cost_usd > 0`).get(workload.id);
    assert.ok(Number(cost.n) >= 30, 'each background answer is paid for');
    forgetState(workload.id);
    const d = await reviewWorkload(await load(workload.id));
    assert.equal(d[0]?.kind, 'revert', JSON.stringify(d));
    assert.equal(d[0]?.by, 'control');
    const w = await load(workload.id);
    assert.equal(w.routed_model, null, 'back on the customer\'s own model');
    const back = await db.prepare('SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
    assert.match(back.reason || '', /in the background/, `said why: ${back.reason}`);
  } finally {
    quickBroken = false;
    onServed(null);
  }
});

/* 5. A serving router, re-checked as it serves --------------------------------------------------------- */

test('a measurement re-checks the serving router exactly as it serves, and switches it back when its cheap model slips', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  assert.equal(arm.kind, 'router');
  cheapBroken = true;
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.ok(row, 'the serving router was worked out again');
    assert.deepEqual(JSON.parse(row.arm_json).centroids, JSON.parse(arm.spec_json).centroids, 'with the kinds it serves by, never learned again');
    assert.deepEqual(JSON.parse(row.arm_json).table, JSON.parse(arm.spec_json).table, 'and the table it serves by');
    assert.equal(row.verdict, 'missed', `${row.gap_pct}%`);
    const w = await load(workload.id);
    assert.equal(w.routed_model, null, 'switched back to the customer\'s own model');
    const r = await db.prepare('SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
    assert.equal(r.action, 'auto_revert');
  } finally {
    cheapBroken = false;
  }
});
