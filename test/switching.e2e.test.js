/* Switching that starts small, stays in the customer's hands, and tells them, end to end: the whole
   app as it is deployed, a provider and a Jev we control, a real database.

   What is checked: a call can insist on the model it names, and every answer says which model gave it;
   a switch starts on a small share of calls, grows while its calls hold up, and rolls itself back when
   they do not; a strategy switched back again and again stays out longer each time; the customer's own
   spending limits stop calls rather than spend past them, and say so by email; Settings changes what
   they should; long instructions are marked for caching only where it pays, and the saving is counted
   honestly; a few live answers are read in the background within a budget; live checks always find a
   place with Jev; a conversation stays on one strategy; and a helpful answer is never read as a refusal. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4821;
const APP_PORT = 4822;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_switch_${process.pid}`;
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
process.env.JOBS_ENABLED = 'false';
// Jev through a stand-in we control, to see live checks keep their places
process.env.JEV_VIA = 'typesafe';
process.env.TYPESAFE_API_KEY = 'test-typesafe';
process.env.TYPESAFE_BASE = `http://127.0.0.1:${PORT}/typesafe`;
process.env.JEV_CONCURRENCY = '3';
process.env.JEV_LIVE_RESERVED = '1';
process.env.ALERTS_ENABLED = 'false';
process.env.REQUEST_LOGS = 'false';
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.CACHE_HINT_MIN_PER_HOUR = '3';
process.env.EVAL_JUDGE_MODEL = 'judge/small';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled, dailySpend } = await import('../src/traffic.js');
const { saveCatalog, buildUpstream, hintApplies } = await import('../src/openrouter.js');
const { move } = await import('../src/billing.js');
const { promote, revert, heldBack, everReverted, rollBack } = await import('../src/eval/promote.js');
const { chooseStrategy } = await import('../src/learn/choose.js');
const { reviewWorkload, forgetState } = await import('../src/learn/explore.js');
const { gradeWorkload } = await import('../src/learn/grade.js');
const { ask, jevSlots } = await import('../src/jev.js');
const { adviceFor } = await import('../src/eval/advice.js');
const { routedSavings } = await import('../src/eval/actual.js');
const { refused } = await import('../src/learn/threads.js');
const { notify } = await import('../src/notify.js');
const { upsertArm, referenceSpec } = await import('../src/learn/arms.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/steady-small';
const CLAUDE = 'anthropic/claude-sonnet-5';
const DAY = 86400000;

// what the provider was sent, for the cache marking to be seen
const sent = [];
let jevHold = null;
let jevActive = 0;
let jevPeak = 0;
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = JSON.parse(body || '{}');
    if (req.url.endsWith('/systemone')) {
      jevActive += 1;
      jevPeak = Math.max(jevPeak, jevActive);
      if (jevHold) await jevHold;
      jevActive -= 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'typesafe/jev', answers: { check: { choice: 'fine', confidence: 0.9, probabilities: { fine: 0.9, doubtful: 0.09, fails: 0.01 } } },
        usage: { input_tokens: 200 } }));
      return;
    }
    sent.push(p);
    const model = p.model;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `gen-${sent.length}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `answer from ${model}` } }],
      usage: { prompt_tokens: 1200, completion_tokens: 40, cost: model === REF ? 0.004 : 0.0004,
        prompt_tokens_details: { cached_tokens: model === CLAUDE && sent.length > 1 ? 1000 : 0 } } }));
  });
});
let server = null;
const base = `http://127.0.0.1:${APP_PORT}`;

// what would have been emailed, since nothing leaves the building in a test
const mail = [];
const realLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.includes('[no RESEND_API_KEY')) { mail.push(s); return; }
  realLog(...a);
};

test.before(async () => {
  await new Promise((r) => provider.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: CLAUDE, name: 'claude', context_len: 200000, price_in: 3e-6, price_out: 15e-6, open_weights: 0, zdr: 1, price_cache_read: 0.3e-6 },
    { model_id: 'judge/small', name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
  ]);
});

test.after(async () => {
  console.log = realLog;
  await new Promise((r) => provider.close(r));
  await new Promise((r) => server.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

let seq = 0;
async function shop({ credit = 20 } = {}) {
  seq += 1;
  const email = `switch-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password: 'correct-horse-battery', name: `s${seq}` });
  if (credit) await move(workspace.id, { kind: 'credit', amountUsd: credit, note: 'test' });
  const key = await issueKey(workspace.id, 'switching');
  return { workspace, email, secret: key.secret };
}
const request = (i, { model = REF, system = 'Classify the ticket.' } = {}) => ({
  model, messages: [{ role: 'system', content: system }, { role: 'user', content: `ticket #${i}` }],
});
const send = async (secret, body, headers = {}) => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  await learningSettled();
  return { status: res.status, json, served: res.headers.get('x-understudy-served-model'), workload: res.headers.get('x-understudy-workload'),
    callId: res.headers.get('x-understudy-call-id') };
};
const load = (id) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(id);

test('a call can insist on the model it names, and every answer says which model gave it', async () => {
  const s = await shop();
  const first = await send(s.secret, request(1));
  assert.equal(first.status, 200);
  assert.equal(first.served, REF);
  assert.ok(first.workload, 'the workload the call joined');
  const w = await db.prepare('SELECT * FROM workloads WHERE slug = ? AND workspace_id = ?').get(first.workload, s.workspace.id);
  await promote(w, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const switched = await send(s.secret, request(2));
  assert.equal(switched.served, CHEAP, 'switched, and the answer says so');
  const pinned = await send(s.secret, request(3), { 'x-understudy-pin': '1' });
  assert.equal(pinned.served, REF, 'a pinned call is answered by the model it names');
  const inBody = await send(s.secret, { ...request(4), metadata: { understudy_pin: true } });
  assert.equal(inBody.served, REF);
  // nothing of ours reaches the provider
  assert.equal(sent[sent.length - 1].metadata, undefined);
});

test('a switch starts on a small share of calls, grows while its calls hold up, and serves all of them in the end', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null } });
  let w = await load(w0.id);
  assert.equal(Number(w.rollout_share), config.ROLLOUT_STAGES[0]);
  assert.equal(Number(w.rollout_stage), 0);
  // the share decides, by chance, and the chance is recorded
  const pickNew = await chooseStrategy(w, { rng: () => 0.01 });
  const pickOld = await chooseStrategy(w, { rng: () => 0.99 });
  assert.equal(pickNew.spec.model, CHEAP);
  assert.equal(pickNew.propensity, config.ROLLOUT_STAGES[0]);
  assert.equal(pickOld.spec.model, REF, 'the rest stay on the customer\'s own model');
  assert.ok(Math.abs(pickOld.propensity - (1 - config.ROLLOUT_STAGES[0])) < 1e-9);
  // calls answered on both sides, and the stage started long enough ago
  const write = async (armId, model, n, propensity, { failed = 0 } = {}) => {
    for (let i = 0; i < n; i += 1) {
      await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: model,
        statusCode: i < failed ? 502 : 200, promptTokens: 100, completionTokens: 10, costUsd: 0.001, request: request(10000 + seq * 1000 + i),
        response: { choices: [{ message: { content: 'ok' } }] }, armId, propensity, explored: 0 });
    }
  };
  const baseline = await upsertArm(w, referenceSpec(w), { status: 'baseline', offline: { ratio: 1 } });
  await write(w.routed_arm_id, CHEAP, 40, 0.05);
  await write(baseline.id, REF, 60, 0.95);
  await db.prepare('UPDATE workloads SET rollout_started_at = ? WHERE id = ?').run(now() - 3 * 3600000, w.id);
  forgetState(w.id);
  let d = await reviewWorkload(w);
  assert.equal(d[0]?.kind, 'advance', JSON.stringify(d));
  w = await load(w.id);
  assert.equal(Number(w.rollout_share), config.ROLLOUT_STAGES[1]);
  // not before its hours at the new share
  forgetState(w.id);
  assert.deepEqual(await reviewWorkload(w), []);
  await write(w.routed_arm_id, CHEAP, 40, 0.25);
  await db.prepare('UPDATE workloads SET rollout_started_at = ? WHERE id = ?').run(now() - 13 * 3600000, w.id);
  forgetState(w.id);
  d = await reviewWorkload(await load(w.id));
  assert.equal(d[0]?.kind, 'complete', JSON.stringify(d));
  w = await load(w.id);
  assert.equal(w.rollout_share, null, 'every call now');
  assert.equal(w.routed_model, CHEAP);
  const all = await chooseStrategy(w, { rng: () => 0.99 });
  assert.equal(all.spec.model, CHEAP);
  assert.ok(mail.some((m) => m.includes('now runs fully on steady')), 'told by email');
});

test('a switch whose calls fail more than what served before it is rolled back on its own, and waits before it can return', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Route the email.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null } });
  const w = await load(w0.id);
  const baseline = await upsertArm(w, referenceSpec(w), { status: 'baseline', offline: { ratio: 1 } });
  for (let i = 0; i < 60; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP,
      statusCode: i % 3 === 0 ? 502 : 200, promptTokens: 100, completionTokens: 10, costUsd: 0.001, request: request(20000 + i),
      armId: w.routed_arm_id, propensity: 0.05, explored: 0 });
  }
  for (let i = 0; i < 60; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: REF,
      statusCode: 200, promptTokens: 100, completionTokens: 10, costUsd: 0.004, request: request(30000 + i),
      armId: baseline.id, propensity: 0.95, explored: 0 });
  }
  forgetState(w.id);
  const d = await reviewWorkload(w);
  assert.equal(d[0]?.kind, 'rollback', JSON.stringify(d));
  const after = await load(w.id);
  assert.equal(after.routed_model, null, 'back on the customer\'s own model');
  assert.equal(after.rollout_share, null);
  const p = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(w.id);
  assert.equal(p.action, 'soft_revert');
  assert.match(p.reason, /calls failed/);
  assert.ok(await everReverted(w.id, CHEAP), 'and it waits before it can be switched to again');
});

test('a strategy switched back again and again stays out longer each time, and for good after the third', async () => {
  const s = await shop();
  const w = await workloadFor(s.workspace.id, request(1, { system: 'Tag the invoice.' }));
  const back = async (daysAgo) => db.prepare(`INSERT INTO promotions (id, workload_id, action, from_model, to_model, reason, created_at)
      VALUES (?, ?, 'soft_revert', ?, ?, 'test', ?)`).run(`prm_${Math.random().toString(36).slice(2)}`, w.id, CHEAP, REF, now() - daysAgo * DAY);
  await back(10);
  assert.equal((await heldBack(w.id)).has(CHEAP), false, 'once, ten days ago: the week has passed');
  await back(10);
  assert.equal((await heldBack(w.id)).has(CHEAP), true, 'twice: it waits two weeks');
  await back(40);
  assert.equal((await heldBack(w.id)).has(CHEAP), true, 'three times: until a person approves it');
});

test('a daily spending limit refuses calls rather than spend past it, says when they resume, and emails once', async () => {
  const s = await shop();
  await db.prepare('UPDATE workspaces SET daily_limit_usd = 0.005 WHERE id = ?').run(s.workspace.id);
  const ok = await send(s.secret, request(1, { system: 'Summarise.' }));
  assert.equal(ok.status, 200);
  const again = await send(s.secret, request(2, { system: 'Summarise.' }));
  assert.equal(again.status, 200, 'the second call takes it past the limit');
  const refused = await send(s.secret, request(3, { system: 'Summarise.' }));
  assert.equal(refused.status, 402);
  assert.match(refused.json.error.message, /daily limit of \$0\.01 is reached\. Calls resume at midnight IST/);
  assert.equal(refused.json.error.type, 'daily_limit');
  await send(s.secret, request(4, { system: 'Summarise.' }));
  await new Promise((r) => setTimeout(r, 100));
  const told = await db.prepare(`SELECT * FROM notifications WHERE workspace_id = ? AND kind = 'money'`).all(s.workspace.id);
  assert.equal(told.length, 1, 'one email for the limit, however many calls it refuses');
});

test('an email is sent once for one event, only if the workspace wants that kind, and never more than a day\'s share', async () => {
  const s = await shop();
  const one = await notify(s.workspace.id, 'waiting', 'wl1:run1', { title: 'A model cleared', lines: ['It did.'] });
  const twice = await notify(s.workspace.id, 'waiting', 'wl1:run1', { title: 'A model cleared', lines: ['It did.'] });
  assert.equal(one.sent, true);
  assert.equal(twice.reason, 'already told');
  await db.prepare('UPDATE workspaces SET notify_json = ? WHERE id = ?').run(JSON.stringify({ waiting: false }), s.workspace.id);
  assert.equal((await notify(s.workspace.id, 'waiting', 'wl1:run2', { title: 'Another' })).reason, 'switched off');
  let capped = null;
  for (let k = 0; k < config.NOTIFY_MAX_PER_DAY + 1; k += 1) capped = await notify(s.workspace.id, 'switched', `wl:${k}`, { title: `Switch ${k}` });
  assert.equal(capped.reason, 'enough for today');
});

test('Settings changes what it says: default switching, sharing, the budget, cache marking, limits and emails', async () => {
  const s = await shop();
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.50' },
    body: JSON.stringify({ email: s.email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const call = async (path, body) => {
    const x = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: x.status, json: await x.json() };
  };
  let st = (await call('/settings')).json;
  assert.equal(st.defaultOptimizeMode, 'ask', 'a new workspace asks before switching');
  assert.equal(st.shareStats, false);
  assert.equal(st.cacheHints, true);
  assert.equal(st.limits.dailyUsd, null);
  assert.equal((await call('/settings/default-mode', { mode: 'auto' })).status, 200);
  assert.equal((await call('/settings/default-mode', { mode: 'sometimes' })).status, 400);
  assert.equal((await call('/settings/share-stats', { enabled: true })).status, 200);
  assert.equal((await call('/settings/optimize-budget', { amountUsd: 12.5 })).status, 200);
  assert.equal((await call('/settings/optimize-budget', { amountUsd: -1 })).status, 400);
  assert.equal((await call('/settings/cache-hints', { enabled: false })).status, 200);
  assert.equal((await call('/settings/limits', { dailyUsd: 5, monthlyUsd: 50 })).status, 200);
  assert.equal((await call('/settings/limits', { dailyUsd: 60, monthlyUsd: 50 })).status, 400, 'a day cannot allow more than a month');
  assert.equal((await call('/settings/notify', { kinds: { money: false } })).status, 200);
  st = (await call('/settings')).json;
  assert.equal(st.defaultOptimizeMode, 'auto');
  assert.equal(st.shareStats, true);
  assert.equal(st.optimizeBudget, 12.5);
  assert.equal(st.cacheHints, false);
  assert.equal(st.limits.dailyUsd, 5);
  assert.equal(st.limits.monthlyUsd, 50);
  assert.equal(st.notify.money, false);
  assert.equal(st.notify.switched, true);
  // new workloads follow the default
  const w = await workloadFor(s.workspace.id, request(1, { system: 'A brand new job.' }));
  assert.equal(w.optimize_mode, 'auto');
});

test('a long instruction is marked for caching only where calls come often enough, and what it saves is counted as ours', async () => {
  const long = `You are the support assistant. ${'Follow the policy exactly and cite the section. '.repeat(120)}`;
  assert.equal(hintApplies({ messages: [{ role: 'system', content: long }] }, CLAUDE), true);
  assert.equal(hintApplies({ messages: [{ role: 'system', content: 'Short.' }] }, CLAUDE), false, 'too short to be cached');
  assert.equal(hintApplies({ messages: [{ role: 'system', content: long }] }, REF), false, 'a model that caches by itself');
  assert.equal(hintApplies({ messages: [{ role: 'system', content: [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }] }] }, CLAUDE), false,
    'the customer marked it already');
  const marked = buildUpstream({ messages: [{ role: 'system', content: long }, { role: 'user', content: 'hi' }] }, CLAUDE, null, { cacheHint: true });
  assert.equal(marked.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(marked.messages[0].content[0].text, long, 'the words are exactly the customer\'s');
  // live: after a few calls an hour, the next ones are marked
  const s = await shop();
  const body = { model: CLAUDE, messages: [{ role: 'system', content: long }, { role: 'user', content: 'ticket #1' }] };
  for (let i = 0; i < 4; i += 1) await send(s.secret, body);
  // the rate is read at most every five minutes a workload: read it again now, with four calls in the hour
  const { forgetHints } = await import('../src/workspace.js');
  forgetHints();
  const firstSent = sent.filter((p) => p.model === CLAUDE)[0];
  assert.equal(typeof firstSent.messages[0].content, 'string', 'the first calls, before the rate was known, went as they came');
  await send(s.secret, body);
  const lastSent = sent.filter((p) => p.model === CLAUDE).pop();
  assert.equal(lastSent.messages[0].content[0].cache_control.type, 'ephemeral', 'marked, now that calls come often enough');
  const hinted = await db.prepare(`SELECT * FROM calls WHERE workspace_id = ? AND hinted = 1`).all(s.workspace.id);
  assert.equal(hinted.length, 1);
  // what it would have cost unmarked: every prompt token at the full price
  const saved = await routedSavings({ workspaceId: s.workspace.id, days: 1, at: now() });
  const unmarked = 1200 * 3e-6 + 40 * 15e-6;
  assert.ok(saved.would >= unmarked - 1e-9, `the marked call is held to ${unmarked}: ${saved.would}`);
  // and a workspace that says no is never marked
  await db.prepare('UPDATE workspaces SET cache_hints = 0 WHERE id = ?').run(s.workspace.id);
  const { forgetWorkspace } = await import('../src/workspace.js');
  forgetWorkspace(s.workspace.id);
  forgetHints();
  await send(s.secret, body);
  assert.equal(typeof sent.filter((p) => p.model === CLAUDE).pop().messages[0].content, 'string');
});

test('a few live answers are read in the background, within the day\'s budget, and paid for as optimizing', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Grade me.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const w = await load(w0.id);
  for (let i = 0; i < 30; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP,
      statusCode: 200, promptTokens: 100, completionTokens: 10, costUsd: 0.0004, request: request(40000 + i),
      response: { choices: [{ finish_reason: 'stop', message: { content: 'an answer' } }] }, armId: w.routed_arm_id, propensity: 0.95, explored: 0 });
  }
  const askModel = async () => ({ json: { choices: [{ message: { content: 'WRONG' } }], usage: { cost: 0.001 } } });
  const r = await gradeWorkload(w, { perArm: 12, budgetUsd: 1, askJev: async () => { throw new Error('no jev here'); }, askModel });
  assert.equal(r.graded, 12, 'as many as the day allows a strategy');
  const rows = await db.prepare('SELECT * FROM graded_calls WHERE workload_id = ?').all(w.id);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((x) => Number(x.bad) === 1));
  const again = await gradeWorkload(w, { perArm: 12, budgetUsd: 1, askJev: async () => { throw new Error('no jev'); }, askModel });
  assert.equal(again.graded, 0, 'not past the day\'s share');
  const { optimizeSpent } = await import('../src/billing.js');
  assert.ok(await optimizeSpent(s.workspace.id) > 0.01, 'paid for as optimizing');
  const tight = await gradeWorkload(w, { perArm: 100, budgetUsd: 0.0001, askJev: async () => { throw new Error('no'); }, askModel });
  assert.equal(tight.graded, 0, 'never past the day\'s budget');
});

test('a live check always finds a place with Jev, however much background work is waiting', async () => {
  let release = null;
  jevHold = new Promise((r) => { release = r; });
  const background = [0, 1, 2, 3].map(() => ask({ x: 1 }, { check: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }).catch(() => null));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(jevSlots().background, 2, 'background work takes every place but the reserved one');
  const live = ask({ x: 1 }, { check: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, { wait: false, retries: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(jevSlots().active, 3, 'the live check has its place');
  release();
  jevHold = null;
  await live;
  await Promise.all(background);
  assert.equal(jevSlots().active, 0);
});

test('advice: a cap on answer length where a few answers run far longer than the rest', async () => {
  const s = await shop();
  const w = await workloadFor(s.workspace.id, request(1, { system: 'Write the reply.' }));
  for (let i = 0; i < 100; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 300, completionTokens: i % 50 === 0 ? 6000 : 150, costUsd: 0.002, request: request(50000 + i),
      response: { choices: [{ message: { content: 'x' } }] } });
  }
  const advice = await adviceFor(await load(w.id));
  const cap = advice.find((a) => a.kind === 'answer_cap');
  assert.ok(cap, JSON.stringify(advice));
  assert.ok(cap.cap >= 256 && cap.cap < 6000);
  assert.ok(cap.monthlyUsd > 0);
  assert.match(cap.detail, /Leave it if the long answers are the point/);
});

test('a conversation stays on the strategy it started with', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Chat with the customer.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null } });
  const w = await load(w0.id);
  // the first turn went to the customer's own model by chance
  const baseline = await upsertArm(w, referenceSpec(w), { status: 'baseline', offline: { ratio: 1 } });
  const turn1 = { model: REF, messages: [{ role: 'system', content: 'Chat with the customer.' }, { role: 'user', content: 'hello #1' }] };
  await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: REF, statusCode: 200,
    promptTokens: 10, completionTokens: 5, costUsd: 0.001, request: turn1,
    response: { choices: [{ message: { role: 'assistant', content: 'hi there' } }] }, armId: baseline.id, propensity: 0.95, explored: 0 });
  const turn2 = { ...turn1, messages: [...turn1.messages, { role: 'assistant', content: 'hi there' }, { role: 'user', content: 'and then?' }] };
  const pick = await chooseStrategy(w, { rng: () => 0.001, body: turn2 });
  assert.equal(pick.spec.model, REF, 'the second turn goes where the first did, whatever the draw says');
  assert.equal(pick.task, true);
});

test('a helpful answer that opens with an apology is not a refusal', () => {
  assert.equal(refused("I'm sorry to hear that. Here is how to reset it: open Settings and press Reset."), false);
  assert.equal(refused("I can't wait to help. Here is the plan."), false);
  assert.equal(refused("I'm sorry, but I can't help with that."), true);
  assert.equal(refused('I cannot provide that.'), true);
});
