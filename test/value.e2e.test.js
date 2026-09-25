/* What Understudy is doing for a workload, the figures its page leads with (src/eval/value.js), end to end on a
   real database and through the page's own route.

   What is checked: what a workload's requests cost through us, testing included, against the customer's own
   model alone; how often answers worked and how fast they came, on what serves since the switch against the
   customer's own model before it; which failed tries count as rescued and which do not; an hour of rescues
   marked as an outage; how requests flow and what each path costs; the history, a day at a time, with every
   event in order and named the way the page names it; a switch that waits for its first request; what is
   always on, as the workspace has it set; the route, for its owner only; and a real rescue through the proxy,
   a failing provider answered by the customer's own model. The records are written the way the app writes
   them, so every figure below can be worked out by hand. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4851;
const APP_PORT = 4852;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_value_${process.pid}`;
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
process.env.ALERTS_ENABLED = 'false';
process.env.REQUEST_LOGS = 'false';
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.EVAL_JUDGE_MODEL = 'judge/small';

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { move } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { learningSettled } = await import('../src/traffic.js');
const { promote, keyOfSpec } = await import('../src/eval/promote.js');
const { valueOf } = await import('../src/eval/value.js');
const { barNeed } = await import('../src/eval/plan.js');
const { withFeeOn } = await import('../src/eval/savings.js');
const { routedSavings } = await import('../src/eval/actual.js');
const { armKey, labelOf } = await import('../src/learn/arms.js');
const { app } = await import('../src/server.js');
const { leftOf } = await import('../src/api.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/steady-small';
const OTHER = 'vendor/other-model';
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const FEE = 1 + config.ROUTING_FEE_PCT / 100;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} against ${b}`);

// the provider: the customer's own model answers, the cheap one fails while it is told to
const failing = new Set();
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    if (failing.has(p.model)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Provider is overloaded' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `gen-${Date.now()}`, model: p.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `answer from ${p.model}` } }],
      usage: { prompt_tokens: 1200, completion_tokens: 40, cost: p.model === REF ? 0.004 : 0.0004 } }));
  });
});
let server = null;
const base = `http://127.0.0.1:${APP_PORT}`;

test.before(async () => {
  await new Promise((r) => provider.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: OTHER, name: 'other', context_len: 128000, price_in: 0.1e-6, price_out: 0.4e-6, open_weights: 1, zdr: 1 },
    { model_id: 'judge/small', name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => provider.close(r));
  await new Promise((r) => server.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

/* The records, written the way the app writes them ------------------------------------------------ */

let seq = 0;
async function account({ credit = 20 } = {}) {
  seq += 1;
  const email = `value-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password: 'correct-horse-battery', name: `v${seq}` });
  if (credit) await move(workspace.id, { kind: 'credit', amountUsd: credit, note: 'test' });
  return { ws: workspace, email };
}
const hex = () => `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);

