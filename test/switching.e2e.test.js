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
const { reviewWorkload, reviewAll, forgetState } = await import('../src/learn/explore.js');
const { gradeWorkload } = await import('../src/learn/grade.js');
const { ask, jevSlots } = await import('../src/jev.js');
const { adviceFor } = await import('../src/eval/advice.js');
const { routedSavings } = await import('../src/eval/actual.js');
const { refused } = await import('../src/learn/threads.js');
const { saveDef } = await import('../src/learn/outcomes.js');
const { diffRange } = await import('../src/learn/decide.js');
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
// models the provider says are overloaded, to send a switched call on to the customer's own model
const failing = new Set();
// models whose answers state no cost, and models whose answers say nothing about their usage at all
const noCost = new Set();
const noUsage = new Set();
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
    if (failing.has(model)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Provider is overloaded' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const usage = { prompt_tokens: 1200, completion_tokens: 40, cost: model === REF ? 0.004 : 0.0004,
      prompt_tokens_details: { cached_tokens: model === CLAUDE && sent.length > 1 ? 1000 : 0 } };
    if (noCost.has(model)) delete usage.cost;
    res.end(JSON.stringify({ id: `gen-${sent.length}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `answer from ${model}` } }],
      ...(noUsage.has(model) ? {} : { usage }) }));
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

/* A switch taking over from the customer's own model, begun `hoursAgo`, and its calls written in bulk. */
async function rolling(system, { hoursAgo = 2, stage = 0 } = {}) {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null } });
  const baseline = await upsertArm(await load(w0.id), referenceSpec(w0), { status: 'baseline', offline: { ratio: 1 } });
  await db.prepare('UPDATE workloads SET promoted_at = ?, rollout_started_at = ?, rollout_stage = ?, rollout_share = ? WHERE id = ?')
    .run(now() - hoursAgo * 3600000, now() - hoursAgo * 3600000, stage, config.ROLLOUT_STAGES[stage], w0.id);
  const w = await load(w0.id);
  const write = (armId, model, n, propensity, extra = {}) => bulkCalls({ workspaceId: s.workspace.id, workloadId: w.id, armId, model, n, propensity,
    cost: model === REF ? 0.004 : 0.0004, ...extra });
  return { s, w, baseline, write };
}

test('a switch taking over is read over the same traffic on both sides, whatever share each stage gave it', async () => {
  const { w, baseline, write } = await rolling('Price the repair.');
  /* Two stages: at five in a hundred, when one call in a hundred failed everywhere, and at twenty five in a
     hundred, when an incident failed one in five everywhere. Pooled as they came, most of the new
     strategy's calls fell in the bad stage, and it read as clearly worse than what it replaces. */
  await write(w.routed_arm_id, CHEAP, 198, 0.05);
  await write(w.routed_arm_id, CHEAP, 2, 0.05, { status: 502 });
  await write(baseline.id, REF, 3762, 0.95);
  await write(baseline.id, REF, 38, 0.95, { status: 502 });
  await write(w.routed_arm_id, CHEAP, 800, 0.25);
  await write(w.routed_arm_id, CHEAP, 200, 0.25, { status: 502 });
  await write(baseline.id, REF, 2400, 0.75);
  await write(baseline.id, REF, 600, 0.75, { status: 502 });
  forgetState(w.id);
  const d = await reviewWorkload(w);
  assert.notEqual(d[0]?.kind, 'rollback', `the same incident on both sides is neither's doing: ${JSON.stringify(d)}`);
  assert.equal((await load(w.id)).routed_model, CHEAP);
});

test('a switch taking over is judged on answers old enough to have been heard about, on both sides alike', async () => {
  const { w, baseline, write } = await rolling('Draft the reply to the landlord.');
  await saveDef(w.id, { events: [{ event: 'reply_rewritten', means: 'failed' }] });
  // settled calls: one in four of the new strategy's answers failed, one in fifty of the customer's own
  await write(w.routed_arm_id, CHEAP, 90, 0.05);
  await write(w.routed_arm_id, CHEAP, 30, 0.05, { reward: 0 });
  await write(baseline.id, REF, 392, 0.95);
  await write(baseline.id, REF, 8, 0.95, { reward: 0 });
  // and six hundred of the new strategy's from the last minute, too fresh for anything to have been said about them
  await write(w.routed_arm_id, CHEAP, 600, 0.05, { at: now() - 60000 });
  forgetState(w.id);
  const d = await reviewWorkload(w);
  assert.equal(d[0]?.kind, 'rollback', JSON.stringify(d));
  assert.match(d[0].reason, /its calls worked 75\.0% of 120 calls, against 98\.0% of 400 calls/, 'from the settled calls alone');
});

test('the three kinds of evidence a switch is rolled back on share the chance of being wrong', async () => {
  const { w, baseline, write } = await rolling('Sort the meter readings.');
  const rec = (n, bad) => ({ a: n - bad + 0.5, b: bad + 0.5 });
  const nNew = 300;
  const nBefore = 2000;
  const badBefore = 20;
  /* a number of failed calls that a range at half the chance would call clearly worse, and one at a third
     would not: what the switch is rolled back on once the chance is shared three ways, not given to each */
  let bad = null;
  for (let k = 1; k < nNew && bad === null; k += 1) {
    const lo = (alpha) => diffRange(rec(nNew, k), rec(nBefore, badBefore), { alpha }).lo;
    if (lo(config.LEARN_ALPHA / 2) > config.ROLLOUT_ERROR_MARGIN && lo(config.LEARN_ALPHA / 3) <= config.ROLLOUT_ERROR_MARGIN) bad = k;
  }
  assert.ok(bad, 'there is such a number');
  await write(w.routed_arm_id, CHEAP, nNew - bad, 0.05);
  await write(w.routed_arm_id, CHEAP, bad, 0.05, { status: 502 });
  await write(baseline.id, REF, nBefore - badBefore, 0.95);
  await write(baseline.id, REF, badBefore, 0.95, { status: 502 });
  forgetState(w.id);
  const d = await reviewWorkload(w);
  assert.notEqual(d[0]?.kind, 'rollback', `${bad} of ${nNew} failed: not enough, with the chance shared: ${JSON.stringify(d)}`);
});

test('a switch on a quiet workload that takes over without enough calls to compare says so, in the feed and the email', async () => {
  // the last share, a day and an hour in, with a dozen calls on the new strategy and forty on the customer's own model
  const { s, w, baseline, write } = await rolling('Chase the late payment.', { hoursAgo: 25, stage: config.ROLLOUT_STAGES.length - 1 });
  await write(w.routed_arm_id, CHEAP, 12, config.ROLLOUT_STAGES.at(-1));
  await write(baseline.id, REF, 40, 1 - config.ROLLOUT_STAGES.at(-1));
  forgetState(w.id);
  const before = mail.length;
  const d = await reviewWorkload(w);
  assert.equal(d[0]?.kind, 'complete', JSON.stringify(d));
  assert.equal(d[0].compared, false);
  const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(w.id);
  assert.match(act.detail, /not on evidence: there were too few calls to compare it with gpt-5\.4 \(yours\): 12 calls on it and 40 calls on/);
  assert.doesNotMatch(act.detail, /held up/);
  const told = mail.slice(before).join('\n');
  assert.match(told, /it was not compared with gpt-5\.4 \(yours\)/);
  assert.doesNotMatch(told, /held up/);
  assert.equal((await load(w.id)).rollout_share, null, 'it still takes over: a quiet workload is not held at a share for ever');
  assert.ok(s);
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
  assert.equal(st.defaultOptimizeMode, 'auto', 'a new workspace switches by itself, watched every day');
  assert.equal(st.shareStats, false);
  assert.equal(st.cacheHints, true);
  assert.equal(st.limits.dailyUsd, null);
  assert.equal((await call('/settings/default-mode', { mode: 'ask' })).status, 200);
  assert.equal((await call('/settings/default-mode', { mode: 'sometimes' })).status, 400);
  assert.equal((await call('/settings/share-stats', { enabled: true })).status, 200);
  assert.equal((await call('/settings/optimize-budget', { amountUsd: 12.5 })).status, 200);
  assert.equal((await call('/settings/optimize-budget', { amountUsd: -1 })).status, 400);
  assert.equal((await call('/settings/cache-hints', { enabled: false })).status, 200);
  assert.equal((await call('/settings/limits', { dailyUsd: 5, monthlyUsd: 50 })).status, 200);
  assert.equal((await call('/settings/limits', { dailyUsd: 60, monthlyUsd: 50 })).status, 400, 'a day cannot allow more than a month');
  assert.equal((await call('/settings/notify', { kinds: { money: false } })).status, 200);
  st = (await call('/settings')).json;
  assert.equal(st.defaultOptimizeMode, 'ask');
  assert.equal(st.shareStats, true);
  assert.equal(st.optimizeBudget, 12.5);
  assert.equal(st.cacheHints, false);
  assert.equal(st.limits.dailyUsd, 5);
  assert.equal(st.limits.monthlyUsd, 50);
  assert.equal(st.notify.money, false);
  assert.equal(st.notify.switched, true);
  // new workloads follow the default
  const w = await workloadFor(s.workspace.id, request(1, { system: 'A brand new job.' }));
  assert.equal(w.optimize_mode, 'ask');
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

test('a long instruction is marked only for the model that answers the workload often enough, never for a busy workload\'s every call', async () => {
  const { cacheHintFor, forgetHints } = await import('../src/workspace.js');
  const long = `You are the underwriting assistant. ${'Read the schedule, then the exclusions, then decide. '.repeat(100)}`;
  const s = await shop();
  const body = (i) => ({ model: CLAUDE, messages: [{ role: 'system', content: long }, { role: 'user', content: `policy #${i}` }] });
  const w0 = await workloadFor(s.workspace.id, body(1));
  // switched to a cheaper model, which now answers every call
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const w = await load(w0.id);
  for (let i = 0; i < 5; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: CLAUDE, servedModel: CHEAP,
      statusCode: 200, promptTokens: 1200, completionTokens: 40, costUsd: 0.0004, request: body(70000 + i),
      response: { choices: [{ message: { content: 'ok' } }] }, armId: w.routed_arm_id, propensity: 1, explored: 0 });
  }
  forgetHints();
  assert.equal(await cacheHintFor(s.workspace.id, w, CHEAP), true, 'the model that answers every call is busy enough');
  assert.equal(await cacheHintFor(s.workspace.id, w, CLAUDE), false, 'the customer\'s own model answers none of them now');
  // a call the switch fails is answered by the customer's own model, unmarked: it would write a cache nobody reads back
  failing.add(CHEAP);
  try {
    const r = await send(s.secret, body(70100));
    assert.equal(r.status, 200);
    assert.equal(r.served, CLAUDE);
  } finally {
    failing.delete(CHEAP);
  }
  const toClaude = sent.filter((p) => p.model === CLAUDE).pop();
  assert.equal(typeof toClaude.messages[0].content, 'string', 'sent as it came, with no mark');
  const row = await db.prepare(`SELECT hinted FROM calls WHERE workload_id = ? AND served_model = ? AND status_code = 200`).get(w.id, CLAUDE);
  assert.equal(row.hinted, null, 'and not counted as a marked call');
});

test('a workspace that allows retention only takes our own requirement away, never the customer\'s', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const asked = { messages, provider: { zdr: true, order: ['somebody'] } };
  const off = buildUpstream(asked, REF, null, { zdr: false });
  assert.equal(off.provider.zdr, true, 'the customer\'s own code asked for zero retention, and keeps it');
  assert.deepEqual(off.provider.order, ['somebody'], 'and everything else it asked of the provider');
  assert.equal(off.provider.data_collection, 'deny', 'nobody\'s calls ever go to a provider that trains on them');
  assert.equal(asked.provider.zdr, true, 'the request the customer sent is never changed in place');
  const plain = buildUpstream({ messages }, REF, null, { zdr: false });
  assert.equal(plain.provider.zdr, undefined, 'with retention allowed, nothing of ours asks for it');
  const required = buildUpstream({ messages, provider: { zdr: false } }, REF, null, { zdr: true });
  assert.equal(required.provider.zdr, true, 'a workspace that requires it is never loosened by a call');
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

/* Many calls at once, written as recordCall writes them, for what needs thousands of them. */
let bulkSeq = 0;
async function bulkCalls({ workspaceId, workloadId, armId, model, n, propensity, explored = 0, at = now() - 3600000, cost = 0.0004,
  status = 200, reward = null }) {
  bulkSeq += 1;
  const tag = `bulk${bulkSeq}_${process.pid}_`;
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model, status_code, prompt_tokens,
        completion_tokens, cost_usd, charged_usd, created_at, request_json, response_json, request_hash, task_id, step, arm_id, propensity,
        explored, reward)
      SELECT ? || g, ?, ?, 'routed', ?, ?, ?, 100, 10, ?, 0, ?::bigint - g, ?, ?, md5(? || g), ? || g, 1, ?, ?, ?, ?
        FROM generate_series(1, ?) g`)
    .run(tag, workspaceId, workloadId, REF, model, status, cost, at, JSON.stringify(request(1, { system: 'Bulk.' })),
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'an answer' } }] }), tag, tag, armId, propensity, explored, reward, n);
  return tag;
}

test('a cascade is never graded by the check that chose its answers: the model grader reads them, and every other strategy of the workload', async () => {
  const { jevCheck } = await import('../src/learn/check.js');
  const { stateOf } = await import('../src/learn/explore.js');
  const s = await shop();
  const system = 'Triage the claim.';
  const w0 = await workloadFor(s.workspace.id, request(1, { system }));
  const cascade = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };
  await promote(w0, `cascade:${CHEAP}`, { spec: cascade, rollout: false });
  const w = await load(w0.id);
  const baseline = await upsertArm(w, referenceSpec(w), { status: 'baseline', offline: { ratio: 1 } });
  // cheap answers the cascade served, each passed by its live check, whose verdict is kept under the request and the answer
  for (let i = 0; i < 12; i += 1) {
    const req = request(80000 + i, { system });
    const res = { choices: [{ finish_reason: 'stop', message: { content: `the cheap answer to claim ${i}` } }] };
    const c = await jevCheck(req, res, w.shape_kind, { scope: s.workspace.id, live: true });
    assert.ok(c.p >= cascade.threshold, 'the check passed it, which is why the customer got it');
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP,
      statusCode: 200, promptTokens: 100, completionTokens: 10, costUsd: 0.0004, request: req, response: res,
      armId: w.routed_arm_id, propensity: 0.98, explored: 0, escalated: false });
  }
  // and the customer's own model answering beside it, as the yardstick
  for (let i = 0; i < 6; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: REF,
      statusCode: 200, promptTokens: 100, completionTokens: 10, costUsd: 0.004, request: request(81000 + i, { system }),
      response: { choices: [{ finish_reason: 'stop', message: { content: `your model on claim ${i}` } }] },
      armId: baseline.id, propensity: 0.01, explored: 1 });
  }
  // a grader that is not the cascade's check finds a third of the cheap answers wrong
  let asked = 0;
  const askModel = async () => {
    asked += 1;
    return { json: { choices: [{ message: { content: asked % 3 === 0 ? 'WRONG' : 'RIGHT' } }], usage: { cost: 0.0001 } } };
  };
  const r = await gradeWorkload(w, { perArm: 20, budgetUsd: 1, askModel });
  assert.equal(r.graded, 18);
  const rows = await db.prepare('SELECT arm_id, judged_by, bad FROM graded_calls WHERE workload_id = ?').all(w.id);
  assert.ok(rows.every((x) => x.judged_by === 'llm'), 'read by the model grader, never from the check that passed them');
  assert.ok(rows.some((x) => x.arm_id === w.routed_arm_id && Number(x.bad) === 1), 'so a wrong cheap answer can show as wrong');
  assert.equal(rows.filter((x) => x.arm_id === baseline.id).length, 6, 'and the yardstick is read by the same grader, like with like');
  // readings an older grader made from the kept verdicts are left out of what the review compares
  const old = await bulkCalls({ workspaceId: s.workspace.id, workloadId: w.id, armId: w.routed_arm_id, model: CHEAP, n: 40, propensity: 0.98 });
  await db.prepare(`INSERT INTO graded_calls (call_id, workspace_id, workload_id, arm_id, bad, p, judged_by, cost_usd, created_at)
      SELECT id, workspace_id, workload_id, arm_id, 0, 0.9, 'jev', 0, ? FROM calls WHERE id LIKE ?`).run(now(), `${old}%`);
  // an hour on, so every call has had time for its outcome to arrive
  await db.prepare('UPDATE calls SET created_at = created_at - 3600000 WHERE workload_id = ? AND created_at > ?').run(w.id, now() - 600000);
  const st = await stateOf(w, { fresh: true });
  assert.equal(st.byId.get(w.routed_arm_id).graded.n, 12, 'only the model grader\'s twelve readings count');
});

test('a workload with no cascade is graded as it always was, by Jev, and every strategy gets its share of readings', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Sort the post.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const w = await load(w0.id);
  const baseline = await upsertArm(w, referenceSpec(w), { status: 'baseline', offline: { ratio: 1 } });
  // a busy day: three thousand calls on what serves, twenty on the yardstick
  await bulkCalls({ workspaceId: s.workspace.id, workloadId: w.id, armId: w.routed_arm_id, model: CHEAP, n: 3000, propensity: 0.98 });
  await bulkCalls({ workspaceId: s.workspace.id, workloadId: w.id, armId: baseline.id, model: REF, n: 20, propensity: 0.01, explored: 1, cost: 0.004 });
  const r = await gradeWorkload(w, { perArm: 12, budgetUsd: 10, askModel: async () => { throw new Error('not asked while Jev answers'); } });
  assert.equal(r.graded, 24, 'twelve of each');
  const per = await db.prepare('SELECT arm_id, COUNT(*) AS n, MIN(judged_by) AS by FROM graded_calls WHERE workload_id = ? GROUP BY arm_id').all(w.id);
  assert.equal(Number(per.find((x) => x.arm_id === baseline.id)?.n), 12, 'the yardstick gets its share however busy what serves is');
  assert.equal(Number(per.find((x) => x.arm_id === w.routed_arm_id)?.n), 12);
  assert.ok(per.every((x) => x.by === 'jev'), 'read by Jev, as before');
});

test('the net saving of a switch counts what reading its answers in the background cost', async () => {
  const { switchStory } = await import('../src/eval/switch-story.js');
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Tidy the address.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const w = await load(w0.id);
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    ids.push(await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP,
      statusCode: 200, promptTokens: 1200, completionTokens: 40, costUsd: 0.0004, chargedUsd: 0.000404, request: request(90000 + i),
      response: { choices: [{ message: { content: 'ok' } }] }, armId: w.routed_arm_id, propensity: 0.98, explored: 0 }));
  }
  const before = await switchStory(w);
  assert.ok(before.soFar.net !== null, 'priced');
  assert.equal(before.measuring.graded, 0);
  await db.prepare(`INSERT INTO graded_calls (call_id, workspace_id, workload_id, arm_id, bad, p, judged_by, cost_usd, created_at)
      VALUES (?, ?, ?, ?, 0, 1, 'llm', 0.05, ?)`).run(ids[0], s.workspace.id, w.id, w.routed_arm_id, now());
  const after = await switchStory(w);
  const withFee = 0.05 * (1 + config.ROUTING_FEE_PCT / 100);
  assert.ok(Math.abs(after.measuring.graded - withFee) < 1e-9, `${after.measuring.graded}`);
  assert.ok(Math.abs((before.soFar.net - after.soFar.net) - withFee) < 1e-9, 'the net saving is what is left after reading answers too');
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

test('advice never takes the workload page down: a request Postgres cannot read as JSON is only text to it', async () => {
  const s = await shop();
  const system = 'Answer the letter.';
  const w = await workloadFor(s.workspace.id, request(1, { system }));
  // JSON.stringify writes both of these as escapes that Postgres refuses to read as jsonb
  const nul = String.fromCodePoint(0);
  const lone = String.fromCharCode(0xd800);
  for (let i = 0; i < 100; i += 1) {
    const body = { ...request(60000 + i, { system }), ...(i % 3 === 0 ? { max_tokens: 5000 } : {}) };
    if (i === 7) body.messages[1].content = `a stray ${nul} byte`;
    if (i === 8) body.messages[1].content = `half a pair ${lone}`;
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 300, completionTokens: i % 50 === 1 ? 6000 : 150, costUsd: 0.002, request: body,
      response: { choices: [{ message: { content: 'x' } }] } });
  }
  const advice = await adviceFor(await load(w.id));
  const cap = advice.find((a) => a.kind === 'answer_cap');
  assert.ok(cap, `a third of the calls set a cap, so the advice still stands: ${JSON.stringify(advice)}`);
  // and a workload where most calls already set one is told nothing, read from the same text
  const w2 = await workloadFor(s.workspace.id, request(1, { system: 'Write the whole report.' }));
  for (let i = 0; i < 60; i += 1) {
    const body = { ...request(61000 + i, { system: 'Write the whole report.' }), ...(i % 5 ? { max_completion_tokens: 9000 } : {}) };
    await recordCall({ workspaceId: s.workspace.id, workloadId: w2.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 300, completionTokens: i % 30 === 1 ? 6000 : 150, costUsd: 0.002, request: body,
      response: { choices: [{ message: { content: 'x' } }] } });
  }
  assert.equal((await adviceFor(await load(w2.id))).find((a) => a.kind === 'answer_cap'), undefined, 'four in five set a cap already');
  // anything else going wrong leaves the page without advice, never without a page
  const broken = { ...(await load(w.id)), get routed_model() { throw new Error('a fault while reading the workload'); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await adviceFor(broken), []);
  } finally {
    console.error = quiet;
  }
});

test('advice to mark an instruction for caching is only given where the instruction is long enough to be cached', async () => {
  const s = await shop();
  await db.prepare('UPDATE workspaces SET cache_hints = 0 WHERE id = ?').run(s.workspace.id);
  const long = `You are the claims assistant. ${'Quote the clause, then the amount, then the decision. '.repeat(110)}`;
  const bodies = { short: 'Reply in one line.', long };
  const seen = {};
  for (const [tag, system] of Object.entries(bodies)) {
    const first = { model: CLAUDE, messages: [{ role: 'system', content: system }, { role: 'user', content: 'claim #1' }] };
    const w = await workloadFor(s.workspace.id, first);
    for (let i = 0; i < 60; i += 1) {
      const body = { model: CLAUDE, messages: [{ role: 'system', content: system }, { role: 'user', content: `claim #${62000 + i}` }] };
      await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: CLAUDE, servedModel: CLAUDE,
        statusCode: 200, promptTokens: 1200, completionTokens: 150, costUsd: 0.004, request: body,
        response: { choices: [{ message: { content: 'x' } }] } });
    }
    seen[tag] = (await adviceFor(await load(w.id))).find((a) => a.kind === 'cache_hints');
  }
  assert.equal(seen.short, undefined, 'a short instruction is never cached, so switching marking on would change nothing');
  assert.ok(seen.long, 'a long one would be, so it is worth saying');
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

