/* Learning from live calls, end to end: the real proxy, a provider we control, a real database.

   A switched workload tries a small share of its calls elsewhere (the customer's own model as the
   yardstick, and a cheaper runner-up), every call records the chance it had, the day's budget
   stops the experiments, and the hourly review acts on what the records show: on to a runner-up
   that works as often, back to the customer's own model when what serves works less often, and a
   runner-up that works less often is set aside. A workload that waits for approval never has an
   answer changed: its runner-up answers copies in the background, and a good match is put in
   front of whoever approves. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';

const PORT = 4798;
const PROXY_PORT = 4799;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_learn_${process.pid}`;
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
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
// these tests are about what a switch does once it serves every call; the staged rollout has tests of its own
process.env.ROLLOUT_ENABLED = 'false';
process.env.DEFAULT_OPTIMIZE_MODE = process.env.DEFAULT_OPTIMIZE_MODE || 'auto';
// big shares, so a handful of calls shows every path; the arithmetic is the same at 2%
process.env.EXPLORE_SHARE_NORMAL = '0.5';
process.env.SHADOW_SHARE = '1';
process.env.LEARN_SETTLE_MIN = '0';

const { db, now } = await import('../src/db/index.js');
const { default: config } = await import('../src/config.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { move } = await import('../src/billing.js');
const { promote } = await import('../src/eval/promote.js');
const { onChoose, onServed, chooseStrategy } = await import('../src/learn/choose.js');
const {
  chooseExplore, afterServed, reviewWorkload, markTrying, learningView, forgetState, exploreOf, stateOf,
} = await import('../src/learn/explore.js');
const { rngFrom } = await import('../src/learn/bandit.js');
const { upsertArm, referenceSpec } = await import('../src/learn/arms.js');
const { saveDef } = await import('../src/learn/outcomes.js');
const { outcomeSummary } = await import('../src/learn/views.js');
const { default: v1 } = await import('../src/proxy.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const STEADY = 'vendor/steady';
const CHEAPER = 'vendor/cheaper';
const COST = { [REF]: 0.002, [STEADY]: 0.0004, [CHEAPER]: 0.0001 };
const right = (i) => ({ total: 100 + i, currency: 'USD' });
// the cheaper runner-up gets one call in four wrong, which a background answer shows
const answerOf = (model, i) => (model === CHEAPER && i % 4 === 1 ? { total: 0, currency: 'EUR' } : right(i));

// models the provider refuses, to see what an experiment that fails does
const failing = new Set();
/* Models the provider says are busy: every time (alwaysBusy), or the first time each request reaches
   them and not when it is sent again (busyOnce), with how many requests each model was sent. */
const busyOnce = new Set();
const alwaysBusy = new Set();
const triedOnce = new Set();
const hits = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    hits.set(payload.model, (hits.get(payload.model) || 0) + 1);
    if (failing.has(payload.model)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Provider is overloaded' } }));
      return;
    }
    const text = payload.messages.find((m) => m.role === 'user')?.content || '';
    const once = `${payload.model}|${text}`;
    if (alwaysBusy.has(payload.model) || (busyOnce.has(payload.model) && !triedOnce.has(once))) {
      triedOnce.add(once);
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0.01' });
      res.end(JSON.stringify({ error: { message: 'Rate limited, try again shortly' } }));
      return;
    }
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `gen-${i}`, model: payload.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answerOf(payload.model, i)) } }],
      usage: { prompt_tokens: 500, completion_tokens: 40, cost: COST[payload.model] ?? 0.001 } }));
  });
});