async function workload(ws, slug, { created = now() - 40 * DAY, mode = 'ask' } = {}) {
  const wid = id('wl');
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, optimize_mode, status,
      floor_pct, sample_prompt, tool_names, created_at, updated_at, calls_seen, state, named_at, name_source, recheck_after, recheck_streak)
    VALUES (?, ?, ?, ?, 'free_text', ?, ?, 'certified', 4.0, 'Answer in one sentence.', '[]', ?, ?, 0, 'live', ?, 'model', ?, 0)`)
    .run(wid, ws.id, slug, hex(), REF, mode, created, created, created, now() + 20 * DAY);
  return wid;
}
async function arm(ws, wid, spec, { status = 'serving', ratio = null, at = now() } = {}) {
  const aid = id('arm');
  await db.prepare(`INSERT INTO arms (id, workspace_id, workload_id, kind, key, spec_json, label, status, origin_run_id, offline_json,
      stats_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`)
    .run(aid, ws.id, wid, spec.kind, armKey(spec), JSON.stringify(spec), labelOf(spec, REF), status,
      JSON.stringify({ verdict: 'cleared', ratio }), at, at);
  return aid;
}
const switchTo = (wid, { model, armId, at, recipe = null, rollout = null }) => db.prepare(`UPDATE workloads SET routed_model = ?,
    routed_recipe = ?, routed_arm_id = ?, promoted_at = ?, status = 'promoted', rollout_share = ? WHERE id = ?`)
  .run(model, recipe ? JSON.stringify(recipe) : null, armId, at, rollout, wid);

async function call(ws, wid, c) {
  const cid = id('call');
  const cost = c.cost ?? 0.004;
  const status = c.status ?? 200;
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model, status_code, prompt_tokens,
      completion_tokens, cost_usd, charged_usd, latency_ms, request_json, response_json, created_at, ttft_ms, request_hash, task_id, step,
      arm_id, escalated, check_json, reward, cost_estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1200, 40, ?, ?, ?, '{}', '{}', ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)`)
    .run(cid, ws.id, wid, c.source ?? 'routed', REF, c.served ?? REF, status, cost,
      c.charged ?? (c.source === 'trace' || status !== 200 ? 0 : cost * FEE), c.lat ?? 1000, Math.round(c.at), c.ttft ?? null,
      c.hash ?? hex(), cid, c.arm ?? null, c.escalated ?? null, c.check ? JSON.stringify(c.check) : null,
      c.reward === undefined ? 1 : c.reward);
  return cid;
}
// a try that failed and was answered another way, and optionally the answer that stood in for it
const failedTry = (ws, wid, at, { hash, arm: armId = null, by = 'fell back' } = {}) => call(ws, wid, {
  at, served: CHEAP, arm: armId, status: 502, cost: 0, lat: 9000, hash, reward: null, check: { by, status: 502 } });