test('a conversation begun on the strategy a switch is replacing stays there while the switch takes over, and only then', async () => {
  const s = await shop();
  const system = 'Answer the tenant.';
  const w0 = await workloadFor(s.workspace.id, request(1, { system }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const first = await load(w0.id);
  const before = first.routed_arm_id;
  // a second switch takes over a share at a time from the first, which is set aside while it does
  await promote(first, 'judge/small', { spec: { kind: 'model', model: 'judge/small', recipe: null } });
  const w = await load(w0.id);
  assert.equal(w.rollout_from_arm_id, before);
  assert.equal((await db.prepare('SELECT status FROM arms WHERE id = ?').get(before)).status, 'resting');
  const turn1 = { model: REF, messages: [{ role: 'system', content: system }, { role: 'user', content: 'the boiler #1' }] };
  await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP, statusCode: 200,
    promptTokens: 10, completionTokens: 5, costUsd: 0.0004, request: turn1,
    response: { choices: [{ message: { role: 'assistant', content: 'A plumber comes on Monday.' } }] }, armId: before, propensity: 0.95, explored: 0 });
  await learningSettled();
  const turn2 = { ...turn1, messages: [...turn1.messages, { role: 'assistant', content: 'A plumber comes on Monday.' }, { role: 'user', content: 'what time?' }] };
  const pick = await chooseStrategy(w, { rng: () => 0.001, body: turn2 });
  assert.equal(pick.armId, before, 'the draw says the new side, but the conversation began on the one it replaces');
  assert.equal(pick.task, true);
  assert.equal(pick.propensity, 0.95);
  assert.equal(pick.fallback?.spec?.model, REF, 'if it fails, the customer\'s own model answers, as for any call on that side, never the new one');
  // once the switch has taken over, a conversation from before it is served the way any call is
  await db.prepare(`UPDATE workloads SET rollout_share = NULL, rollout_stage = NULL, rollout_started_at = NULL, rollout_from_arm_id = NULL
      WHERE id = ?`).run(w.id);
  const later = await chooseStrategy(await load(w.id), { rng: () => 0.001, body: turn2 });
  assert.equal(later.armId, w.routed_arm_id, 'what serves now');
  assert.notEqual(later.task, true);
});

