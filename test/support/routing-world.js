/* The world the routing tests run in (test/routing*.e2e.test.js): a provider and a Jev we control, answering on ports
   of their own, a database of each test file's own, and for each scenario a workspace with a workload of calls through
   Understudy. `stand` holds what the stand-in has gone wrong on, which a scenario sets and puts back.

   The tests are in three files so that the slow ones, each a real measurement against a customer's model that takes its
   time to answer, can run on machines of their own on GitHub: routing-balance and routing-cost hold what a workload
   optimizes for, and routing the rest. */

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

const { db, now } = await import('../../src/db/index.js');
const { default: migrate } = await import('../../src/db/migrate.js');
const { createAccount } = await import('../../src/auth.js');
const { issueKey } = await import('../../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../../src/traffic.js');
const { saveCatalog } = await import('../../src/openrouter.js');
const { runEvaluation } = await import('../../src/eval/run.js');
const { move } = await import('../../src/billing.js');
const { default: v1 } = await import('../../src/proxy.js');
const { onServed } = await import('../../src/learn/choose.js');
const { afterServed, reviewWorkload, forgetState } = await import('../../src/learn/explore.js');
const { controlRecord, maybeControl, scoreServed, barOf, forgetBar } = await import('../../src/learn/control.js');
const { optimizeSpent } = await import('../../src/billing.js');
const { judgeBetter, judgeCandidate, judgeBarPair } = await import('../../src/eval/judge.js');
const { keyOfSpec } = await import('../../src/eval/promote.js');
const { armKey } = await import('../../src/learn/arms.js');
const { planFor } = await import('../../src/eval/plan.js');
const { buildUpstream } = await import('../../src/openrouter.js');
const { routeFor } = await import('../../src/learn/serve.js');
const { cheaperCleared } = await import('../../src/eval/outcome.js');
const { zdrFor } = await import('../../src/workspace.js');
const { runPageOf } = await import('../../src/workloadPage.js');
const { default: config } = await import('../../src/config.js');

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
/* How long the customer's own model takes, for the scenarios about what a workload optimizes for: a speed score is how
   much sooner a model answers than the customer's own, which the stand-in otherwise answers at once, so nothing could be
   sooner. The rest of the tests leave it at nothing, so they take no longer. */
let refDelay = 0;
const withRefDelay = async (ms, fn) => {
  refDelay = ms;
  try { return await fn(); } finally { refDelay = 0; }
};
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

/* What the stand-in has gone wrong on, for the scenarios that break something after a switch (the quick and the cheap
   model answering wrong) or where Jev does not answer "which serves better" at all; and how many times Jev was asked. */
const stand = { quickBroken: false, cheapBroken: false, betterRefused: false, jevAsked: 0 };
// models whose provider answers with this status instead, for the scenarios where one is too busy to answer
const failing = new Map();
// models whose provider refuses some requests: model to a rule on the request's text, giving the status or nothing
const refusing = new Map();

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
  if (model === QUICK && stand.quickBroken) return JSON.stringify({ order: i, status: 'lost', refund: null });
  if (model === CHEAP && (isRefund(i) || stand.cheapBroken)) return JSON.stringify({ order: i, status: 'shipped', refund: 'none' });
  return JSON.stringify(right(i));
};

/* Jev, as the app asks it: which of two answers serve the person as well (noul), what the main difference
   is (choice), which of two serves better (choice, asked in both orders), and whether an answer served
   live is fine (choice). The labels of the answers are shuffled, so they are read from each question. */
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
      stand.jevAsked += 1;
      // a refusal that passes by itself and is never retried: the one reading just does not come back
      if (stand.betterRefused && payload.questions?.better) {
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
    }, (DELAY[model] || 0) + (model === REF ? refDelay : 0));
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

export { db, now, learningSettled, runEvaluation, onServed, afterServed, reviewWorkload, forgetState, controlRecord,
  maybeControl, scoreServed, barOf, forgetBar, optimizeSpent, judgeBetter, judgeCandidate, judgeBarPair, keyOfSpec,
  armKey, planFor, buildUpstream, routeFor, cheaperCleared, zdrFor, runPageOf, config, REF, THIN, QUICK, CHEAP,
  STEADY, BETTER, WORSE, withRefDelay, right, stand, failing, refusing, refText, writerText, seed, load, runOf,
  resultsOf, resultOf, armOf, send, callRow };