const app = express();
app.use('/v1', v1);
let proxy = null;
// every draw replayable: the experiment choice and the background choice each have their own source
const choiceRng = rngFrom(2024);
const shadowRng = rngFrom(99);
onChoose((w, serving) => chooseExplore(w, serving, { rng: choiceRng }));
onServed((info) => afterServed(info, { rng: shadowRng }));

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { proxy = app.listen(PROXY_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: STEADY, name: 'steady', context_len: 128000, price_in: 0.4e-6, price_out: 1e-6, open_weights: 1, zdr: 1 },
    { model_id: CHEAPER, name: 'cheaper', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
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

const request = (i) => ({
  model: REF,
  messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}.` }, { role: 'user', content: `document #${i}` }],
  response_format: { type: 'json_object' },
});

/* A workspace with one workload that has been measured: steady cleared and serves it, cheaper came
   close and is a runner-up. What a measurement would leave behind, written directly, so each test
   starts from exactly the state it is about. */
async function shop(tag, { optimize = 'auto', explore = 'normal', switched = true } = {}) {
  const { workspace } = await createAccount({ email: `learn-${tag}-${process.pid}@understudy.dev`, password: 'correct-horse', name: tag });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  let workload = null;
  for (let i = 0; i < 3; i += 1) {
    workload = await workloadFor(workspace.id, request(i));
    await recordCall({ workspaceId: workspace.id, workloadId: workload.id, source: 'routed', requestedModel: REF, servedModel: REF,
      statusCode: 200, promptTokens: 500, completionTokens: 40, costUsd: 0.002, request: request(i),
      response: { choices: [{ message: { content: JSON.stringify(right(i)) } }] } });
  }
  await db.prepare(`UPDATE workloads SET optimize_mode = ?, explore_mode = ?, explore_budget_usd = 100, reference_model = ?,
      floor_pct = 4 WHERE id = ?`).run(optimize, explore, REF, workload.id);
  workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  if (switched) {
    await promote(workload, STEADY, { spec: { kind: 'model', model: STEADY, recipe: null }, auto: true });
    // switched two days ago, so the calls written below, an hour old, came after it as they would
    await db.prepare('UPDATE workloads SET promoted_at = ? WHERE id = ?').run(now() - 2 * 86400000, workload.id);
    // and the record of the switch with it: learning counts calls from the first switch on
    await db.prepare("UPDATE promotions SET created_at = ? WHERE workload_id = ? AND action = 'promote'").run(now() - 2 * 86400000, workload.id);
    workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  }
  const results = [
    { model_id: STEADY, verdict: 'cleared', stopped: null, cost_month_usd: 20, cost_ratio: 0.2, gap_pct: 1.5, runs: 80, arm_json: null, recipe_json: null },
    { model_id: CHEAPER, verdict: 'cleared', stopped: null, cost_month_usd: 5, cost_ratio: 0.05, gap_pct: 2.6, runs: 80, arm_json: null, recipe_json: null },
    { model_id: 'vendor/close', verdict: 'review', stopped: null, cost_month_usd: 4, cost_ratio: 0.04, gap_pct: 4.6, runs: 80, arm_json: null, recipe_json: null },
    { model_id: 'vendor/wrong', verdict: 'missed', stopped: 'bar', cost_month_usd: 2, cost_ratio: 0.02, gap_pct: 40, runs: 9, arm_json: null, recipe_json: null },
  ];
  await markTrying(workload, { runId: null, results, refMonthly: 100, floor: 4 });
  const key = await issueKey(workspace.id, 'learning');
  return { workspace, workload: await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id), secret: key.secret };
}

const send = async (secret, body) => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  await res.json();
  await learningSettled();
  return res.headers.get('x-understudy-call-id');
};

const close = (x, y, eps, what) => assert.ok(Math.abs(x - y) <= eps, `${what}: ${x} is not within ${eps} of ${y}`);

const armOf = async (workloadId, model) => db.prepare(
  `SELECT * FROM arms WHERE workload_id = ? AND spec_json LIKE ?`).get(workloadId, `%"model":"${model}"%`);

/* Calls a strategy served, written directly and dated an hour ago, with how each turned out.
   `yardstick` writes them as the customer's own model answering beside the switch, chosen by chance;
   `unread` as calls from before outcomes were kept, which could carry no signal at all. */
let seq = 1000;
async function history(s, model, { n, failed = 0, armId = undefined, yardstick = false, unread = false }) {
  let arm = armId === undefined ? await armOf(s.workload.id, model) : { id: armId };
  if (yardstick) arm = await upsertArm(s.workload, referenceSpec(s.workload), { status: 'baseline', offline: { ratio: 1 } });
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const callId = await recordCall({
      workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF, servedModel: model,
      statusCode: 200, promptTokens: 500, completionTokens: 40, costUsd: COST[model], request: request(seq),
      response: { choices: [{ message: { content: JSON.stringify(right(seq)) } }] },
      // an experiment was possible on every one of these calls (the serving strategy keeps 98 in 100)
      armId: arm?.id ?? null, propensity: yardstick ? 0.01 : 0.98, explored: yardstick ? 1 : 0,
    });
    ids.push(callId);
    // a failure the traffic showed: say the answer was not what the request asked for
    if (i < failed) await db.prepare('UPDATE calls SET reward = 0 WHERE id = ?').run(callId);
  }
  await learningSettled();
  if (unread) await db.prepare('UPDATE calls SET request_hash = NULL WHERE id = ANY(?::text[])').run(ids);
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ? AND created_at > ?')
    .run(now() - 3600000, s.workload.id, now() - 3600000);
  forgetState(s.workload.id);
}

/* Thousands of calls at once, spread evenly from `from` to `to`, written as recordCall writes them, of
   which `failPer100` in every hundred were seen to fail; each a task of its own, or all steps of `task`. */
