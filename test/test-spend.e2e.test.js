/* What a test costs, end to end: the quote a person sees before it runs, corrected by how far recent tests ran over their
   estimates; the most it may spend, held to from its first call; the money it sets aside on the balance, which a
   customer's own requests may still use and which it gives back however it ends; the testing limit every workspace has
   until it chooses another; and what is said when testing pauses.

   Driven through the real measurement against a provider stood up here, as the other measurement tests are. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4911;
const APP_PORT = 4912;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_test_${process.pid}`;
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
process.env.EVAL_SAMPLE_SIZE = '100';
process.env.EVAL_MIN_RUNS = '100';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.TYPESAFE_BASE = `http://127.0.0.1:${PORT}/typesafe`;
process.env.ALERTS_ENABLED = 'false';
process.env.ROLLOUT_ENABLED = 'false';
process.env.SPEED_SLACK_MS = '5000';
process.env.REQUEST_LOGS = 'false';
process.env.DEFAULT_OPTIMIZE_MODE = 'auto';
process.env.EVAL_USE_RECORDED = 'false';
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.CONTROL_ENABLED = 'false';

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation, closeAbandoned, stopMeasuring } = await import('../src/eval/run.js');
const { quoteCalibration, forgetQuoteCalibration, planFor } = await import('../src/eval/plan.js');
const billing = await import('../src/billing.js');
const { pageOf } = await import('../src/workloadPage.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const { move, withFee, hold, available, chargeEval, testingLimitOf, optimizeRoom, tellTestingLimit, gateRouting } = billing;
const REF = 'openai/gpt-5.4';
const STEADY = 'vendor/steady-small';
const DRIFTY = 'vendor/drifty-small';
const DAY = 86400000;
const FEE = 1 + config.ROUTING_FEE_PCT / 100;
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} against ${b}`);

/* The provider: the customer's model disagrees with itself now and then, one candidate is steady and cheap, one drifts.
   While `paused` is set every answer waits for it, so a test can change something while a measurement is mid-flight. */
const BEHAVIOUR = {
  [REF]: (i, call) => ({ total: 100 + i, currency: 'USD', lines: call === 2 && i % 10 === 0 ? 9 : (i % 5) + 1 }),
  [STEADY]: (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }),
  [DRIFTY]: () => ({ total: 999, currency: 'EUR', lines: 0 }),
};
const asksOf = new Map();
let paused = null;
let seen = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (paused) await paused;
    const payload = JSON.parse(body || '{}');
    const model = payload.model;
    const text = payload.messages?.find((m) => m.role === 'user')?.content || '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    seen += 1;
    const key = `${model}#${i}`;
    asksOf.set(key, (asksOf.get(key) || 0) + 1);
    const call = model === REF ? (asksOf.get(key) % 2 === 0 ? 2 : 1) : 1;
    const answer = BEHAVIOUR[model] ? BEHAVIOUR[model](i, call) : { total: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gen-${seen}`, model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 800, completion_tokens: 60, cost: model.includes('steady') ? 0.0002 : 0.002 },
    }));
  });
});
let appServer = null;

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { appServer = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: STEADY, name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: DRIFTY, name: 'drifty', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => appServer.close(r));
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

let seq = 0;
async function account(credit = 50) {
  seq += 1;
  const email = `spend-${seq}-${process.pid}@example.test`;
  const { workspace } = await createAccount({ email, password: 'correct-horse-battery', name: `s${seq}` });
  if (credit > 0) await move(workspace.id, { kind: 'credit', amountUsd: credit, note: 'test' });
  return { ws: workspace, email };
}

// two hundred calls of one workload over a fortnight, as real traffic arrives; `cost` what each cost the customer
async function workloadWithCalls(ws, { cost = 0.002, n = 200 } = {}) {
  let workload = null;
  const tag = Math.random().toString(16).slice(2, 8);
  for (let i = 0; i < n; i += 1) {
    const request = {
      model: REF,
      messages: [
        { role: 'system', content: `Extract the totals from invoice batch ${tag}.` },
        { role: 'user', content: `document #${i}` },
      ],
      response_format: { type: 'json_object' },
    };
    workload = workload || await workloadFor(ws.id, request);
    await recordCall({
      workspaceId: ws.id, workloadId: workload.id, source: 'trace',
      requestedModel: REF, servedModel: REF, statusCode: 200, promptTokens: 800, completionTokens: 60, costUsd: cost, chargedUsd: cost,
      request, response: { choices: [{ message: { content: JSON.stringify({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }) } }] },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14) * 86400000 WHERE workload_id = ?').run(now() - DAY, workload.id);
  return db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
}
const heldFor = async (wsId) => Number((await db.prepare(
  'SELECT COALESCE(SUM(amount_usd), 0) AS s FROM balance_holds WHERE workspace_id = ? AND expires_at > ?').get(wsId, now())).s);

