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
const { controlRecord, maybeControl, scoreServed, barOf, forgetBar } = await import('../src/learn/control.js');
const { optimizeSpent } = await import('../src/billing.js');
const { judgeBetter, judgeCandidate, judgeBarPair } = await import('../src/eval/judge.js');
const { keyOfSpec } = await import('../src/eval/promote.js');
const { armKey } = await import('../src/learn/arms.js');
const { planFor } = await import('../src/eval/plan.js');
const { buildUpstream } = await import('../src/openrouter.js');
const { routeFor } = await import('../src/learn/serve.js');
const { cheaperCleared } = await import('../src/eval/outcome.js');
const { zdrFor } = await import('../src/workspace.js');
const { default: config } = await import('../src/config.js');

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
// slow enough that a busy test machine never hides it (GitHub's runners are far slower than a laptop)
const DELAY = { [THIN]: 90 };
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
// models whose provider answers with this status instead, for the scenarios where one is too busy to answer
const failing = new Map();
// models whose provider refuses some requests: model to a rule on the request's text, giving the status or nothing
const refusing = new Map();
// Jev not answering "which serves better" at all, for the scenario where that reading does not come back
let betterRefused = false;

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
      // a refusal that passes by itself and is never retried: the one reading just does not come back
      if (betterRefused && payload.questions?.better) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Jev could not read this one' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'typesafe/jev-1.13', answers: jevAnswers(payload.state, payload.questions),
        usage: { input_tokens: 240, cost: JEV_COST } }));
      return;
    }
    const model = payload.model;
    if (failing.has(model)) {
      res.writeHead(failing.get(model), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Provider is overloaded' } }));
      return;
    }
    const sys = payload.messages?.find((m) => m.role === 'system')?.content || '';
    const user = String(payload.messages?.filter((m) => m.role === 'user').pop()?.content || '');
    const refused = refusing.get(model)?.(user);
    if (refused) {
      res.writeHead(refused, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This request is not allowed on this provider' } }));
      return;
    }
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
  assert.ok(Number(thin.latency_p50) > Number(quick.latency_p50) + 45, `and the slower: ${thin.latency_p50} against ${quick.latency_p50} ms`);
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
  assert.equal(choice.chosen, QUICK, 'what the test chose is written down as it was decided');
  assert.equal(choice.chosenKept, false, 'a switch, not a setup kept');
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

test('a measurement re-checks a healthy router and keeps it, beside a router learned again over the same setups', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  /* The quote counts every setup of the router serving now among the models measured to the end, as the run
     measures them: with a workspace that measures one model to the end, a router of two was quoted for one. */
  await db.prepare('UPDATE workspaces SET eval_models = 1 WHERE id = ?').run(workload.workspace_id);
  try {
    const plan = await planFor(await load(workload.id), { canRoute: true });
    assert.equal(plan.models, 2, `both of its setups quoted to the end: ${plan.models}`);
    assert.deepEqual(plan.order.slice(0, 2).map((o) => o.model), [CHEAP, STEADY], 'and first, as the run takes them');
  } finally {
    await db.prepare('UPDATE workspaces SET eval_models = NULL WHERE id = ?').run(workload.workspace_id);
  }
  const out = await runEvaluation(workload.id, { trigger: 'automatic' });
  assert.equal(out.ok, true, `the run finishes: ${JSON.stringify(out)}`);
  const key = `router:${CHEAP}+${STEADY}~kinds`;
  const choice = JSON.parse((await runOf(out.runId)).choice_json);
  assert.equal(choice.chosen, key, 'the router serving is what this test chose');
  assert.equal(choice.chosenKept, true, 'kept, not switched to');
  const rows = (await resultsOf(out.runId)).filter((r) => r.model_id === key);
  assert.equal(rows.length, 1, 'one result for the router serving, never a second under the same name');
  assert.equal(rows[0].verdict, 'cleared', `${rows[0].gap_pct}%`);
  assert.deepEqual(JSON.parse(rows[0].arm_json).table, JSON.parse(arm.spec_json).table, 'the one serving, as it serves');
  const w = await load(workload.id);
  assert.equal(w.routed_arm_id, arm.id, 'still serving');
  const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  assert.match(said.title, /still clears your bar/);
});

test('a setup too busy to answer during a re-check never switches a router back', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
  failing.set(STEADY, 503);
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const steady = await resultOf(out.runId, STEADY);
    assert.equal(steady.stopped, 'errors', 'the busy setup stopped');
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.equal(row.verdict, 'insufficient', `the calls it could not answer are left out, not counted wrong: ${row.verdict}, ${row.gap_pct}%`);
    assert.ok(row.runs < 120, `judged on the calls that were answered: ${row.runs}`);
    assert.match(row.error_text || '', /could not be answered/);
    assert.equal((await load(workload.id)).routed_arm_id, arm.id, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
    assert.equal(after, before, 'nothing switched back');
    const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
    assert.match(said.title, /could not be checked in full/);
  } finally {
    failing.delete(STEADY);
  }
});