let bulkSeq = 0;
async function bulk(s, { armId, model, n, propensity, explored = 0, from, to, failPer100 = 0, cost = COST[model], task = null }) {
  bulkSeq += 1;
  const tag = `call_bulk${bulkSeq}_${process.pid}_`;
  const step = Math.max(1, Math.floor((to - from) / n));
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model, status_code, prompt_tokens,
        completion_tokens, cost_usd, charged_usd, created_at, request_hash, task_id, step, arm_id, propensity, explored, reward)
      SELECT ? || g, ?, ?, 'routed', ?, ?, 200, 500, 40, ?, 0, ?::bigint - (g - 1)::bigint * ?::bigint, md5(? || g),
             COALESCE(?::text, ? || g), 1, ?, ?, ?, CASE WHEN g % 100 < ? THEN 0 ELSE NULL END
        FROM generate_series(1, ?) g`)
    .run(tag, s.workspace.id, s.workload.id, REF, model, cost, to, step, tag, task, tag, armId, propensity, explored, failPer100, n);
  forgetState(s.workload.id);
}

test('a measurement leaves its runners-up behind: cleared and cheaper ones are tried, the rest are not', async () => {
  const s = await shop('marks');
  const cheaper = await armOf(s.workload.id, CHEAPER);
  assert.equal(cheaper.status, 'trying', 'cleared and cheaper: worth trying');
  assert.equal(JSON.parse(cheaper.offline_json).ratio, 0.05);
  assert.equal(await armOf(s.workload.id, 'vendor/close'), undefined, 'one that only came close has not earned live calls');
  assert.equal(await armOf(s.workload.id, 'vendor/wrong'), undefined, 'a model that missed is not a runner-up');
  const steady = await armOf(s.workload.id, STEADY);
  assert.equal(steady.status, 'serving', 'what serves stays serving');
  // a later measurement that no longer vouches for it sets it aside
  await markTrying(s.workload, { runId: null, results: [], refMonthly: 100, floor: 4 });
  assert.equal((await armOf(s.workload.id, CHEAPER)).status, 'resting');
});

test('a switched workload tries a small share of its calls elsewhere, and every call says what chance it had', async () => {
  const s = await shop('explore');
  forgetState(s.workload.id);
  // nothing is known yet: the first call is served as usual, and never waits while that is read
  const first = await send(s.secret, request(999));
  const row0 = await db.prepare('SELECT served_model, propensity, explored FROM calls WHERE id = ?').get(first);
  assert.equal(row0.served_model, STEADY);
  assert.equal(Number(row0.propensity), 1);
  assert.equal(Number(row0.explored), 0);
  const ids = [];
  for (let i = 0; i < 40; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT c.*, a.status AS arm_status FROM calls c LEFT JOIN arms a ON a.id = c.arm_id
      WHERE c.id = ANY(?::text[])`).all(ids);
  assert.equal(rows.length, 40);
  const by = (m) => rows.filter((r) => r.served_model === m);
  assert.ok(by(STEADY).length >= 12, `most go to what serves: ${by(STEADY).length}`);
  assert.ok(by(REF).length >= 3, `some go to the yardstick: ${by(REF).length}`);
  assert.ok(by(CHEAPER).length >= 3, `some to the runner-up: ${by(CHEAPER).length}`);
  for (const r of rows) assert.ok(r.arm_id, 'every call names the strategy that answered it');
  // share 0.5: what serves keeps half, the yardstick and the one runner-up a quarter each
  for (const r of by(STEADY)) { assert.equal(Number(r.propensity), 0.5); assert.equal(Number(r.explored), 0); }
  for (const r of by(REF)) { assert.equal(Number(r.propensity), 0.25); assert.equal(Number(r.explored), 1); assert.equal(r.arm_status, 'baseline'); }
  for (const r of by(CHEAPER)) { assert.equal(Number(r.propensity), 0.25); assert.equal(Number(r.explored), 1); }
  // the customer paid for what answered each call, as ever
  const paid = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM calls WHERE id = ANY(?::text[])`).get(ids);
  const due = by(STEADY).length * COST[STEADY] + by(REF).length * COST[REF] + by(CHEAPER).length * COST[CHEAPER];
  assert.ok(Math.abs(Number(paid.c) - due) < 1e-9);
});

test('experiments stop once the day\'s budget is used, and the call is served as usual', async () => {
  const s = await shop('budget');
  // one call on the yardstick adds 0.002 x (1 - 0.2) = $0.0016, more than this whole budget
  await db.prepare('UPDATE workloads SET explore_budget_usd = 0.001 WHERE id = ?').run(s.workload.id);
  forgetState(s.workload.id);
  const ids = [];
  for (let i = 0; i < 30; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT id, served_model, explored, propensity FROM calls WHERE id = ANY(?::text[]) ORDER BY created_at`).all(ids);
  const onRef = rows.filter((r) => r.served_model === REF);
  assert.ok(onRef.length <= 1, `at most the one yardstick call that used the budget: ${onRef.length}`);
  const after = rows.slice(rows.findIndex((r) => r.served_model === REF) + 1);
  assert.ok(after.every((r) => r.served_model !== REF), 'no yardstick call once the budget is gone');
  // once experiments pause, what serves answers with certainty
  assert.ok(rows.slice(-5).every((r) => r.served_model !== REF && (r.served_model === CHEAPER || Number(r.propensity) === 1 || Number(r.propensity) === 0.5)));
  const view = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  if (onRef.length) assert.match(view.explore.reason || '', /budget/, 'the page says why experiments paused');
});

test('the hourly review moves to a cheaper runner-up once its live calls work as often', async () => {
  const s = await shop('promote');
  /* A clean call only says something where a failure would have shown: here the customer reports how
     calls turned out, so a call with nothing reported worked. Without that, clean calls are silence,
     and live results decide nothing (the next tests, and the harness, hold that). */
  await saveDef(s.workload.id, { events: [{ event: 'ticket_reopened', means: 'failed' }] });
  /* Sixty clean calls are not enough: after n calls without a failure, the failure rate can still
     plausibly be about 3/n, 5% at sixty, and the runner-up has to be shown within two points at every
     hourly look, not only at this one. */
  await history(s, STEADY, { n: 300 });
  await history(s, CHEAPER, { n: 60 });
  assert.deepEqual(await reviewWorkload(s.workload), [], 'sixty clean calls: not yet');
  await history(s, CHEAPER, { n: 190 });
  // and never without the customer's own model answering beside it, as the yardstick
  assert.deepEqual(await reviewWorkload(s.workload), [], 'no yardstick calls: not yet');
  await history(s, REF, { n: 200, yardstick: true });
  const decisions = await reviewWorkload(s.workload);
  assert.deepEqual(decisions.map((d) => d.kind), ['promote']);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, CHEAPER, 'switched on to the cheaper runner-up');
  const promo = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.equal(promo.to_model, CHEAPER);
  assert.match(promo.reason, /live results/);
  const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.match(act.detail, /Switched on its own by live results: its calls worked 100\.0% of 250 calls, against 100\.0% of 300 calls on steady and 100\.0% of 200 calls on gpt-5\.4/);
  assert.match(act.detail, /costs 75% less/, 'a quarter of the price: 0.05 against 0.2');
  // the readings are kept on each strategy for the page
  const arm = await armOf(s.workload.id, CHEAPER);
  assert.equal(JSON.parse(arm.stats_json).live.calls, 250);
});