// a finished test of another workspace's, spent `ratio` times its raw estimate, as the correction reads them
async function pastTest(ratio, { outcome = 'compared', error = null, quote = 0.5 } = {}) {
  const { ws } = await account(0);
  const w = await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, optimize_mode, status,
      created_at, updated_at, calls_seen, state) VALUES (?, ?, ?, ?, 'json', ?, 'auto', 'certified', ?, ?, 0, 'live') RETURNING id`)
    .run(id('wl'), ws.id, `past-${Math.random().toString(16).slice(2, 8)}`, Math.random().toString(16), REF, now(), now());
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, created_at,
      started_at, finished_at, outcome, error, quote_usd, spend_usd) VALUES (?, ?, ?, 'done', 'json', ?, 100, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('run'), ws.id, w.rows[0].id, REF, now() - DAY, now() - DAY, now() - DAY + 60000, outcome, error, quote, quote * ratio);
}

/* 1. The quote -------------------------------------------------------------------------------------- */

test('a quote is corrected by how far recent tests ran over their estimates, and a test cut at its limit still counts', async () => {
  forgetQuoteCalibration();
  const fresh = await quoteCalibration();
  // too few tests yet: the defaults, "at most" never under half as much again as "about"
  assert.deepEqual([fresh.about, fresh.most], [config.QUOTE_ABOUT_DEFAULT, Math.max(config.QUOTE_MOST_DEFAULT, config.QUOTE_ABOUT_DEFAULT * 1.5)]);
  // ten that compared models and ran over by 1.0 to 1.45; one cut at its limit after the bar was set, which still
  // compared what it had, and one cut while the bar was being set, which compared nothing: both ran far over
  const ratios = [];
  for (let k = 0; k < 10; k += 1) { ratios.push(1 + k * 0.05); await pastTest(1 + k * 0.05); }
  ratios.push(2.6); await pastTest(2.6, { error: 'reached its limit of $1.21 while the fastest models were compared' });
  ratios.push(2.8); await pastTest(2.8, { outcome: 'capped', error: 'reached its limit of $1.31 while checking how much the model agrees with itself' });
  // ones that ran out of balance, or were stopped, say nothing about how far a test runs over: left out
  await pastTest(0.2, { outcome: 'no_balance' });
  await pastTest(0.1, { outcome: 'stopped' });
  forgetQuoteCalibration();
  const cal = await quoteCalibration();
  assert.equal(cal.tests, 12);
  // Postgres's PERCENTILE_CONT: the value at p of the way along the sorted list, between neighbours
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const at = p * (s.length - 1); const lo = Math.floor(at);
    return s[lo] + (at - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]); };
  near(cal.about, pct(ratios, 0.5), 'about: the median', 1e-9);
  near(cal.most, pct(ratios, 0.9), 'at most: the 90th percentile, which the two cut tests pull up', 1e-9);
  // left out, the cut ones would have made "at most" the smaller floor of half as much again as "about"
  const without = ratios.slice(0, 10);
  assert.ok(cal.most > Math.max(pct(without, 0.9), pct(without, 0.5) * config.QUOTE_MOST_OVER_ABOUT) + 0.5, `most ${cal.most}`);
  assert.ok(cal.most >= cal.about * config.QUOTE_MOST_OVER_ABOUT, 'never less than half as much again as about');
});

/* 2. The testing limit ------------------------------------------------------------------------------ */

test('every workspace has a testing limit until it chooses another, or none', async () => {
  assert.equal(config.TESTING_LIMIT_DEFAULT_USD, 20);
  assert.equal(testingLimitOf({ optimize_budget_usd: null, optimize_budget_none: 0 }), 20, 'nothing chosen: the default');
  assert.equal(testingLimitOf({ optimize_budget_usd: 7.5, optimize_budget_none: 0 }), 7.5);
  assert.equal(testingLimitOf({ optimize_budget_usd: null, optimize_budget_none: 1 }), null, 'chose no limit');
  const { ws, email } = await account(10);
  const room = await optimizeRoom(ws.id);
  assert.deepEqual([room.budget, room.left, room.isDefault], [20, 20, true]);
  // through Settings: no limit, back to the default, an amount
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/sign-in`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.121' }, body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const post = (body) => fetch(`http://127.0.0.1:${APP_PORT}/api/settings/optimize-budget`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const settings = async () => (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/settings`, { headers: { cookie } })).json()).testingLimit;
  assert.deepEqual(await settings(), { usd: 20, isDefault: true, none: false, defaultUsd: 20 });
  assert.equal((await post({ none: true })).status, 200);
  assert.deepEqual(await settings(), { usd: null, isDefault: false, none: true, defaultUsd: 20 });
  assert.equal(await optimizeRoom(ws.id), null, 'no limit at all');
  assert.equal((await post({ amountUsd: 7.5 })).status, 200);
  assert.deepEqual(await settings(), { usd: 7.5, isDefault: false, none: false, defaultUsd: 20 });
  assert.equal((await post({ amountUsd: null })).status, 200);
  assert.deepEqual(await settings(), { usd: 20, isDefault: true, none: false, defaultUsd: 20 });
  assert.equal((await post({ amountUsd: -1 })).status, 400);
});