async function run(ws, wid, { at, trigger = 'automatic', outcome = 'compared', status = 'done', spend = 0, refCost = 300, results = [] }) {
  const rid = id('run');
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, floor_pct, noise_pct,
      spend_usd, started_at, finished_at, created_at, trigger, outcome, yardstick)
    VALUES (?, ?, ?, ?, 'free_text', ?, 40, 4.0, 3.0, ?, ?, ?, ?, ?, ?, 'agreement')`)
    .run(rid, ws.id, wid, status, REF, spend, at - 10 * MIN, at, at - 10 * MIN, trigger, outcome);
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, created_at)
    VALUES (?, ?, ?, 80, 0, ?, 'reference', ?)`).run(id('res'), rid, REF, refCost, at);
  for (const r of results) {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, created_at, arm_json)
      VALUES (?, ?, ?, 40, ?, ?, ?, ?, ?)`).run(id('res'), rid, r.key, r.gap ?? 2, r.cost, r.verdict, at, r.spec ? JSON.stringify(r.spec) : null);
  }
  return rid;
}
const promo = (wid, { at, action, from, to, reason = null, actor = null }) => db.prepare(`INSERT INTO promotions
    (id, workload_id, action, from_model, to_model, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(id('pro'), wid, action, from, to, reason, actor, at);
const activity = (ws, wid, at, title) => db.prepare(`INSERT INTO activity (id, workspace_id, workload_id, kind, title, created_at)
    VALUES (?, ?, ?, 'ok', ?, ?)`).run(id('act'), ws.id, wid, title, at);
const shadow = (ws, wid, armId, at, cost = 0) => db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, agreement, cost_usd,
    latency_ms, status, created_at) VALUES (?, ?, ?, ?, 1, ?, 800, 200, ?)`).run(id('shd'), ws.id, wid, armId, cost, at);
const graded = (ws, wid, callId, at, cost) => db.prepare(`INSERT INTO graded_calls (call_id, workspace_id, workload_id, arm_id, bad, p,
    judged_by, cost_usd, created_at) VALUES (?, ?, ?, NULL, 0, 0.9, 'judge', ?, ?)`).run(callId, ws.id, wid, cost, at);

const CASCADE = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };

/* The figures -------------------------------------------------------------------------------------- */

test('what a workload costs is its requests through us plus what testing cost, against the customer\'s own model alone', async () => {
  const { ws } = await account();
  const t = now();
  const wid = await workload(ws, 'money');
  const armId = await arm(ws, wid, CASCADE, { ratio: 0.25, at: t - 10 * DAY });
  await switchTo(wid, { model: CHEAP, armId, at: t - 10 * DAY });
  for (let i = 0; i < 20; i += 1) await call(ws, wid, { at: t - 20 * DAY + i * HOUR, cost: 0.004 });
  let one = null;
  for (let i = 0; i < 41; i += 1) one = await call(ws, wid, { at: t - 9 * DAY + i * HOUR, served: CHEAP, arm: armId, cost: 0.001 });
  // testing: a measurement inside the thirty days and one before them, background answers, and an answer read in the background
  await run(ws, wid, { at: t - 12 * DAY, trigger: 'first', spend: 0.2 });
  await run(ws, wid, { at: t - 45 * DAY, trigger: 'first', spend: 1 });
  for (let i = 0; i < 5; i += 1) await shadow(ws, wid, armId, t - 5 * DAY + i * HOUR, 0.01);
  await graded(ws, wid, one, t - 3 * DAY, 0.03);

  const v = await valueOf(await load(wid));
  const paid = (20 * 0.004 + 41 * 0.001) * FEE;
  // the customer's own model's requests cost what they cost; the strategy's, what it cost divided by its measured ratio
  const before = 20 * 0.004 + (41 * 0.001) / 0.25;
  const optimizing = withFeeOn(0.2 + 0.05 + 0.03, config.ROUTING_FEE_PCT);
  assert.equal(v.money.calls, 61);
  near(v.money.paid, paid, 'paid through us');
  near(v.money.before, before, 'what the customer\'s own model would have cost');
  near(v.money.optimizing, optimizing, 'testing, with our fee, and nothing from before the thirty days');
  near(v.money.now, paid + optimizing, 'what it cost in all');
  near(v.money.saved, before - paid - optimizing, 'what was saved, which here is a shortfall');
  assert.equal(v.money.feePct, config.ROUTING_FEE_PCT);

  // nothing switched: the requests cost our fee on top, and that is all
  const own = await workload(ws, 'money-own');
  for (let i = 0; i < 10; i += 1) await call(ws, own, { at: t - 2 * DAY + i * HOUR, cost: 0.004 });
  const o = await valueOf(await load(own));
  near(o.money.saved, -(10 * 0.004 * (FEE - 1)), 'a workload nothing was switched on is short by the fee alone');
  assert.equal(o.switched, false);
  assert.equal(o.paths.kind, 'reference');
});

test('answers that worked and the typical time are read on what serves since the switch, against the customer\'s own model before it', async () => {
  const { ws } = await account();
  const t = now();
  const at = t - 10 * DAY;
  const wid = await workload(ws, 'answers');
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at });
  await switchTo(wid, { model: CHEAP, armId, at });
  // before: ten on the customer's own model, eight worked, one did not, one said nothing and is old enough to count as worked
  for (let i = 0; i < 10; i += 1) {
    await call(ws, wid, { at: at - 5 * DAY + i * HOUR, lat: 1000 + 100 * i, reward: i < 8 ? 1 : i === 8 ? 0 : null });
  }
  // since: twelve on what serves, eleven worked
  for (let i = 0; i < 12; i += 1) {
    await call(ws, wid, { at: at + DAY + i * HOUR, served: CHEAP, arm: armId, cost: 0.0004, lat: 500 + 100 * i, reward: i < 11 ? 1 : 0.2 });
  }
  // one that worked and has no time, and one too new for anything to have been heard about it yet
  await call(ws, wid, { at: at + 2 * DAY, served: CHEAP, arm: armId, cost: 0.0004, lat: 0, reward: 1 });
  await call(ws, wid, { at: t - MIN, served: CHEAP, arm: armId, cost: 0.0004, lat: 700, reward: null });
  // a try that failed, and the answer the customer's own model gave instead: neither is what serves
  const hash = hex();
  await failedTry(ws, wid, at + 3 * DAY, { hash, arm: armId });
  await call(ws, wid, { at: at + 3 * DAY + MIN, lat: 2000, hash, reward: 1 });

  const v = await valueOf(await load(wid));
  assert.equal(v.switched, true);
  assert.equal(v.switchedAt, at);
  assert.deepEqual(v.quality.now, { rate: Math.round((12 / 13) * 1e8) / 1e8, calls: 14 },
    'twelve of the thirteen old enough to judge worked; the failed try and the answer that stood in are not counted');
  assert.deepEqual(v.quality.before, { rate: 0.9, calls: 10 });
  assert.equal(v.speed.metric, 'latency');
  assert.deepEqual(v.speed.now, { ms: 1000, calls: 13 }, 'the middle of thirteen timed answers; the one with no time is left out');
  assert.deepEqual(v.speed.before, { ms: 1450, calls: 10 });

  // most requests stream, so the time read is the wait for the first word
  const streamed = await workload(ws, 'streamed');
  for (let i = 0; i < 10; i += 1) {
    await call(ws, streamed, { at: t - 3 * DAY + i * HOUR, lat: 2000, ttft: i < 6 ? 300 + 100 * i : null });
  }
  const s = await valueOf(await load(streamed));
  assert.equal(s.speed.metric, 'ttft');
  assert.deepEqual(s.speed.now, { ms: 550, calls: 6 });
  assert.equal(s.speed.before, null, 'nothing was switched, so there is no before');
  assert.equal(s.quality.before, null);
});

test('a rescue is a failed try whose request was answered within ten minutes, and nothing else is', async () => {
  const { ws } = await account();
  const t = now();
  const wid = await workload(ws, 'rescues');
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at: t - 20 * DAY });
  await switchTo(wid, { model: CHEAP, armId, at: t - 20 * DAY });
  const at = t - 3 * DAY;
  const h = () => hex();
  // answered two minutes later: rescued
  const a = h();
  await failedTry(ws, wid, at, { hash: a, arm: armId });
  await call(ws, wid, { at: at + 2 * MIN, hash: a });
  // never answered
  await failedTry(ws, wid, at + HOUR, { hash: h(), arm: armId });
  // answered, but eleven minutes later
  const c = h();
  await failedTry(ws, wid, at + 2 * HOUR, { hash: c, arm: armId });
  await call(ws, wid, { at: at + 2 * HOUR + 11 * MIN, hash: c });
  // followed only by another try that failed
  const d = h();
  await failedTry(ws, wid, at + 3 * HOUR, { hash: d, arm: armId });
  await failedTry(ws, wid, at + 3 * HOUR + MIN, { hash: d, arm: armId });
  // answered, but it was another request
  await failedTry(ws, wid, at + 4 * HOUR, { hash: h(), arm: armId });
  await call(ws, wid, { at: at + 4 * HOUR + MIN, hash: h() });
  // rescued, but more than thirty days ago
  const f = h();
  await failedTry(ws, wid, t - 31 * DAY, { hash: f, arm: armId });
  await call(ws, wid, { at: t - 31 * DAY + MIN, hash: f });
  // an experiment that failed, answered the usual way: rescued
  const g = h();
  await failedTry(ws, wid, at + 5 * HOUR, { hash: g, arm: armId, by: 'experiment failed' });
  await call(ws, wid, { at: at + 5 * HOUR + 30000, hash: g });

  const v = await valueOf(await load(wid));
  assert.deepEqual(v.rescued, { count: 2, days: 30 });
  assert.equal(v.history.events.filter((e) => e.kind === 'outage').length, 0, 'one rescue an hour is not an outage');
});

test('an hour with three or more rescues is an outage on the history, and an hour with two is not', async () => {
  const { ws } = await account();
  const t = now();
  const wid = await workload(ws, 'outage');
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at: t - 20 * DAY });
  await switchTo(wid, { model: CHEAP, armId, at: t - 20 * DAY });
  const hour = Math.floor((t - 5 * DAY) / HOUR) * HOUR;
  for (const m of [5, 10, 20, 32 + 2 * 60, 40 + 2 * 60]) {
    const hash = hex();
    await failedTry(ws, wid, hour + m * MIN, { hash, arm: armId });
    await call(ws, wid, { at: hour + m * MIN + MIN, hash });
  }
  const v = await valueOf(await load(wid));
  assert.equal(v.rescued.count, 5);
  const outages = v.history.events.filter((e) => e.kind === 'outage');
  assert.deepEqual(outages.map((e) => ({ at: e.at, rescued: e.rescued })), [{ at: hour, rescued: 3 }]);
});

test('the paths: a cascade\'s share sent on is read from live requests once there are twenty, with each path\'s cost', async () => {
  const { ws } = await account();
  const t = now();
  const at = t - 3 * DAY;
  const wid = await workload(ws, 'paths');
  const armId = await arm(ws, wid, CASCADE, { ratio: 0.2, at });
  await switchTo(wid, { model: CHEAP, armId, at });
  for (let i = 0; i < 25; i += 1) {
    const on = i % 5 === 0;
    await call(ws, wid, { at: at + HOUR + i * HOUR, served: on ? REF : CHEAP, arm: armId, escalated: on ? 1 : 0, cost: on ? 0.005 : 0.0004 });
  }
  // two rescued, whose answers are requests of the customer's but not the strategy's
  for (let i = 0; i < 2; i += 1) {
    const hash = hex();
    await failedTry(ws, wid, at + 30 * HOUR + i * HOUR, { hash, arm: armId });
    await call(ws, wid, { at: at + 30 * HOUR + i * HOUR + MIN, hash, cost: 0.004 });
  }
  // and six that arrived only as copies
  for (let i = 0; i < 6; i += 1) await call(ws, wid, { at: at + 40 * HOUR + i * HOUR, source: 'trace', cost: 0.004 });

  const v = await valueOf(await load(wid));
  const days = (v.at - (at + HOUR)) / DAY;
  assert.equal(v.paths.kind, 'cascade');
  assert.equal(v.paths.calls, 25);
  near(v.paths.sentOn, 0.2, 'five of twenty-five sent on');
  near(v.paths.perDay, 27 / days, 'requests a day, the rescued ones included');
  near(v.paths.copiesPerDay, 6 / days, 'copies a day');
  near(v.paths.shortPerCall, 0.0004 * FEE, 'a request the check was sure of');
  near(v.paths.longPerCall, 0.005 * FEE, 'a request sent on');
  near(v.paths.perCall, ((20 * 0.0004 + 5 * 0.005) * FEE) / 25, 'a request on average');
  near(v.paths.ownPerCall, ((20 * 0.0004 + 5 * 0.005) / 0.2 + 2 * 0.004) / 27, 'a request on the customer\'s own model');
  assert.equal(v.paths.rolloutShare, null);

  // too few live requests to read a share from, and a switch still taking over
  const few = await workload(ws, 'paths-few');
  const fewArm = await arm(ws, few, CASCADE, { ratio: 0.2, at });
  await switchTo(few, { model: CHEAP, armId: fewArm, at, rollout: 0.25 });
  for (let i = 0; i < 10; i += 1) await call(ws, few, { at: at + HOUR + i * HOUR, served: CHEAP, arm: fewArm, escalated: 0, cost: 0.0004 });
  const f = await valueOf(await load(few));
  assert.equal(f.paths.sentOn, null, 'ten requests are too few to say what share is sent on');
  assert.equal(f.paths.rolloutShare, 0.25);
});

test('the history: saved a day at a time since first seen, net of testing, with every event in order', async () => {
  const { ws, email } = await account();
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const t = now();
  const wid = await workload(ws, 'story', { created: t - 21 * DAY });
  const cascadeKey = keyOfSpec(CASCADE, REF);
  // first seen as a copy, then requests through us
  await call(ws, wid, { at: t - 20 * DAY + HOUR, source: 'trace' });
  for (let i = 0; i < 19; i += 1) await call(ws, wid, { at: t - 19 * DAY + i * DAY, cost: 0.004 });
  await run(ws, wid, { at: t - 18 * DAY, trigger: 'first', spend: 0.1, results: [
    { key: CHEAP, verdict: 'cleared', cost: 10 },
    { key: cascadeKey, verdict: 'cleared', cost: 20, spec: CASCADE },
    { key: OTHER, verdict: 'missed', cost: 5 },
  ] });
  await promo(wid, { at: t - 17 * DAY, action: 'promote', from: REF, to: cascadeKey, reason: 'you approved it', actor: user.id });
  await activity(ws, wid, t - 16 * DAY, `${labelOf(CASCADE, REF)} now answers 25% of story's calls`);
  await activity(ws, wid, t - 15 * DAY, `${labelOf(CASCADE, REF)} now answers all of story's calls`);
  const trialArm = await arm(ws, wid, { kind: 'model', model: OTHER, recipe: null }, { status: 'trying', ratio: 0.05, at: t - 12 * DAY });
  await shadow(ws, wid, trialArm, t - 12 * DAY, 0.02);
  await shadow(ws, wid, trialArm, t - 11 * DAY, 0.02);
  // rolled back to what served before it, which was the cheap model on its own
  await promo(wid, { at: t - 10 * DAY, action: 'soft_revert', from: cascadeKey, to: CHEAP, reason: 'Live results: since the switch, calls worked less.' });
  await run(ws, wid, { at: t - 8 * DAY, trigger: 'manual', outcome: 'unmeasurable' });
  await run(ws, wid, { at: t - 7 * DAY, trigger: 'manual', status: 'failed', outcome: 'interrupted' });
  await promo(wid, { at: t - 5 * DAY, action: 'revert', from: CHEAP, to: REF, reason: 'you asked for it', actor: user.id });
  await activity(ws, wid, t - 3 * DAY, 'steady-small is ready to approve on story');

  const v = await valueOf(await load(wid));
  const e = v.history.events;
  assert.deepEqual(e.map((x) => x.kind), ['connected', 'test', 'switch', 'step', 'step', 'trial', 'back', 'test', 'back', 'ready'],
    'every event, oldest first; a measurement that did not finish is not one');
  assert.equal(e[0].via, 'trace');
  assert.deepEqual({ trigger: e[1].trigger, outcome: e[1].outcome, tried: e[1].tried, passed: e[1].passed, best: e[1].best },
    { trigger: 'first', outcome: 'compared', tried: 3, passed: 2, best: 'steady-small' });
  near(e[1].spend, withFeeOn(0.1, config.ROUTING_FEE_PCT), 'what the test cost, with our fee');
  assert.deepEqual({ by: e[2].by, to: e[2].to }, { by: 'you', to: labelOf(CASCADE, REF) }, 'a strategy is named the way its test named it');
  assert.deepEqual([e[3].share, e[4].share], [0.25, 1]);
  assert.deepEqual({ label: e[5].label, answers: e[5].answers }, { label: 'other-model', answers: 2 });
  assert.deepEqual({ by: e[6].by, to: e[6].to, toOwn: e[6].toOwn, fromKey: e[6].fromKey },
    { by: 'automatic', to: 'steady-small', toOwn: false, fromKey: cascadeKey }, 'a roll back goes to what served before, not to the customer\'s own model');
  assert.deepEqual({ trigger: e[7].trigger, outcome: e[7].outcome, tried: e[7].tried }, { trigger: 'manual', outcome: 'unmeasurable', tried: 0 });
  assert.deepEqual({ by: e[8].by, to: e[8].to, toOwn: e[8].toOwn }, { by: 'you', to: 'gpt-5.4', toOwn: true });
  assert.equal(e[9].label, 'steady-small');

  // a day at a time since first seen, ending on what was saved, net of what testing cost
  assert.equal(v.history.firstSeen, t - 20 * DAY + HOUR);
  assert.equal(v.history.series.length, 21);
  const life = await routedSavings({ workspaceId: ws.id, workloadId: wid, days: 21, at: v.at });
  const testing = withFeeOn(0.1 + 0.04, config.ROUTING_FEE_PCT);
  near(v.history.testing, testing, 'what testing cost over the life of the workload');
  near(v.history.saved, life.would - life.paid - testing, 'what was saved in all');
  near(v.history.series[v.history.series.length - 1].saved, v.history.saved, 'the line ends where the total does');
  for (let i = 1; i < v.history.series.length; i += 1) assert.ok(v.history.series[i].at > v.history.series[i - 1].at);
});