test('what live results do follows how the workload switches: on its own, after approval, or never', async () => {
  const evidence = async (s) => {
    await saveDef(s.workload.id, { events: [{ event: 'ticket_reopened', means: 'failed' }] });
    await history(s, STEADY, { n: 300 });
    await history(s, CHEAPER, { n: 250 });
    await history(s, REF, { n: 200, yardstick: true });
  };
  const told = async (s) => Number((await db.prepare(
    `SELECT COUNT(*) AS n FROM activity WHERE workload_id = ? AND title LIKE '%ready to approve%'`).get(s.workload.id)).n);
  // never switch: a runner-up as good as what serves is neither switched to nor put to anybody
  const never = await shop('never', { optimize: 'off' });
  await evidence(never);
  assert.deepEqual(await reviewWorkload(never.workload), [], 'never switched, never nagged');
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(never.workload.id)).routed_model, STEADY);
  assert.equal(await told(never), 0, 'and nothing in the activity feed');
  // ask first: the same evidence is put in front of whoever approves, once, and nothing is switched
  const asks = await shop('asks', { optimize: 'ask' });
  await evidence(asks);
  assert.deepEqual((await reviewWorkload(asks.workload)).map((d) => d.kind), ['suggest']);
  assert.equal(await told(asks), 1);
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(asks.workload.id)).routed_model, STEADY);
  // and a switch back for safety happens whatever the mode
  const back = await shop('never-back', { optimize: 'off' });
  await history(back, STEADY, { n: 100, failed: 15 });
  await history(back, REF, { n: 60, yardstick: true });
  assert.deepEqual((await reviewWorkload(back.workload)).map((d) => d.kind), ['revert'], 'a workload that never switches is still switched back');
});