test('the testing limit reached is said once in thirty days, on the activity and by email', async () => {
  const { ws } = await account(10);
  await db.prepare('UPDATE workspaces SET optimize_budget_usd = 1 WHERE id = ?').run(ws.id);
  assert.equal(await tellTestingLimit(ws.id), false, 'nothing spent yet: nothing to say');
  const w = await workloadWithCalls(ws, { n: 20 });
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, created_at, spend_usd)
    VALUES (?, ?, ?, 'done', 'json', ?, 10, ?, 1)`).run(id('run'), ws.id, w.id, REF, now());
  assert.equal(await tellTestingLimit(ws.id), true);
  assert.equal(await tellTestingLimit(ws.id), false, 'once');
  const said = await db.prepare(`SELECT title, detail FROM activity WHERE workspace_id = ? AND title LIKE 'Testing has reached%'`).all(ws.id);
  assert.equal(said.length, 1);
  assert.match(said[0].title, /testing limit of \$1\.00/);
  assert.match(said[0].detail, /Your own requests carry on as before\./);
  const mail = await db.prepare(`SELECT kind, subject FROM notifications WHERE workspace_id = ? AND kind = 'testing'`).all(ws.id);
  assert.equal(mail.length, 1, 'the email is queued once (none is sent without a mail key)');
});

/* 3. Money set aside ------------------------------------------------------------------------------- */

test("money a test sets aside is never held against the customer's own requests, and comes off as the test is charged", async () => {
  const { ws } = await account(6);
  const h = await hold(ws.id, 5, 'test');
  assert.equal(h.ok, true);
  near((await available(ws.id)).free, 1, 'another test sees only what is left');
  near((await available(ws.id, db, { forCalls: true })).free, 6, "a customer's request sees all of it");
  assert.equal((await gateRouting(ws.id)).ok, true, 'requests go through');
  assert.equal((await hold(ws.id, 3, 'call')).ok, true, 'a request may use what the test set aside');
  // a second test cannot count the same money, and never takes "what is left"
  const second = await hold(ws.id, 2, 'test');
  assert.equal(second.ok, false);
  // a charge comes off the balance and off what the test set aside, in one step
  await chargeEval(ws.id, 1 / FEE, 'test charge', { holdId: h.holdId });
  const left = await db.prepare('SELECT amount_usd, expires_at FROM balance_holds WHERE id = ?').get(h.holdId);
  near(Number(left.amount_usd), 4, 'five set aside, one charged');
  assert.ok(Number(left.expires_at) > now() + (config.TEST_HOLD_TTL_MIN - 1) * 60000, 'renewed at the charge');
});

test('a test whose process went away gives back what it set aside when it is closed, interrupted or stopped', async () => {
  const { ws } = await account(10);
  const w = await workloadWithCalls(ws, { n: 20 });
  // two runs nothing is running any more, each with money set aside: one closed by the hourly pass, one a person stops
  const abandoned = async () => {
    const h = await hold(ws.id, 3, 'test');
    assert.equal(h.ok, true);
    const runId = id('run');
    await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size,
        created_at, started_at, heartbeat_at, steps_total, steps_done, hold_id) VALUES (?, ?, ?, 'running', 'json', ?, 10, ?, ?, ?, 10, 2, ?)`)
      .run(runId, ws.id, w.id, REF, now() - DAY, now() - DAY, now() - DAY, h.holdId);
    return runId;
  };
  const first = await abandoned();
  near(await heldFor(ws.id), 3, 'set aside');
  assert.equal(await closeAbandoned(w.id), 1);
  assert.equal((await db.prepare('SELECT status FROM eval_runs WHERE id = ?').get(first)).status, 'failed');
  assert.equal(await heldFor(ws.id), 0, 'given back by the close');
  const second = await abandoned();
  const said = await stopMeasuring(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
  assert.equal(said.state, 'stopped');
  assert.equal((await db.prepare('SELECT status FROM eval_runs WHERE id = ?').get(second)).status, 'stopped');
  assert.equal(await heldFor(ws.id), 0, 'given back by the stop');
});