test('a setup refused on a request the router never sends it does not fail the router', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
  // the steady setup is refused a question about where an order is, which the router sends to the cheap one
  refusing.set(STEADY, (user) => (/refund/i.test(user) ? null : 400));
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal((await resultOf(out.runId, STEADY)).stopped, 'refused', 'on its own, the steady setup was refused');
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.notEqual(row.verdict, 'failed', `a refusal on a request it never sends there says nothing about the router: ${row.verdict}`);
    assert.notEqual(row.stopped, 'refused');
    // it answered every request the router sends it before it met the one it was refused, so the router is judged in full
    assert.equal(row.verdict, 'cleared', `${row.verdict}, on ${row.runs} calls`);
    assert.equal(row.runs, 120, 'on every call');
    assert.equal((await load(workload.id)).routed_arm_id, arm.id, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
    assert.equal(after, before, 'nothing switched back');
  } finally {
    refusing.delete(STEADY);
  }
});

/* 3. Written answers, judged three ways ----------------------------------------------------------- */

let writer = null;

test('a written answer that adds what helps is counted better, and one that leaves out a fact is worse', async () => {
  const shop = await seed({ enabled: [BETTER, WORSE], text: true });
  writer = shop;
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

test('what the background checks cost is optimizing spend, and counts against the budget', async () => {
  const { workspace } = balanced;
  const sum = async (sql) => Number((await db.prepare(sql).get(workspace.id)).s);
  const checks = await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM control_checks WHERE workspace_id = ?');
  assert.ok(checks > 0, 'the checks above were paid for');
  const others = await sum('SELECT COALESCE(SUM(spend_usd), 0) AS s FROM eval_runs WHERE workspace_id = ?')
    + await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM shadow_runs WHERE workspace_id = ?')
    + await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM graded_calls WHERE workspace_id = ?');
  const spent = await optimizeSpent(workspace.id);
  assert.ok(Math.abs(spent - (others + checks) * 1.01) < 1e-6, `optimizing spend ${spent} counts the checks' ${checks} beside ${others}`);
});

test('a burst of calls never runs more than two background checks at once for one workload', async () => {
  const { workload, request } = writer;
  const w = await load(workload.id);
  assert.ok(w.routed_arm_id, 'the better writer serves');
  const seen = [];
  let at = 0;
  let most = 0;
  // the customer's own model answering in the background, slowly, so the checks overlap
  const serve = async (spec, body, opts) => {
    seen.push(opts);
    at += 1;
    most = Math.max(most, at);
    await new Promise((r) => setTimeout(r, 150));
    at -= 1;
    return { json: { choices: [{ message: { content: refText(900) } }] }, cost: 0.002, latencyMs: 150 };
  };
  const decision = { armId: w.routed_arm_id, explored: false, escalated: false };
  const response = { choices: [{ message: { content: writerText(BETTER, 900) } }] };
  const outs = await Promise.all(Array.from({ length: 8 }, () => maybeControl({ workload: w, body: request(900), response, decision },
    { rng: () => 0, serve })));
  assert.equal(outs.filter(Boolean).length, 2, 'two ran, the rest were passed over rather than queued');
  assert.equal(most, 2);
  // asked with the workspace's own rule on providers that keep nothing
  assert.equal(seen[0].zdr, await zdrFor(workload.workspace_id));
  // a call a router or check sent on to the customer's own model is checked too
  const sentOn = await maybeControl({ workload: w, body: request(901), response, decision: { ...decision, escalated: true } },
    { rng: () => 0, serve });
  assert.ok(sentOn, 'checked');
  assert.equal(JSON.parse(sentOn.detail_json).escalated, true);
});

test('background checks never spend the last quarter of the optimization budget, which is kept for measurements', async () => {
  const { workload, request } = writer;
  const w = await load(workload.id);
  const spent = await optimizeSpent(w.workspace_id);
  assert.ok(spent > 0, 'the measurement above was optimizing spend');
  const serve = async () => ({ json: { choices: [{ message: { content: refText(950) } }] }, cost: 0.002, latencyMs: 5 });
  const decision = { armId: w.routed_arm_id, explored: false, escalated: false };
  const response = { choices: [{ message: { content: writerText(BETTER, 950) } }] };
  const check = (i) => maybeControl({ workload: w, body: request(i), response, decision }, { rng: () => 0, serve });
  try {
    // a fifth of the budget left: that is for measurements
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(spent * 1.25, w.workspace_id);
    assert.equal(await check(950), null, 'not checked');
    // half of it left: checked
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(spent * 2, w.workspace_id);
    assert.ok(await check(951), 'checked');
  } finally {
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = NULL WHERE id = ?').run(w.workspace_id);
  }
});

test('the control group counts only the checks judged by the yardstick of the pass mark they are held to', async () => {
  const w = await load(writer.workload.id);
  const bar = await barOf(w);
  const other = bar.yardstick === 'quality' ? 'agreement' : 'quality';
  const before = await controlRecord(w);
  let k = 0;
  const add = async (yardstick, score, n) => {
    for (let j = 0; j < n; j += 1) {
      k += 1;
      await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, judged_by, yardstick, cost_usd, status, created_at)
          VALUES (?, ?, ?, ?, ?, 0, 'test', ?, 0.001, 200, ?)`).run(`ctl_yard_${process.pid}_${k}`, w.workspace_id, w.id, w.routed_arm_id, score, yardstick, now());
    }
  };
  try {
    // forty worse answers, judged by the other yardstick: a mark set for this one says nothing of them
    await add(other, 1, 40);
    const mixed = await controlRecord(w);
    assert.equal(mixed.n, before.n, 'not counted');
    assert.equal(mixed.worse, before.worse);
    assert.ok(mixed.costUsd > before.costUsd, 'though what they cost is');
    await add(bar.yardstick, 0, 5);
    assert.equal((await controlRecord(w)).n, before.n + 5, 'the ones judged by this yardstick are');
  } finally {
    await db.prepare(`DELETE FROM control_checks WHERE id LIKE 'ctl_yard_%'`).run();
  }
});

test('a measurement that found the customer\'s model too unsteady to measure never sets the bar a switch is held to', async () => {
  const w = await load(writer.workload.id);
  forgetBar(w.id);
  const before = await barOf(w);
  const runId = `run_unsteady_${process.pid}`;
  // such a measurement writes the mark it worked out before it gives up: here 60%, which nothing could ever pass
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, floor_pct, noise_pct,
      yardstick, created_at, finished_at) VALUES (?, ?, ?, 'done', 'unmeasurable', ?, ?, 60, 48, 'agreement', ?, ?)`)
    .run(runId, w.workspace_id, w.id, w.shape_kind, w.reference_model, now(), now());
  try {
    forgetBar(w.id);
    assert.deepEqual(await barOf(w), before, 'the bar stays the one the last measurement that could set it set');
  } finally {
    await db.prepare('DELETE FROM eval_runs WHERE id = ?').run(runId);
    forgetBar(w.id);
  }
});

test('the control group judges by the yardstick the switch was measured by, and leaves out calls nobody finished', async () => {
  const body = writer.request(902);
  const served = { choices: [{ message: { content: writerText(WORSE, 902) } }] };
  const ref = { choices: [{ message: { content: refText(902) } }] };
  const same = await scoreServed(body, served, ref, 'free_text', { yardstick: 'agreement' });
  assert.equal(same.score, 1, 'held to the same answer, leaving out when it arrives is a different answer');
  // held to "at least as good" by the judge its measurement chose (here the language model), the quality judge reads it
  const good = await scoreServed(body, served, ref, 'free_text', { yardstick: 'quality', prefer: 'llm' });
  assert.equal(good.judgedBy, 'llm-quality', 'held to "at least as good", the quality judge reads it');
  assert.equal(good.score, 0, 'and the stand-in judge calls it a tie');
  // with no judge chosen, Jev reads it first, both ways round, and sees what the writer left out
  const jev = await scoreServed(body, served, ref, 'free_text', { yardstick: 'quality' });
  assert.equal(jev.judgedBy, 'jev-quality');
  assert.equal(jev.score, 1);
  // an answer cut short counts against what served only when the customer's model finished the same call
  const cut = { choices: [{ message: { content: 'Order 902 ship' }, finish_reason: 'length' }] };
  assert.equal((await scoreServed(body, cut, ref, 'free_text')).score, 1);
  assert.equal((await scoreServed(body, cut, cut, 'free_text')).score, null, 'both cut short: the call says nothing');
});

test('a reading of which answer serves better that did not come back never counts against what already serves', async () => {
  const w = await load(writer.workload.id);
  assert.equal(w.routed_model, BETTER, 'the better writer serves');
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(w.id)).n);
  betterRefused = true;
  try {
    // the control group says nothing on such a check
    const body = writer.request(7202);
    const s = await scoreServed(body, { choices: [{ message: { content: writerText(BETTER, 7202) } }] },
      { choices: [{ message: { content: refText(7202) } }] }, 'free_text', { yardstick: 'agreement', scope: 'unsettled-control' });
    assert.equal(s.score, null, 'no reading');
    // and a re-check does not find what serves wanting on readings that never came back
    const out = await runEvaluation(w.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const better = await resultOf(out.runId, BETTER);
    /* Its row counts every difference, as every row does, so it ranks against the rest on the same terms: read
       as it serves instead, it came first where it should not have, and a cheaper setup was never looked at again.
       Whether it keeps serving is decided on the reading as it serves, which leaves those differences out. */
    assert.ok(Number(better.gap_pct) > 0, `the row counts the differences a reading left unsettled: ${better.verdict}, ${better.gap_pct}%`);
    // while a setup that would be switched to still has every such difference counted against it
    const worse = await resultOf(out.runId, WORSE);
    assert.ok(['missed', 'review'].includes(worse.verdict), `${worse.verdict}, ${worse.gap_pct}%`);
    assert.equal((await load(w.id)).routed_model, BETTER, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(w.id)).n);
    assert.equal(after, before, 'nothing switched back');
  } finally {
    betterRefused = false;
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
    // for a while, not for good: what a router may have lost is its table, and a later measurement can learn it afresh
    assert.equal(r.action, 'soft_revert');
    assert.equal((await db.prepare('SELECT status FROM arms WHERE id = ?').get(arm.id)).status, 'resting');
  } finally {
    cheapBroken = false;
  }
});