test('background answers on a workload that never switches are shown, never put forward', async () => {
  const s = await shop('never-shadow', { optimize: 'off', explore: 'shadow', switched: false });
  const cheaperArm = await armOf(s.workload.id, CHEAPER);
  await db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, agreement, cost_usd, status, created_at)
      SELECT ? || g, ?, ?, ?, 1, 0, 200, ? FROM generate_series(1, 1200) g`)
    .run('shd_never_', s.workspace.id, s.workload.id, cheaperArm.id, now() - 60000);
  forgetState(s.workload.id);
  assert.deepEqual(await reviewWorkload(s.workload), [], 'twelve hundred matching answers, and nothing said');
  const v = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  assert.equal(v.others.find((o) => o.id === cheaperArm.id).shadow.calls, 1200, 'the page still has every one of them');
});

test('clean calls on a workload where nothing is ever seen decide nothing', async () => {
  const s = await shop('silence');
  await history(s, STEADY, { n: 300 });
  await history(s, CHEAPER, { n: 250 });
  await history(s, REF, { n: 200, yardstick: true });
  assert.deepEqual(await reviewWorkload(s.workload), [], 'no failure could have shown, so none showing says nothing');
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(s.workload.id)).routed_model, STEADY);
});

test('the hourly review switches back when what serves works less often than the customer\'s own model', async () => {
  const s = await shop('rollback');
  await history(s, STEADY, { n: 100, failed: 15 });
  // the customer's own model's old calls, from before outcomes were kept: they decide nothing
  await history(s, REF, { n: 300, armId: null, unread: true });
  assert.deepEqual(await reviewWorkload(s.workload), [], 'no switch back on history that could never carry a signal');
  // the yardstick: the customer's own model answering beside the switch, chosen by chance
  await history(s, REF, { n: 60, yardstick: true });
  const decisions = await reviewWorkload(s.workload);
  assert.deepEqual(decisions.map((d) => d.kind), ['revert']);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, null, 'back on the customer\'s own model');
  const r = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.equal(r.action, 'soft_revert', 'for a while, not for good: live results can change');
  assert.match(r.reason, /since the switch, calls on steady worked 85\.0% of 100 calls, against 100\.0% of 60 calls on gpt-5\.4 answering beside it/);
});

test('a runner-up that clearly works less often is set aside', async () => {
  const s = await shop('rest');
  await history(s, STEADY, { n: 120 });
  await history(s, CHEAPER, { n: 40, failed: 14 });
  const decisions = await reviewWorkload(s.workload);
  assert.ok(decisions.some((d) => d.kind === 'rest'), JSON.stringify(decisions));
  assert.equal((await armOf(s.workload.id, CHEAPER)).status, 'resting');
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, STEADY, 'what serves stays');
});

test('too little evidence changes nothing', async () => {
  const s = await shop('patience');
  await history(s, STEADY, { n: 50 });
  await history(s, CHEAPER, { n: 8 });
  assert.deepEqual(await reviewWorkload(s.workload), []);
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(s.workload.id)).routed_model, STEADY);
});

test('a workload that waits for approval never has an answer changed; its runner-up answers in the background', async () => {
  const s = await shop('shadow', { optimize: 'ask', explore: null, switched: false });
  assert.equal(exploreOf(s.workload).mode, 'shadow', 'asking first means background answers by default');
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT served_model, arm_id, explored FROM calls WHERE id = ANY(?::text[])`).all(ids);
  assert.ok(rows.every((r) => r.served_model === REF), 'every answer came from the customer\'s own model');
  const shadows = await db.prepare('SELECT * FROM shadow_runs WHERE workload_id = ? ORDER BY created_at').all(s.workload.id);
  assert.equal(shadows.length, 8, 'each call answered again in the background (the share is 1 here)');
  // nothing is switched yet, so both measured models are runners-up, and each answers some calls
  const cheaperArm = await armOf(s.workload.id, CHEAPER);
  const steadyArm = await armOf(s.workload.id, STEADY);
  assert.equal(steadyArm.status, 'trying');
  assert.ok(shadows.every((x) => [cheaperArm.id, steadyArm.id].includes(x.arm_id)), 'by the runners-up');
  // the cheaper one gets calls 1 and 5 wrong in both fields; the steady one matches every time
  for (const [k, x] of shadows.entries()) {
    const want = x.arm_id === cheaperArm.id && k % 4 === 1 ? 0 : 1;
    assert.equal(Number(x.agreement), want, `call ${k} on ${x.arm_id === cheaperArm.id ? 'cheaper' : 'steady'}`);
  }
  // paid like a measurement, out of the balance, within the budget
  const spent = await db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND kind = 'eval'`).get(s.workspace.id);
  assert.ok(Number(spent.s) < 0, 'background answers are charged like a measurement');

  /* Background answers in bulk with known results, so what the review sees does not depend on how
     the few live ones happened to be shared between the two runners-up. */
  const bulk = async (tag, n, agreement) => {
    await db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, agreement, cost_usd, status, created_at)
        SELECT ? || g, ?, ?, ?, ?, 0, 200, ? FROM generate_series(1, ?) g`)
      .run(`shd_${tag}_`, s.workspace.id, s.workload.id, cheaperArm.id, agreement, now() - 60000, n);
    forgetState(s.workload.id);
  };
  // forty that only half matched: far outside the 4% bar, so nothing is put forward
  await bulk('half', 40, 0.5);
  assert.ok(!(await reviewWorkload(s.workload)).some((d) => d.armId === cheaperArm.id), 'half matching is not put forward');
  // twelve hundred the same: under 4% different in all, inside the bar
  await bulk('same', 1200, 1);
  const later = await reviewWorkload(s.workload);
  assert.ok(later.some((d) => d.kind === 'suggest' && d.armId === cheaperArm.id), JSON.stringify(later));
  const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.match(act.title, /matched your live answers/);
  assert.match(act.detail, /Nothing was changed/);
  assert.deepEqual(await reviewWorkload(s.workload), [], 'said once, not every hour');
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(s.workload.id)).routed_model, null, 'and nothing switched');
});

test('the page gets every strategy with its record, its share of the week, and the experiment setting', async () => {
  const s = await shop('view');
  await history(s, STEADY, { n: 50, failed: 1 });
  await history(s, CHEAPER, { n: 10 });
  const v = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  assert.equal(v.explore.mode, 'normal');
  assert.equal(v.serving.role, 'serving');
  assert.equal(v.serving.live.calls, 50);
  assert.ok(v.serving.live.lo < v.serving.live.mean && v.serving.live.mean < v.serving.live.hi);
  assert.equal(v.serving.week.calls, 50);
  assert.equal(v.baseline.role, 'yardstick');
  assert.equal(v.baseline.ratio, 1);
  const runner = v.others.find((o) => o.spec.model === CHEAPER);
  assert.equal(runner.role, 'runner-up');
  assert.equal(runner.live.calls, 10);
  assert.equal(runner.ratio, 0.05);
});

test('an experiment the provider fails is served the usual way, and the failure is kept against it', async () => {
  const s = await shop('failover');
  failing.add(REF);
  try {
    const ids = [];
    for (let i = 0; i < 30; i += 1) ids.push(await send(s.secret, request(3000 + i)));
    const served = await db.prepare('SELECT served_model, propensity, explored FROM calls WHERE id = ANY(?::text[])').all(ids);
    assert.ok(served.every((r) => r.served_model !== REF), 'no answer came from the model that was failing');
    const failed = await db.prepare(`SELECT * FROM calls WHERE workload_id = ? AND explored = 1 AND status_code = 503`).all(s.workload.id);
    assert.ok(failed.length >= 1, `the failed experiments were kept: ${failed.length}`);
    assert.equal(JSON.parse(failed[0].check_json).by, 'experiment failed');
    // the call that stood in for it is what serves, as usual, and not an experiment
    const stoodIn = served.filter((r) => r.propensity === null);
    assert.equal(stoodIn.length, failed.length, 'one stand-in for each failed experiment');
    assert.ok(stoodIn.every((r) => r.served_model === STEADY && Number(r.explored) === 0));
  } finally {
    failing.delete(REF);
  }
});