/* 4. The quote shown, and kept to ---------------------------------------------------------------------- */

test('a test is quoted before it runs, keeps to its most, and gives back what it set aside', async () => {
  forgetQuoteCalibration();
  const { ws } = await account(50);
  const w = await workloadWithCalls(ws);
  const plan = await planFor(w, { canRoute: true });
  assert.equal(plan.canRun, true, plan.reason);
  const cal = await quoteCalibration();
  near(plan.aboutUsd, plan.estimateUsd * cal.about * FEE, 'about: the estimate, corrected, with the fee', 1e-6);
  assert.ok(plan.atMostUsd >= plan.aboutUsd, 'at most is never below about');
  near(plan.atMostUsd, Math.min(plan.estimateUsd * cal.most, plan.ceilingUsd) * FEE, 'at most: corrected by the tail, with the fee', 1e-6);
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  near(Number(run.quote_about_usd), plan.aboutUsd, 'the quote shown is kept on the test', 0.02);
  assert.ok(Number(run.cap_usd) >= Number(run.quote_about_usd));
  assert.ok(withFee(Number(run.spend_usd)) <= Number(run.cap_usd) + 0.05, `spent ${withFee(Number(run.spend_usd))} of ${run.cap_usd}`);
  assert.equal(await heldFor(ws.id), 0, 'what it set aside is given back once it ends');
  // and the page shows the quote beside what it cost
  const pg0 = await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
  const row = pg0.measurements.find((m) => m.id === out.runId);
  near(row.quote, Number(run.quote_about_usd), 'the row carries its quote');
});

test('a test that reaches its most while the bar is set stops there, says so, and switches nothing', async () => {
  const saved = [config.QUOTE_MIN_TESTS, config.QUOTE_ABOUT_DEFAULT, config.QUOTE_MOST_DEFAULT];
  try {
    // quoted far too low on purpose, so its most comes while the customer's model is still being asked
    config.QUOTE_MIN_TESTS = 100000;
    config.QUOTE_ABOUT_DEFAULT = 0.02;
    config.QUOTE_MOST_DEFAULT = 0.03;
    forgetQuoteCalibration();
    const { ws } = await account(50);
    const w = await workloadWithCalls(ws);
    const out = await runEvaluation(w.id);
    assert.equal(out.capped, 'budget', JSON.stringify(out));
    const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
    assert.equal(run.outcome, 'capped');
    assert.match(run.error, /^reached its limit of \$\d+\.\d\d while checking how much/);
    // at most a few calls past it: the ones already on their way when it was reached
    assert.ok(withFee(Number(run.spend_usd)) <= Number(run.cap_usd) + 0.03, `spent ${withFee(Number(run.spend_usd))} of ${run.cap_usd}`);
    assert.equal(await heldFor(ws.id), 0);
    const after = await db.prepare('SELECT status, routed_model FROM workloads WHERE id = ?').get(w.id);
    assert.notEqual(after.status, 'measuring');
    assert.equal(after.routed_model, null, 'nothing switched');
    const said = await db.prepare(`SELECT title, detail FROM activity WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`).get(ws.id);
    assert.match(said.title, /stopped at its limit$/);
    const pg1 = await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
    assert.equal(pg1.measurements[0].tag.text, 'Reached its limit');
  } finally {
    [config.QUOTE_MIN_TESTS, config.QUOTE_ABOUT_DEFAULT, config.QUOTE_MOST_DEFAULT] = saved;
    forgetQuoteCalibration();
  }
});