test('a helpful answer that opens with an apology is not a refusal', () => {
  assert.equal(refused("I'm sorry to hear that. Here is how to reset it: open Settings and press Reset."), false);
  assert.equal(refused("I can't wait to help. Here is the plan."), false);
  assert.equal(refused("I'm sorry, but I can't help with that."), true);
  assert.equal(refused('I cannot provide that.'), true);
});

test('a part of a call whose provider states no cost is counted at an estimate, and no invented cost is written into the answer', async () => {
  const { serveWith } = await import('../src/learn/serve.js');
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} is not ${b}`);
  const body = { model: REF, messages: [{ role: 'system', content: 'Classify the parcel.' }, { role: 'user', content: 'parcel #5' }] };
  const cascade = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };
  const pass = async () => ({ pass: true, by: 'jev', p: 0.9, cost: 0.0001, ms: 5 });
  const unsure = async () => ({ pass: false, by: 'jev', p: 0.2, cost: 0.0001, ms: 5 });
  // steady-small's catalogue price for the tokens its answers say they used
  const cheapAt = 1200 * 0.2e-6 + 40 * 0.6e-6;
  try {
    // every part stated: the whole call's cost is written into the answer, as ever
    const stated = await serveWith(cascade, body, { shape: 'free_text', check: pass });
    near(stated.cost, 0.0004 + 0.0001, 'stated');
    assert.equal(stated.costEstimated, false);
    near(stated.json.usage.cost, 0.0005, 'written into the answer');
    // every model stated its cost, but the check's own was worked out from what it read: the total is not stated either
    const guessedCheck = async () => ({ pass: true, by: 'jev', p: 0.9, cost: 0.0001, ms: 5, costEstimated: true });
    const guessed = await serveWith(cascade, body, { shape: 'free_text', check: guessedCheck });
    near(guessed.cost, 0.0005, 'the same total');
    assert.equal(guessed.costEstimated, true);
    assert.equal('cost' in guessed.json.usage, false);
    // the cheap answer states no cost: estimated from its tokens at the catalogue price, never nothing
    noCost.add(CHEAP);
    const quiet = await serveWith(cascade, body, { shape: 'free_text', check: pass });
    near(quiet.cost, cheapAt + 0.0001, 'estimated');
    assert.equal(quiet.costEstimated, true);
    assert.equal('cost' in quiet.json.usage, false, 'no cost is written into an answer whose provider never stated one');
    assert.equal(quiet.json.usage.prompt_tokens, 1200, 'and everything it did say is kept');
    // sent on: the answer the customer got stated its cost, the cheap one before it did not
    const sentOn = await serveWith(cascade, body, { shape: 'free_text', check: unsure });
    near(sentOn.cost, cheapAt + 0.0001 + 0.004, 'all three parts');
    assert.equal(sentOn.costEstimated, true);
    assert.equal('cost' in sentOn.json.usage, false, 'a total with a guess in it is not written in as the provider\'s');
    // a router's pick, stating no cost
    const zeros = [0, 0, 0, 0, 0, 0];
    const router = { kind: 'router', cheap: { model: CHEAP, recipe: null }, strong: { model: REF, recipe: null }, threshold: 0.5,
      weights: zeros, bias: 5, means: zeros, sds: zeros.map(() => 1) };
    const picked = await serveWith(router, body, { shape: 'free_text' });
    near(picked.cost, cheapAt, 'the router\'s pick');
    assert.equal(picked.costEstimated, true);
    // an answer that says nothing about its usage: counted from what was sent and what came back, three characters a token
    noUsage.add(CHEAP);
    const bare = await serveWith(router, body, { shape: 'free_text' });
    const tokensSent = Math.ceil('Classify the parcel.\nparcel #5'.length / 3);
    const tokensBack = Math.ceil(`answer from ${CHEAP}`.length / 3);
    near(bare.cost, tokensSent * 0.2e-6 + tokensBack * 0.6e-6, 'from the text');
    assert.equal(bare.costEstimated, true);
  } finally {
    noCost.clear();
    noUsage.clear();
  }
});

test('reading an answer in the background, where the grader states no cost, is charged at an estimate', async () => {
  const s = await shop();
  const w0 = await workloadFor(s.workspace.id, request(1, { system: 'Weigh the parcel.' }));
  await promote(w0, CHEAP, { spec: { kind: 'model', model: CHEAP, recipe: null }, rollout: false });
  const w = await load(w0.id);
  for (let i = 0; i < 3; i += 1) {
    await recordCall({ workspaceId: s.workspace.id, workloadId: w.id, source: 'routed', requestedModel: REF, servedModel: CHEAP,
      statusCode: 200, promptTokens: 100, completionTokens: 10, costUsd: 0.0004, request: request(95000 + i, { system: 'Weigh the parcel.' }),
      response: { choices: [{ finish_reason: 'stop', message: { content: 'two kilos' } }] }, armId: w.routed_arm_id, propensity: 0.98, explored: 0 });
  }
  const askModel = async () => ({ json: { choices: [{ message: { content: 'RIGHT' } }], usage: { prompt_tokens: 300, completion_tokens: 2 } } });
  const r = await gradeWorkload(w, { perArm: 3, budgetUsd: 1, askJev: async () => { throw new Error('no jev here'); }, askModel });
  assert.equal(r.graded, 3);
  const rows = await db.prepare('SELECT cost_usd FROM graded_calls WHERE workload_id = ?').all(w.id);
  // judge/small's catalogue price for the tokens the grader says it used
  assert.ok(rows.every((x) => Math.abs(Number(x.cost_usd) - (300 * 0.05e-6 + 2 * 0.1e-6)) < 1e-15), JSON.stringify(rows));
});

test('a call a cascade answered whose provider stated no cost is charged for it, and the balance moves', async () => {
  const s = await shop();
  const system = 'Classify the parcel.';
  const w0 = await workloadFor(s.workspace.id, request(1, { system }));
  const cascade = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };
  await promote(w0, `cascade:${CHEAP}`, { spec: cascade, rollout: false });
  const balance = async () => Number((await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?').get(s.workspace.id)).balance_usd);
  const before = await balance();
  noCost.add(CHEAP);
  try {
    const r = await send(s.secret, request(2, { system }));
    assert.equal(r.status, 200);
    assert.equal(r.served, CHEAP, 'the cheap answer passed its check');
    assert.equal(r.json.usage.cost, undefined, 'the answer claims no cost its provider never stated');
    const row = await db.prepare('SELECT cost_usd, charged_usd FROM calls WHERE id = ?').get(r.callId);
    const cheapAt = 1200 * 0.2e-6 + 40 * 0.6e-6;
    assert.ok(Number(row.cost_usd) >= cheapAt, `what the cheap answer cost, estimated, and the check: ${row.cost_usd}`);
    assert.ok(Number(row.charged_usd) > Number(row.cost_usd), 'charged, with our fee');
    assert.ok(before - await balance() >= Number(row.charged_usd) - 1e-9, 'and the balance moved by it');
  } finally {
    noCost.clear();
  }
});

test('a strategy served only by the providers it was measured on is switched back or set aside when none of them serves it any more', async () => {
  const { watchPins } = await import('../src/learn/pins.js');
  const { saveZdrEndpoints } = await import('../src/openrouter.js');
  const endpoint = (model, tag) => ({ model_id: model, tag, provider: tag, price_in: 0.2e-6, price_out: 0.6e-6, overrides_json: null,
    context_len: 128000, max_output: null, max_prompt: null, params_json: null, status: 0, uptime_5m: 100, uptime_30m: 100, uptime_1d: 100,
    ttft_p50: null, ttft_p90: null, tps_p50: null, tps_p90: null });
  const pinnedTo = (tags) => ({ kind: 'model', model: CHEAP, recipe: { providers: tags } });
  const switched = async (system, tags, { zdr = 1 } = {}) => {
    const s = await shop();
    await db.prepare('UPDATE workspaces SET zdr_required = ? WHERE id = ?').run(zdr, s.workspace.id);
    const w0 = await workloadFor(s.workspace.id, request(1, { system }));
    await promote(w0, CHEAP, { spec: pinnedTo(tags), rollout: false });
    return load(w0.id);
  };
  try {
    // a list never read says nothing about any provider
    await db.prepare('DELETE FROM model_endpoints').run();
    const early = await switched('Match the invoice to the order.', ['alpha-host']);
    assert.deepEqual(await watchPins(), { reverted: 0, rested: 0 });
    // the list now names the model on another provider only
    await saveZdrEndpoints([endpoint(CHEAP, 'beta-host'), endpoint(REF, 'openai'), endpoint('judge/small', 'beta-host')]);
    const kept = await switched('Match the delivery to the order.', ['beta-host', 'gamma-host']);
    const loose = await switched('Match the refund to the order.', ['alpha-host'], { zdr: 0 });
    // and a runner-up pinned to providers that went, on a workload whose serving strategy is fine
    const trying = await upsertArm(kept, { kind: 'model', model: 'judge/small', recipe: { providers: ['alpha-host', 'delta-host'] } },
      { status: 'trying' });
    // a strategy pinned to a provider that is gone is still pinned, and every call it is given fails
    assert.equal(buildUpstream({ messages: [{ role: 'user', content: 'x' }] }, CHEAP, { providers: ['alpha-host'] }).provider.only[0], 'alpha-host');
    // the hourly review looks before it reads anything else
    const r = await reviewAll();
    assert.deepEqual(r.pins, { reverted: 1, rested: 1 });
    assert.equal((await load(early.id)).routed_model, null, 'switched back to the customer\'s own model');
    const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? AND kind = 'revert' ORDER BY created_at DESC LIMIT 1`).get(early.id);
    assert.match(act.detail, /the providers steady-small was measured on \(alpha-host\), and none of them serves it/);
    assert.match(act.detail, /Another provider does, but it was never measured there/);
    assert.equal((await load(kept.id)).routed_model, CHEAP, 'one of its providers still serves it: left alone');
    assert.equal((await load(loose.id)).routed_model, CHEAP, 'a workspace that allows retention is not judged by the list of those that keep nothing');
    assert.equal((await db.prepare('SELECT status FROM arms WHERE id = ?').get(trying.id)).status, 'resting', 'the runner-up is set aside');
  } finally {
    await db.prepare('DELETE FROM model_endpoints').run();
    await db.prepare('UPDATE models_catalog SET zdr = 1').run();
  }
});