test('nothing is tried while what serves has no known cost, and the page says why', async () => {
  const s = await shop('unpriced');
  const steady = await armOf(s.workload.id, STEADY);
  await db.prepare('UPDATE arms SET offline_json = NULL WHERE id = ?').run(steady.id);
  forgetState(s.workload.id);
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push(await send(s.secret, request(4000 + i)));
  const rows = await db.prepare('SELECT served_model, explored FROM calls WHERE id = ANY(?::text[])').all(ids);
  assert.ok(rows.every((r) => r.served_model === STEADY && Number(r.explored) === 0), 'every call served as usual');
  const v = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  assert.match(v.explore.reason || '', /prices what serves/);
  assert.equal(v.explore.servingCostKnown, false);
});

test('taking a meaning away from a reported event takes it off every call it was reported on', async () => {
  const s = await shop('meaning');
  await saveDef(s.workload.id, { events: [{ event: 'ticket_reopened', means: 'worked' }] });
  const id = await send(s.secret, request(5000));
  await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/outcomes`, { method: 'POST',
    headers: { Authorization: `Bearer ${s.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_id: id, event: 'ticket_reopened' }) });
  await learningSettled();
  assert.equal(Number((await db.prepare('SELECT reward FROM calls WHERE id = ?').get(id)).reward), 1, 'read as worked, as the meaning said');
  await saveDef(s.workload.id, { events: [] });
  const after = await db.prepare('SELECT reward FROM calls WHERE id = ?').get(id);
  assert.equal(after.reward, null, 'with no meaning, the report says nothing either way');
});

test('a call the provider failed is listed with its reason, never breaks the list', async () => {
  const s = await shop('failedcall');
  await recordCall({ workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF, servedModel: STEADY,
    statusCode: 503, latencyMs: 40, request: request(6000) });
  await recordCall({ workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF, servedModel: STEADY,
    statusCode: 0, latencyMs: 40, request: request(6001) });
  const o = await outcomeSummary(s.workload.id);
  assert.ok(o.failures.every((f) => Array.isArray(f.why)), 'every reason is a list');
  assert.ok(o.failures.some((f) => f.why[0] === 'the provider failed the call (503)'));
  assert.ok(o.failures.some((f) => f.why[0] === 'the provider could not be reached'));
});

test('an experiment is held to the same call policy as what serves: a busy reply is retried once whichever way a call is served', async () => {
  const s = await shop('policy');
  for (const m of [REF, STEADY, CHEAPER]) busyOnce.add(m);
  try {
    const ids = [];
    for (let i = 0; i < 30; i += 1) ids.push(await send(s.secret, request(7000 + i)));
    const busy = await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND status_code = 429').get(s.workload.id);
    assert.equal(Number(busy.n), 0, 'no try was given up after one busy reply, the yardstick\'s and the runner-up\'s included');
    const rows = await db.prepare('SELECT served_model, explored FROM calls WHERE id = ANY(?::text[])').all(ids);
    assert.ok(rows.some((r) => r.served_model === REF && Number(r.explored) === 1), 'the yardstick answered some, after its retry');
    assert.ok(rows.some((r) => r.served_model === STEADY && Number(r.explored) === 0), 'and what serves answered the rest, after its own');
  } finally {
    busyOnce.clear();
    triedOnce.clear();
  }
});