/* 6. The edges: three-way readings, and routers with specs that make no sense ----------------------------- */

test('a difference is forgiven only when both readings leave the customer\'s answer little chance of being better', async () => {
  let n = 0;
  // Jev as asked twice, with the candidate first in the first reading and second in the second
  const reading = (pCand, pRef, fail = false) => async (state) => {
    n += 1;
    if (fail && n % 2 === 0) throw new Error('Jev is busy');
    const candFirst = String(state.answers.first).startsWith('cand');
    const probabilities = { first: candFirst ? pCand : pRef, second: candFirst ? pRef : pCand, equal: Math.max(0, 1 - pCand - pRef) };
    return { answers: { better: { type: 'choice', probabilities } }, costUsd: 0.001 };
  };
  const ask3 = (tag, pCand, pRef, fail) => judgeBetter(`request ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: reading(pCand, pRef, fail) });
  assert.equal((await ask3('a', 0.7, 0.2)).verdict, 'better');
  assert.equal((await ask3('b', 0.5, 0.2)).verdict, 'equal');
  assert.equal((await ask3('c', 0.65, 0.35)).verdict, 'kept', 'better by a head, but the customer\'s answer kept a third of a chance');
  const busy = await ask3('d', 0.9, 0.05, true);
  assert.equal(busy.transient, true, 'one reading did not come back');
  assert.equal(busy.verdict, null);
  assert.ok(Math.abs(busy.cost - 0.001) < 1e-12, `the reading that did come back is paid for: ${busy.cost}`);
});

test('a reading that sends only its pick and how sure it was is read on the safe side', async () => {
  // Jev's pick in each order, with no chances beside it
  const picked = (candFirstPick, refFirstPick, confidence) => async (state) => {
    const candFirst = String(state.answers.first).startsWith('cand');
    return { answers: { better: { type: 'choice', choice: candFirst ? candFirstPick : refFirstPick, confidence } }, costUsd: 0.001 };
  };
  const ask3 = (tag, a, b, c) => judgeBetter(`request pick ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: picked(a, b, c) });
  assert.equal((await ask3('a', 'first', 'second', 0.9)).verdict, 'better', 'the candidate\'s answer picked, surely, both times');
  assert.equal((await ask3('b', 'equal', 'equal', 0.9)).verdict, 'equal', 'about equal, surely: forgiven, and no better');
  assert.equal((await ask3('c', 'equal', 'equal', 0.55)).verdict, 'kept', 'about equal only just: the customer\'s answer could have had nearly half');
  assert.equal((await ask3('d', 'first', 'first', 0.9)).verdict, 'kept', 'the customer\'s answer picked once');
  const none = await judgeBetter('request pick e', 'cand e', 'ref e', { askFn: async () => ({ answers: { better: { type: 'choice' } }, costUsd: 0.001 }) });
  assert.equal(none.transient, true, 'no pick and no chances is no reading');
  const odd = (tag, better) => judgeBetter(`request odd ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: async () => ({ answers: { better }, costUsd: 0.001 }) });
  assert.equal((await odd('f', { choice: 'neither', confidence: 0.9 })).transient, true, 'a pick that is none of the three is no reading');
  assert.equal((await odd('g', { choice: 'first', confidence: 1.4 })).transient, true, 'nor is a confidence that is not a chance');
  assert.equal((await odd('h', { probabilities: { first: 2, second: 0, equal: 0 } })).transient, true, 'nor a chance above one');
  assert.equal((await odd('i', { choice: 'second', confidence: 0.25 })).transient, true, 'nor a pick of three at under a third, which no pick can be');
});

test('a cascade\'s cheap model is served by the providers it was measured on first, and by others when they cannot', () => {
  const body = { messages: [{ role: 'user', content: 'Where is my order #5?' }] };
  const pinned = buildUpstream(body, CHEAP, { providers: ['deepinfra/fp8'] });
  assert.deepEqual(pinned.provider.only, ['deepinfra/fp8'], 'a model switched to on its own is held to them');
  assert.equal(pinned.provider.order, undefined);
  const preferred = buildUpstream(body, CHEAP, { providers: ['deepinfra/fp8'], preferred: true });
  assert.deepEqual(preferred.provider.order, ['deepinfra/fp8'], 'a cascade\'s cheap model asks them first');
  assert.equal(preferred.provider.allow_fallbacks, true, 'and others when they cannot answer');
  assert.equal(preferred.provider.only, undefined);
  const cascade = (recipe) => ({ kind: 'cascade', first: { model: CHEAP, recipe }, fallback: { model: REF, recipe: null } });
  assert.equal(armKey(cascade({ providers: ['deepinfra/fp8'], preferred: true })), armKey(cascade(null)), 'the same cascade, however its providers are held');
});

test('a reading of which answer serves better that did not come back counts the difference against what is served, never loosens the pass mark, and is asked again', async () => {
  const request = 'Where is my order #7101?';
  const ref = refText(7101);
  const cand = writerText(BETTER, 7101);
  betterRefused = true;
  try {
    const c = await judgeCandidate(request, cand, ref, null, { scope: 'unsettled' });
    assert.equal(c.score, 1, 'the difference stands');
    assert.ok(!c.transient, 'and the call is counted, not dropped, which flattered the candidate');
    assert.equal(c.unsettled, true);
    const served = await judgeBarPair(request, ref, cand, { scope: 'unsettled' });
    assert.equal(served.score, 1, 'the same for an answer held against the customer\'s');
    assert.equal(served.unsettled, true);
    const bar = await judgeBarPair(request, ref, cand, { scope: 'unsettled', bar: true });
    assert.equal(bar.transient, true, 'setting the pass mark, the pair is left out: counted, it would loosen the mark');
  } finally {
    betterRefused = false;
  }
  const again = await judgeCandidate(request, cand, ref, null, { scope: 'unsettled' });
  assert.equal(again.score, 0, 'never kept, so asked again once Jev reads it: forgiven');
  assert.equal(again.detail.better, 1, 'and the better one');
});

test('what serves is read without only the differences a reading left unsettled, never without a settled one beside them', async () => {
  const request = 'Where is my order #7301?';
  const cand = writerText(BETTER, 7301);
  betterRefused = true;
  try {
    // against one of the customer\'s answers the difference is in wording and unsettled; against the other, in the order number
    const figures = await judgeCandidate(request, cand, refText(7301), refText(7302), { scope: 'settled-a' });
    assert.equal(figures.score, 1, 'held against both, as anything that could be switched to is');
    assert.equal(figures.unsettled, true);
    assert.equal(figures.settled, 1, 'and for what serves, the difference in figures still stands');
    // against the other, the same answer with a word changed: for what serves, it agrees
    const alike = await judgeCandidate(request, cand, refText(7301), cand.replace('email.', 'email!'), { scope: 'settled-b' });
    assert.equal(alike.score, 0.5);
    assert.equal(alike.settled, 0, 'the unsettled one is left out, the settled one kept');
  } finally {
    betterRefused = false;
  }
});

test('different figures make a different answer against each of the customer\'s answers on its own', async () => {
  const request = 'Where is my order #7401?';
  // leaves out when it arrives, which one of the customer's answers says; and reads like the other, but with a different figure
  const cand = 'Order 7401 (3 boxes) shipped today.';
  const says = refText(7401);
  const figures = 'Order 7401 (4 boxes) shipped today.';
  const both = await judgeCandidate(request, cand, says, figures, { scope: 'figures-each' });
  assert.equal(both.score, 1, 'different from each of them, so different: floored over their average, it read as half');
  betterRefused = true;
  try {
    const open = await judgeCandidate(request, cand, says, figures, { scope: 'figures-open' });
    assert.equal(open.unsettled, true);
    assert.equal(open.score, 1);
    assert.equal(open.settled, 1, 'and the reading of what serves is never stricter than the one of what could be switched to');
  } finally {
    betterRefused = false;
  }
});

test('a router is known by the setups it chooses between, in whatever order they are listed', () => {
  const spec = (options) => ({ kind: 'router', version: 2, options, strong: { model: REF } });
  const two = [{ model: STEADY }, { model: CHEAP }];
  assert.equal(keyOfSpec(spec(two), REF), keyOfSpec(spec([...two].reverse()), REF));
  assert.equal(keyOfSpec(spec(two), REF), `router:${CHEAP}+${STEADY}~kinds`);
  assert.equal(armKey(spec(two)), armKey(spec([...two].reverse())));
});

test('a router whose spec names a setup it does not have, or none at all, sends the call to the customer\'s own model', () => {
  const body = { messages: [{ role: 'user', content: 'Where is my order #5?' }] };
  const kindsSpec = (extra) => ({ kind: 'router', version: 2, options: [{ model: CHEAP }], strong: { model: REF },
    centroids: [new Array(256).fill(0)], minSim: [0], idf: new Array(256).fill(1), table: [3], sizes: [10], ...extra });
  const missing = routeFor(kindsSpec(), body);
  assert.equal(missing.use.model, REF, 'the table names setup 3 of 1');
  assert.equal(missing.escalated, true);
  assert.equal(missing.check.why, 'no such setup');
  const noStrong = routeFor(kindsSpec({ strong: null }), body, { fallback: { model: 'fallback/model' } });
  assert.equal(noStrong.use.model, 'fallback/model');
  assert.equal(routeFor(kindsSpec({ strong: null }), body).use, null, 'with nothing at all, nothing, for the caller to answer the usual way');
  const unreadable = routeFor({ ...kindsSpec(), centroids: null }, { messages: [{ role: 'user', content: { odd: true } }] });
  assert.equal(unreadable.use.model, REF);
  // the older kind, with its weights gone
  const old = routeFor({ kind: 'router', cheap: { model: CHEAP }, strong: { model: REF }, threshold: 0.5, weights: null }, body);
  assert.equal(old.use.model, REF);
});

/* 7. A cautious workload with nothing it is sure enough of ------------------------------------------------ */

test('what a cautious workload is not sure enough of is never looked at again, offered or tried, and it says so', async () => {
  const sure = config.CAUTIOUS_MIN_CHANCE;
  // surer than 120 clean calls can ever make anything, so both setups that clear are left out
  config.CAUTIOUS_MIN_CHANCE = 0.9999;
  try {
    const shop = await seed({ enabled: [THIN, QUICK], workspaceRouting: 'cautious' });
    const out = await runEvaluation(shop.workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await resultsOf(out.runId);
    for (const m of [THIN, QUICK]) {
      const r = rows.find((x) => x.model_id === m);
      assert.equal(r.verdict, 'cleared');
      assert.equal(r.confirm_verdict, 'left_out', `${m} was left out, not "not reached"`);
      assert.equal(r.confirm_runs, null, 'and never looked at again');
    }
    assert.deepEqual(cheaperCleared(rows), [], 'nothing is offered to approve');
    const w = await load(shop.workload.id);
    assert.equal(w.routed_model, null, 'nothing switched');
    assert.equal(w.status_note, 'A candidate cleared, but not surely enough for a cautious workload');
    const said = await db.prepare(`SELECT title, detail FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(shop.workload.id);
    assert.match(said.title, /not surely enough for a cautious workload/);
    assert.doesNotMatch(said.detail, /most one measurement may spend/, 'never put down to money');
    const trying = await db.prepare(`SELECT COUNT(*) AS n FROM arms WHERE workload_id = ? AND status = 'trying'`).get(shop.workload.id);
    assert.equal(Number(trying.n), 0, 'and not tried on live calls, where an experiment could switch to it');
  } finally {
    config.CAUTIOUS_MIN_CHANCE = sure;
  }
});