test("a test stops rather than take the balance below zero when the customer's own requests used what it set aside", async () => {
  const savedCheck = config.TEST_BALANCE_CHECK_MS;
  config.TEST_BALANCE_CHECK_MS = 0;
  let release = null;
  try {
    const { ws } = await account(50);
    const w = await workloadWithCalls(ws);
    paused = new Promise((r) => { release = r; });
    const running = runEvaluation(w.id);
    // once it is under way, the customer's own requests spend nearly all of the balance
    for (let k = 0; k < 200; k += 1) {
      if (await db.prepare(`SELECT 1 FROM eval_runs WHERE workload_id = ? AND status = 'running'`).get(w.id)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const bal = Number((await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?').get(ws.id)).balance_usd);
    await move(ws.id, { kind: 'call', amountUsd: -(bal - 0.01), note: 'live requests' });
    paused = null;
    release();
    const out = await running;
    const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
    assert.equal(run.status, 'done');
    assert.ok(run.outcome === 'no_balance' || /balance ran out/.test(run.error || ''), `ended ${run.outcome}: ${run.error}`);
    // stopped within the calls already on their way: never more than a few cents below zero
    const after = Number((await db.prepare('SELECT balance_usd FROM billing_accounts WHERE workspace_id = ?').get(ws.id)).balance_usd);
    assert.ok(after > -0.05, `the balance ended at ${after}`);
    assert.equal(await heldFor(ws.id), 0);
  } finally {
    config.TEST_BALANCE_CHECK_MS = savedCheck;
    if (release) release();
    paused = null;
  }
});

/* 5. Saying why a test did not run ------------------------------------------------------------------ */

test('a test nobody asked for that the testing limit holds back says so on its page, and once a day on the activity', async () => {
  forgetQuoteCalibration();
  const savedPayback = config.EVAL_PAYBACK_MONTHS;
  try {
    // a test counted worth it however slowly it pays back, so only the limit stands in the way
    config.EVAL_PAYBACK_MONTHS = 1000;
    const { ws } = await account(50);
    const w = await workloadWithCalls(ws);
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = 0.01 WHERE id = ?').run(ws.id);
    const out = await runEvaluation(w.id, { trigger: 'automatic' });
    assert.equal(out.ok, false);
    assert.match(out.reason, /testing limit for the last thirty days/);
    const row = await db.prepare('SELECT test_skip_json FROM workloads WHERE id = ?').get(w.id);
    const skip = JSON.parse(row.test_skip_json);
    assert.deepEqual([skip.reason, skip.short], ['limit', 'paused at your testing limit']);
    const pg2 = await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
    assert.equal(pg2.skip.short, 'paused at your testing limit', 'the page says why instead of a date');
    // looked at again the same day: the page keeps saying so, the activity says it once
    await runEvaluation(w.id, { trigger: 'automatic' });
    const said = await db.prepare(`SELECT COUNT(*)::int AS n FROM activity WHERE workspace_id = ? AND title LIKE 'A test of % did not run by itself'`).get(ws.id);
    assert.equal(said.n, 1);
    assert.ok(JSON.parse((await db.prepare('SELECT test_skip_json FROM workloads WHERE id = ?').get(w.id)).test_skip_json).short);
    // a test that runs clears it
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = NULL WHERE id = ?').run(ws.id);
    const ran = await runEvaluation(w.id);
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.equal((await db.prepare('SELECT test_skip_json FROM workloads WHERE id = ?').get(w.id)).test_skip_json, null);
    assert.equal((await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id))).skip, null);
  } finally {
    config.EVAL_PAYBACK_MONTHS = savedPayback;
  }
});

test('a test nobody asked for that the balance cannot cover says so on its page, and runs once credit is added', async () => {
  forgetQuoteCalibration();
  const savedPayback = config.EVAL_PAYBACK_MONTHS;
  try {
    config.EVAL_PAYBACK_MONTHS = 1000;
    // not enough balance for the test's most: a test nobody asked for waits and says why
    const { ws } = await account(0.05);
    const w = await workloadWithCalls(ws);
    const out = await runEvaluation(w.id, { trigger: 'automatic' });
    assert.equal(out.ok, false, JSON.stringify(out));
    const skip = JSON.parse((await db.prepare('SELECT test_skip_json FROM workloads WHERE id = ?').get(w.id)).test_skip_json);
    assert.deepEqual([skip.reason, skip.short], ['balance', 'paused until credit is added']);
    // credit added: the next look runs, and the note goes
    await move(ws.id, { kind: 'credit', amountUsd: 50, note: 'test' });
    const ran = await runEvaluation(w.id, { trigger: 'automatic' });
    assert.equal(ran.ok, true, JSON.stringify(ran));
    assert.equal((await db.prepare('SELECT test_skip_json FROM workloads WHERE id = ?').get(w.id)).test_skip_json, null);
  } finally {
    config.EVAL_PAYBACK_MONTHS = savedPayback;
  }
});