test('a router serving a live call waits on a busy provider as a live call does, not as a measurement does', async () => {
  const s = await shop('router-policy', { explore: 'off' });
  const zeros = [0, 0, 0, 0, 0, 0];
  const router = { kind: 'router', cheap: { model: CHEAPER, recipe: null }, strong: { model: REF, recipe: null }, threshold: 0.5,
    weights: zeros, bias: 5, means: zeros, sds: zeros.map(() => 1) };
  const r = await promote(s.workload, `router:${CHEAPER}`, { spec: router, auto: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  alwaysBusy.add(CHEAPER);
  hits.clear();
  try {
    const id = await send(s.secret, request(7100));
    assert.equal(hits.get(CHEAPER), 1 + config.LIVE_RETRIES, 'one try and the live retries, then the customer\'s own model');
    assert.equal((await db.prepare('SELECT served_model FROM calls WHERE id = ?').get(id)).served_model, REF);
  } finally {
    alwaysBusy.clear();
  }
});

test('a drift in how often calls fail after a switch reads the same on both sides, and a real gap is still switched back', async () => {
  const DAYMS = 86400000;
  /* Twenty days of one switch: its first ten taking over on five calls in a hundred while the customer's
     own model kept ninety five, when one call in a hundred failed everywhere; then ten with the customer's
     own model as the yardstick on three in a hundred, when six in a hundred failed everywhere. What serves
     fails `servingFail` in each hundred in each half. */
  const twentyDays = async (tag, servingFail) => {
    const s = await shop(tag);
    await saveDef(s.workload.id, { events: [{ event: 'ticket_reopened', means: 'failed' }] });
    await db.prepare(`UPDATE promotions SET created_at = ? WHERE workload_id = ? AND action = 'promote'`).run(now() - 21 * DAYMS, s.workload.id);
    await db.prepare('UPDATE workloads SET promoted_at = ? WHERE id = ?').run(now() - 21 * DAYMS, s.workload.id);
    const steady = await armOf(s.workload.id, STEADY);
    const yours = await upsertArm(s.workload, referenceSpec(s.workload), { status: 'baseline', offline: { ratio: 1 } });
    const t = now() - 3600000;
    const early = { from: t - 20 * DAYMS, to: t - 10 * DAYMS };
    const late = { from: t - 10 * DAYMS, to: t };
    await bulk(s, { armId: yours.id, model: REF, n: 9500, propensity: 0.95, ...early, failPer100: 1 });
    await bulk(s, { armId: steady.id, model: STEADY, n: 500, propensity: 0.05, ...early, failPer100: servingFail[0] });
    await bulk(s, { armId: yours.id, model: REF, n: 300, propensity: 0.03, explored: 1, ...late, failPer100: 6 });
    await bulk(s, { armId: steady.id, model: STEADY, n: 9700, propensity: 0.97, ...late, failPer100: servingFail[1] });
    return { s, decisions: await reviewWorkload(s.workload) };
  };
  const drift = await twentyDays('drift', [1, 6]);
  assert.deepEqual(drift.decisions, [], 'the same drift on both sides is neither strategy\'s doing');
  const worse = await twentyDays('drift-worse', [6, 11]);
  assert.deepEqual(worse.decisions.map((d) => d.kind), ['revert'], 'five points worse all along is still switched back');
});

test('a strategy that fails and is answered another way is priced on the calls it answered, and each call is counted once', async () => {
  const { routedSavings } = await import('../src/eval/actual.js');
  const s = await shop('priced', { explore: 'off' });
  const steady = await armOf(s.workload.id, STEADY);
  const yours = await upsertArm(s.workload, referenceSpec(s.workload), { status: 'baseline', offline: { ratio: 1 } });
  const write = (i, extra) => recordCall({ workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF,
    promptTokens: 500, completionTokens: 40, request: request(9000 + i), response: { choices: [{ message: { content: JSON.stringify(right(i)) } }] },
    ...extra });
  // a hundred calls given to what serves by chance: ninety answered, ten failed and answered by the customer's own model instead
  for (let i = 0; i < 100; i += 1) {
    if (i % 10) {
      await write(i, { servedModel: STEADY, statusCode: 200, costUsd: COST[STEADY], armId: steady.id, propensity: 0.98, explored: 0 });
    } else {
      await write(i, { servedModel: STEADY, statusCode: 503, costUsd: 0, armId: steady.id, propensity: 0.98, explored: 0,
        check: { by: 'fell back', status: 503, why: 'Provider is overloaded' } });
      await write(i + 1000, { servedModel: REF, statusCode: 200, costUsd: COST[REF], armId: null, propensity: 1, explored: 0 });
    }
  }
  // and sixty on the customer's own model as the yardstick
  for (let i = 0; i < 60; i += 1) {
    await write(2000 + i, { servedModel: REF, statusCode: 200, costUsd: COST[REF], armId: yours.id, propensity: 0.01, explored: 1 });
  }
  await learningSettled();
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ? AND created_at > ?').run(now() - 3600000, s.workload.id, now() - 3600000);
  forgetState(s.workload.id);
  await reviewWorkload(s.workload);
  const ratio = JSON.parse((await armOf(s.workload.id, STEADY)).stats_json).liveRatio;
  close(ratio, COST[STEADY] / COST[REF], 1e-9, 'what one of its answered calls costs against one of yours, failures left out');
  // every call the customer made is counted once, at what it would have cost on their own model
  const saved = await routedSavings({ workspaceId: s.workspace.id, workloadId: s.workload.id, days: 1, at: now() });
  const customerCalls = 3 + 100 + 60;
  assert.equal(saved.calls, customerCalls, 'the ten failed tries are not calls of the customer\'s: the answers that stood in are');
  close(saved.would, customerCalls * COST[REF], 1e-9, 'each of them once, at the customer\'s own price');
});

test('a task stays where an experiment put it only while that experiment could still be run, and never past a day', async () => {
  const s = await shop('task-gates');
  const yours = await upsertArm(s.workload, referenceSpec(s.workload), { status: 'baseline', offline: { ratio: 1 } });
  const cheaper = await armOf(s.workload.id, CHEAPER);
  const load = () => db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  /* A task's steps, as the customer's app sends them, the first one given to `arm` by an experiment with a
     chance nothing else is ever given (0.37), so a step that stayed with it can be told from one drawn again. */
  let k = 0;
  const step = async (messages, { arm, model, i }) => {
    const said = { role: 'assistant', content: JSON.stringify(right(i)) };
    const id = await recordCall({ workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF,
      servedModel: model, statusCode: 200, costUsd: COST[model], request: { model: REF, messages },
      response: { choices: [{ message: said }] }, armId: arm.id, propensity: 0.37, explored: 1 });
    await learningSettled();
    return { id, next: [...messages, said, { role: 'user', content: `and the tax on it? #${i + 500}` }] };
  };
  const task = async ({ arm = yours, model = REF } = {}) => {
    k += 1;
    return (await step([{ role: 'system', content: `Extract the totals from invoice ${960000 + k}.` }, { role: 'user', content: `document #${8000 + k}` }],
      { arm, model, i: 8000 + k })).next;
  };
  const pick = async (messages) => {
    await stateOf(await load(), { fresh: true });
    return chooseStrategy(await load(), { body: { model: REF, messages } });
  };
  const stayed = (p, arm) => p?.task === true && p.armId === arm.id && p.propensity === 0.37 && p.explored === true;
  const steady = await armOf(s.workload.id, STEADY);
  const usual = (p) => p.armId === steady.id && p.propensity === 1 && p.explored === false;

  assert.ok(stayed(await pick(await task()), yours), 'within every limit, the next step stays with the yardstick');
  // experiments turned off stop the tasks already running
  await db.prepare(`UPDATE workloads SET explore_mode = 'off' WHERE id = ?`).run(s.workload.id);
  assert.ok(usual(await pick(await task())), 'experiments off: the next step is served the usual way');
  await db.prepare(`UPDATE workloads SET explore_mode = 'normal' WHERE id = ?`).run(s.workload.id);
  // the day's experiment budget, used up by these very tasks
  await db.prepare('UPDATE workloads SET explore_budget_usd = 0.0001 WHERE id = ?').run(s.workload.id);
  assert.ok(usual(await pick(await task())), 'the day\'s budget used: the next step is served the usual way');
  await db.prepare('UPDATE workloads SET explore_budget_usd = 100 WHERE id = ?').run(s.workload.id);
  // the workspace's own optimizing budget, used up
  await db.prepare('UPDATE workspaces SET optimize_budget_usd = 0 WHERE id = ?').run(s.workspace.id);
  assert.ok(usual(await pick(await task())), 'the workspace\'s optimizing budget used: served the usual way');
  await db.prepare('UPDATE workspaces SET optimize_budget_usd = NULL WHERE id = ?').run(s.workspace.id);
  // a runner-up switched off in Models
  const onCheaper = await task({ arm: cheaper, model: CHEAPER });
  assert.ok(stayed(await pick(onCheaper), cheaper), 'a runner-up still switched on keeps its task');
  await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, 0, ?)
      ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = 0`).run(s.workspace.id, CHEAPER, now());
  const off = await pick(onCheaper);
  assert.ok(!stayed(off, cheaper) && off.armId !== cheaper.id, 'switched off in Models: its task goes elsewhere');
  await db.prepare('DELETE FROM workspace_models WHERE workspace_id = ? AND model_id = ?').run(s.workspace.id, CHEAPER);
  // a task older than a day is drawn again, however closely its steps follow each other
  k += 1;
  const first = await step([{ role: 'system', content: `Extract the totals from invoice ${960000 + k}.` }, { role: 'user', content: `document #${8000 + k}` }],
    { arm: yours, model: REF, i: 8000 + k });
  const second = await step(first.next, { arm: yours, model: REF, i: 8100 + k });
  assert.equal((await db.prepare('SELECT task_id FROM calls WHERE id = ?').get(second.id)).task_id, first.id, 'one task of two steps');
  assert.ok(stayed(await pick(second.next), yours), 'a young task keeps its strategy');
  await db.prepare('UPDATE calls SET created_at = ? WHERE id = ?').run(now() - 25 * 3600000, first.id);
  await db.prepare('UPDATE calls SET created_at = ? WHERE id = ?').run(now() - 3600000, second.id);
  const old = await pick(second.next);
  assert.ok(!(old.task === true) && old.propensity !== 0.37, 'begun a day and an hour ago, its next step is drawn again');
});