test('a switch set up for requests that reach us only as copies waits, and the customer\'s own model is what the figures read', async () => {
  const { ws } = await account();
  const t = now();
  const wid = await workload(ws, 'copies');
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.05, at: t - 3 * DAY });
  await switchTo(wid, { model: CHEAP, armId, at: t - 3 * DAY });
  for (let i = 0; i < 12; i += 1) await call(ws, wid, { at: t - 6 * DAY + i * 8 * HOUR, source: 'trace', lat: 1500 + 10 * i, reward: i < 11 ? 1 : 0 });
  const v = await valueOf(await load(wid));
  assert.equal(v.switched, true);
  assert.equal(v.waiting, true);
  assert.equal(v.switchedAt, null, 'nothing is served by the switch yet');
  assert.deepEqual(v.quality.now, { rate: Math.round((11 / 12) * 1e8) / 1e8, calls: 12 }, 'the copies, answered by the customer\'s own model');
  assert.equal(v.quality.before, null);
  assert.equal(v.speed.now.calls, 12);
  assert.equal(v.money.calls, 0, 'copies are not requests through us');
  assert.equal(v.history.events[0].via, 'trace');
});

test('what is always on says what the workspace has chosen', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'guards', { mode: 'auto' });
  await call(ws, wid, { at: now() - HOUR });
  const v = await valueOf(await load(wid));
  assert.deepEqual(v.guards, { zdr: true, stages: config.ROLLOUT_STAGES, mode: 'auto' });

  const other = await account();
  await db.prepare('UPDATE workspaces SET zdr_required = 0 WHERE id = ?').run(other.ws.id);
  const w2 = await workload(other.ws, 'guards-kept');
  await call(other.ws, w2, { at: now() - HOUR });
  assert.equal((await valueOf(await load(w2))).guards.zdr, false, 'a workspace that allows providers to keep requests is told so');
});