/* 8. A router whose setup is refused outright ------------------------------------------------------------- */

test('a setup refused on every request fails the router it is part of, whatever kind of request comes first', async () => {
  const shop = await seed({ enabled: [CHEAP, STEADY] });
  const first = await runEvaluation(shop.workload.id);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await armOf(shop.workload.id))?.kind, 'router', 'switched to a router by kind of request');
  // no provider will take the steady setup any more, whatever it is asked
  refusing.set(STEADY, () => 404);
  try {
    const out = await runEvaluation(shop.workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    /* It answers the requests the router sends it first, so the refusal lands on one of them. Asked in the order
       the calls were drawn, it met a question about an order first two times in three and stopped there; the
       router then read as judged on too few calls, and went on serving with a setup that could answer nothing. */
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.equal(row.verdict, 'failed', `${row.verdict} on ${row.runs} calls`);
    assert.equal(row.stopped, 'refused');
    const asked = await db.prepare(`SELECT c.request_json FROM eval_replays r JOIN calls c ON c.id = r.call_id
        WHERE r.run_id = ? AND r.model_id = ?`).all(out.runId, STEADY);
    assert.equal(asked.length, 1, 'refused once, and stopped there');
    assert.match(asked[0].request_json, /refund/i, 'on a refund complaint, a request the router sends it');
    assert.equal((await load(shop.workload.id)).routed_model, null, 'switched back to the customer\'s own model');
  } finally {
    refusing.delete(STEADY);
  }
});