test('the review tells the rule how long each record has been gathering, which its chance of being wrong is spent over', async () => {
  const s = await shop('ages');
  const steady = await armOf(s.workload.id, STEADY);
  await db.prepare('UPDATE arms SET created_at = ? WHERE id = ?').run(now() - 40 * 86400000, steady.id);
  // learning began two days ago, with the switch, so nothing was compared before that
  close((await stateOf(s.workload, { fresh: true })).byId.get(steady.id).ageDays, 2, 0.01, 'since learning began');
  await db.prepare('UPDATE promotions SET created_at = ? WHERE workload_id = ?').run(now() - 60 * 86400000, s.workload.id);
  close((await stateOf(s.workload, { fresh: true })).byId.get(steady.id).ageDays, 40, 0.01, 'since it was first kept, where that is later');
});

test('evidence is counted in tasks: one forty step task is one piece of evidence, not forty', async () => {
  const s = await shop('one-task');
  await history(s, STEADY, { n: 120 });
  const cheaper = await armOf(s.workload.id, CHEAPER);
  await bulk(s, { armId: cheaper.id, model: CHEAPER, n: 40, propensity: 0.25, explored: 1, from: now() - 3 * 3600000, to: now() - 2 * 3600000,
    failPer100: 100, task: `one-long-task-${process.pid}` });
  assert.deepEqual(await reviewWorkload(s.workload), [], 'forty failed steps of one task are not enough to set a runner-up aside');
  assert.equal((await armOf(s.workload.id, CHEAPER)).status, 'trying');
  // forty tasks of one step each are forty pieces of evidence, and do set it aside
  await bulk(s, { armId: cheaper.id, model: CHEAPER, n: 40, propensity: 0.25, explored: 1, from: now() - 3 * 3600000, to: now() - 2 * 3600000,
    failPer100: 100 });
  assert.deepEqual((await reviewWorkload(s.workload)).map((d) => d.kind), ['rest']);
});