test('a workload never tested says when its first test starts, counted the way that decision counts', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'untested');
  for (let i = 0; i < 3; i += 1) await call(ws, wid, { at: now() - HOUR + i * MIN });
  await call(ws, wid, { at: now() - HOUR, source: 'trace' });
  const row = await load(wid);
  const v = await valueOf(row);
  /* and how many of its requests the first test waits for (the count its first bar takes), counted exactly as the
     test counts them, the call that brings them starting it */
  assert.deepEqual(v.tests, { runs: 0, auto: config.MEASURE_EVERY_DAYS > 0, seen: 4, firstAfter: config.EVAL_FIRST_RUN_MIN_CALLS,
    need: barNeed(row).calls, have: 4 });
  // one turned down already says the count it was left waiting for
  await db.prepare('UPDATE workloads SET measure_at_calls = 90 WHERE id = ?').run(wid);
  assert.equal((await valueOf(await load(wid))).tests.need, 90);
  // a workspace that tests only when asked starts nothing by itself
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(ws.id);
  assert.equal((await valueOf(await load(wid))).tests.auto, false);
  // once tested, it says only that
  await run(ws, wid, { at: now() - MIN, trigger: 'manual' });
  assert.deepEqual((await valueOf(await load(wid))).tests, { runs: 1, auto: false });
});

test('the time a measurement has left is worked out from its pace so far, and only once it has one', () => {
  const t = 10_000_000;
  assert.equal(leftOf({ steps_done: 4, steps_total: 100, started_at: t - 60000 }, t), null, 'too few calls yet to have a pace');
  assert.equal(leftOf({ steps_done: 40, steps_total: 100, started_at: t - 15000 }, t), null, 'too soon');
  assert.equal(leftOf({ steps_done: 50, steps_total: 100, started_at: t - 60000 }, t), 60000, 'half done in a minute: about a minute left');
  assert.equal(leftOf({ steps_done: 30, steps_total: 90, started_at: t - 30000 }, t), 60000, 'a second a call, sixty to go');
  assert.equal(leftOf({ steps_done: 100, steps_total: 100, started_at: t - 60000 }, t), null, 'nothing left to wait for');
});

test('a measurement the job runner has taken up says it is choosing its models, for as long as choosing can take', async () => {
  const mine = await account();
  const wid = await workload(mine.ws, 'choosing');
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.72' },
    body: JSON.stringify({ email: mine.email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const live = async () => (await (await fetch(`${base}/api/workloads/${wid}`, { headers: { cookie } })).json()).measure.running;
  const job = `job_choosing_${process.pid}`;
  // taken up a minute and a half ago, with no run yet: still choosing (41 s on 25 Sep; the minute this was hid slower ones)
  await db.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, run_after, claimed_at, created_at) VALUES (?, 'eval_run', ?, 'claimed', 1, ?, ?, ?)`)
    .run(job, JSON.stringify({ workloadId: wid, trigger: 'manual' }), now() - 100000, now() - 90000, now() - 100000);
  let l = await live();
  assert.equal(l?.queued, true, 'shown as not started');
  assert.equal(l?.planning, true, 'and as choosing its models');
  // waiting for a place, not taken up yet: not choosing
  await db.prepare("UPDATE jobs SET status = 'queued', claimed_at = NULL WHERE id = ?").run(job);
  l = await live();
  assert.equal(l?.queued, true);
  assert.equal(l?.planning, false, 'waiting its turn');
  // taken up longer ago than choosing could take, with no run behind it: abandoned, and not shown
  await db.prepare("UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ?").run(now() - config.EVAL_PLANNING_MAX_MS - 5000, job);
  assert.equal(await live(), null, 'not shown as starting');
  await db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job);
});

test('the page reads a workload\'s figures only for the workspace that owns it', async () => {
  const mine = await account();
  const theirs = await account();
  const wid = await workload(mine.ws, 'route');
  await call(mine.ws, wid, { at: now() - HOUR });
  const other = await workload(theirs.ws, 'route-theirs');
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.71' },
    body: JSON.stringify({ email: mine.email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const get = (path, headers = { cookie }) => fetch(`${base}/api${path}`, { headers });
  const ok = await get(`/workloads/${wid}/value`);
  assert.equal(ok.status, 200);
  const v = await ok.json();
  for (const k of ['money', 'quality', 'speed', 'rescued', 'paths', 'history', 'guards']) assert.ok(k in v, `the figures carry ${k}`);
  assert.equal(v.reference, REF);
  assert.equal((await get(`/workloads/${other}/value`)).status, 404, 'another workspace\'s workload is not found');
  assert.equal((await get(`/workloads/${wid}/value`, {})).status, 401, 'nobody signed in is told to sign in');
});

test('a request whose provider fails is answered by the customer\'s own model through the proxy, and counted as rescued', async () => {
  const s = await account({ credit: 20 });
  const key = await issueKey(s.ws.id, 'value');
  const send = async (i) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: REF, messages: [{ role: 'system', content: 'Classify the ticket.' }, { role: 'user', content: `ticket #${i}` }] }),
    });
    await res.json().catch(() => null);
    await learningSettled();
    return res;
  };
  assert.equal((await send(1)).status, 200);
  const w = await db.prepare('SELECT * FROM workloads WHERE workspace_id = ?').get(s.ws.id);
  // every request to the cheaper model, at once, and its provider down
  const p = await promote(w, CHEAP, { rollout: false });
  assert.equal(p.ok, true);
  failing.add(CHEAP);
  try {
    for (let i = 2; i <= 4; i += 1) {
      const r = await send(i);
      assert.equal(r.status, 200, 'the app gets an answer');
      assert.equal(r.headers.get('x-understudy-served-model'), REF);
    }
  } finally {
    failing.delete(CHEAP);
  }
  const v = await valueOf(await load(w.id));
  assert.equal(v.rescued.count, 3, 'each failed try was answered by the customer\'s own model');
  const hours = await db.prepare(`SELECT COUNT(DISTINCT created_at / ${HOUR}) AS n FROM calls WHERE workload_id = ?
      AND check_json LIKE '%"by":"fell back"%'`).get(w.id);
  if (Number(hours.n) === 1) {
    assert.deepEqual(v.history.events.filter((e) => e.kind === 'outage').map((e) => e.rescued), [3], 'three in one hour is an outage');
  }
});
