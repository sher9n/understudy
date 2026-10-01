/* Getting stuck workloads moving again (the owner's go-ahead of 1 Oct 2026, B1 to B3), end to end on a real database,
   through real tests against a provider we control, and the real app for what a person does in Settings.

   What is checked:
   - B1: what passed once and was never looked at twice is tested again the moment enough new calls arrive, however the
     test ended: after the first three in line were found wanting and the one behind them was never reached, as well as
     after a second look short of calls. A workload a test left owing one before this (every test before 30 Sep 2026) is
     found when a server starts and by the hourly pass, and starts at once when its new calls are already in; its booking
     a rhythm out is never moved later. Never one that passed both looks, one switched, one a person stopped since, one
     whose look was turned down since, one in the queue, or one in a workspace that tests only when asked.
   - B2: a test that came close on fewer calls than a test can take waits for the calls a test on twice as many needs, and
     the call that brings them starts it; never one on the full sample, and never one found clearly worse.
   - B3: choosing another rhythm in Settings books every tested workload again from its last test, keeping the doubling
     after re-checks that changed nothing; a shorter one never books later, a longer one never sooner (a retry after a
     failure keeps its time), "Only when I ask" changes nothing, and choosing a rhythm again books every one afresh.
   - the words: a model the second looks never came to is said to be not reached for the reason it was. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PROVIDER_PORT = 4951;
const APP_PORT = 4952;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_unstick_${process.pid}`;
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
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PROVIDER_PORT}/api/v1`;
process.env.MODEL_MIN_GAP_MS = '0';
process.env.EVAL_MIN_RUNS = '100';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
process.env.SPEED_SLACK_MS = '5000';
process.env.REQUEST_LOGS = 'false';
process.env.EVAL_JUDGE_MODEL = 'judge/small';
process.env.ROLLOUT_ENABLED = 'false';
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.MEASURE_READY_CHECK_MS = '0';
process.env.CONTROL_ENABLED = 'false';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.SECURE_COOKIES = 'false';
/* the tests nobody asked for here are on a few hundred calls, whose saving could never pay for a test within the usual two
   months: what is under test is when they start, not whether one would pay */
process.env.EVAL_PAYBACK_MONTHS = '600';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const auth = await import('../src/auth.js');
const { move } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { runEvaluation, stopMeasuring } = await import('../src/eval/run.js');
const { pendingSecondLook, waitOf, dueForRecheck } = await import('../src/eval/schedule.js');
const { unseenCalls, usableCalls } = await import('../src/eval/plan.js');
const { startWaiting, convertWaits, waitToLookAgain } = await import('../src/proxy.js');
const { enqueue, runOnce } = await import('../src/jobs.js');
const { runAnswersOf, runPageOf } = await import('../src/workloadPage.js');
const { promote, revert } = await import('../src/eval/promote.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
// right on every request of a test's first look, wrong on every one after: found wanting on a second look, cheapest first
const LUCKIES = ['vendor/lucky-a', 'vendor/lucky-b', 'vendor/lucky-c'];
// answers every request the way the customer's model does, dearer than the lucky three: behind them in line
const STEADY = 'vendor/steady-small';
// wrong on one answer in forty: close to a 3% bar, straddling it on a hundred calls or on a hundred and twenty
const CLOSE = 'vendor/close-small';
// answers every request wrongly
const DRIFTY = 'vendor/drifty-small';
const JUDGE = 'judge/small';
const MODELS = [...LUCKIES, STEADY, CLOSE, DRIFTY];
const PRICE_IN = { [LUCKIES[0]]: 0.05e-6, [LUCKIES[1]]: 0.06e-6, [LUCKIES[2]]: 0.07e-6, [CLOSE]: 0.08e-6 };
const DAY = 86400000;
const HOUR = 3600000;

const right = (i) => ({ total: 100 + i, currency: 'EUR', lines: (i % 5) + 1 });
const wrong = (i) => ({ total: 999 + i, currency: 'USD', lines: 0 });
const indexOf = (text) => Number((String(text).match(/#(\d+)/) || [])[1] || 0);
const answered = new Map();
const got = (m) => answered.get(m) || 0;
// the test the lucky three are lucky in, and how many each had answered when it began
let lucky = null;
// how many the close one had answered when the test began
let closeBase = 0;
// a person's approval landing while a test runs: at the close one's `at`th answer, the workload is switched
let midRun = null;
const firstLookSize = async (wid) => Number((await db.prepare(`SELECT sample_size FROM eval_runs WHERE workload_id = ? AND status = 'running'
    ORDER BY created_at DESC LIMIT 1`).get(wid))?.sample_size ?? Infinity);
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = JSON.parse(body || '{}');
    const m = p.model;
    const user = String(p.messages?.find((x) => x.role === 'user')?.content ?? '');
    const send = (content, cost) => {
      answered.set(m, got(m) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model: m,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost } }));
    };
    if (m === JUDGE) return send('SAME', 0.00001);
    const i = indexOf(user);
    const cost = m === REF ? 0.002 : 0.0002;
    if (m === DRIFTY) return send(JSON.stringify(wrong(i)), cost);
    if (m === CLOSE) {
      const k = got(m) - closeBase;
      if (midRun && k === midRun.at) {
        await db.prepare(`UPDATE workloads SET routed_model = ?, promoted_at = ? WHERE id = ?`).run(midRun.model, now(), midRun.wid);
        midRun = null;
      }
      return send(JSON.stringify(k % 40 === 0 ? wrong(i) : right(i)), cost);
    }
    if (LUCKIES.includes(m) && lucky && got(m) - (lucky.base.get(m) || 0) >= await firstLookSize(lucky.wid)) {
      return send(JSON.stringify(wrong(i)), cost);
    }
    return send(JSON.stringify(right(i)), cost);
  });
});

let server;
const base = `http://127.0.0.1:${APP_PORT}`;
test.before(async () => {
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    ...MODELS.map((m) => ({ model_id: m, name: m.split('/')[1], context_len: 128000, price_in: PRICE_IN[m] ?? 0.1e-6, price_out: 0.3e-6, open_weights: 0, zdr: 1 })),
    { model_id: JUDGE, name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
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

const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);
const resultOf = (runId, model) => db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(runId, model);
const lastActivity = (wid) => db.prepare('SELECT title, detail FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(wid);
const queued = async (wid) => (await db.prepare(`SELECT payload FROM jobs WHERE kind = 'eval_run' AND status = 'queued'
    AND (payload::jsonb ->> 'workloadId') = ? ORDER BY created_at`).all(wid)).map((j) => JSON.parse(j.payload).trigger);
const cancelFor = (wid) => db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE kind = 'eval_run' AND status IN ('queued', 'claimed')
    AND (payload::jsonb ->> 'workloadId') = ?`).run(wid);

// what each workload asks, one per kind of work, so the workloads of one workspace are never read as the same one
const ASKS = {
  invoice: (seq) => `Read the invoice and give its total, currency and line count as JSON, set ${seq}.`,
  ticket: (seq) => `Decide how urgent this customer support ticket is and which team should own it; answer in JSON, batch ${seq}.`,
  meeting: (seq) => `Summarise these meeting notes into decisions, owners and deadlines, returned as a JSON object for run ${seq}.`,
  address: (seq) => `Pull the shipping address, postcode and recipient name out of this order email as JSON (${seq}).`,
  review: (seq) => `Tag this product review with sentiment, product area and any safety concern, as JSON, series ${seq}.`,
};
const requestOf = (i, seq, topic = 'invoice') => ({ model: REF, messages: [
  { role: 'system', content: ASKS[topic](seq) },
  { role: 'user', content: `Invoice #${String(i).padStart(4, '0')}` }], response_format: { type: 'json_object' } });
const record = async (workspaceId, workloadId, i, seq, topic = 'invoice') => {
  await recordCall({
    workspaceId, workloadId, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
    promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0, request: requestOf(i, seq, topic),
    response: { choices: [{ message: { content: JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
  });
};

/* A workspace with one workload of `n` recorded calls, trying only `models` (every other one switched off), which switches
   by itself ('auto') or asks first ('ask'). Signed in through the app, so what a person does is done as they do it. */
let seq = 0;
async function seeded({ n, models, mode = 'auto', password = 'correct-horse-battery' }) {
  seq += 1;
  const email = `unstick-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password, name: `u${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ?, onboarded_at = ? WHERE id = ?').run(mode, now(), workspace.id);
  const wl = await workloadFor(workspace.id, requestOf(0, seq));
  for (let i = 0; i < n; i += 1) await record(workspace.id, wl.id, i, seq);
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?').run(now() - DAY, wl.id);
  await db.prepare(`UPDATE workloads SET state = 'live' WHERE id = ?`).run(wl.id);
  await enable(workspace.id, models);
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${100 + seq}` },
    body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200, `signed in: ${await r.clone().text()}`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const api = {
    get: async (path) => (await fetch(`${base}/api${path}`, { headers: { cookie } })).json(),
    post: async (path, body) => {
      const x = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      return { status: x.status, body: await x.json().catch(() => null) };
    },
  };
  return { workspace, workload: await load(wl.id), api, seq };
}
async function enable(workspaceId, models) {
  for (const m of [...MODELS, JUDGE]) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspaceId, m, models.includes(m) ? 1 : 0, now());
  }
}
// a test the lucky three are lucky in: right on its first look, wrong on everything after
async function luckyTest(wid, opts) {
  lucky = { wid, base: new Map(LUCKIES.map((m) => [m, got(m)])) };
  try {
    return await runEvaluation(wid, opts);
  } finally {
    lucky = null;
  }
}
// a test the close one is close in: wrong on its first answer in it, and on every fortieth after
async function closeTest(wid, opts) {
  closeBase = got(CLOSE);
  return runEvaluation(wid, opts);
}

/* A test as the database keeps it, written directly, for a workload in a state no test run here reaches quickly: which
   models it tried and how each look ended. `results` are [model, verdict, second look, cost a month, setup, calls its
   second look read] ('reference' for the customer's own model; setup, for a strategy, is its arm). `drew` is how many of
   the workload's calls it drew; `trigger` and `plan` what started it and its plan (a second look's secondLookOf). */
let fakes = 0;
async function fakeTest(x, { results, sample = 120, floor = 3, at = now() - HOUR, status = 'done', outcome = 'compared', error = null, choice, drew = 0,
  trigger = 'manual', plan = null }) {
  fakes += 1;
  const id = `run_fake_${fakes}_${process.pid}`;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, sample_size, floor_pct,
      created_at, finished_at, error, choice_json, trigger, plan_json) VALUES (?, ?, ?, ?, ?, 'json', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, x.workspace.id, x.workload.id, status, outcome, REF, sample, floor, at, status === 'running' ? null : at + 60000, error,
      choice === undefined ? null : JSON.stringify(choice), trigger, plan ? JSON.stringify(plan) : null);
  for (const [model, verdict, second, cost, arm, looked] of results) {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, confirm_verdict, created_at, arm_json,
        confirm_runs) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(`res_${id}_${model}`, id, model, sample, cost, verdict, second, at, arm ? JSON.stringify(arm) : null, looked ?? null);
  }
  if (drew > 0) {
    const calls = await db.prepare('SELECT id FROM calls WHERE workload_id = ? ORDER BY created_at LIMIT ?').all(x.workload.id, drew);
    for (const c of calls) await db.prepare('INSERT INTO eval_samples (id, run_id, call_id) VALUES (?, ?, ?)').run(`smp_${id}_${c.id}`, id, c.id);
  }
  return id;
}
const owed = [[REF, 'reference', null, 10], [STEADY, 'cleared', 'not_reached', 1]];

test('B1: after the first three in line were found wanting, the one never reached is tested again the moment enough new calls arrive', async () => {
  const { workspace, workload: w, api, seq: set } = await seeded({ n: 300, models: [...LUCKIES, STEADY] });
  const out = await luckyTest(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  for (const m of LUCKIES) {
    const r = await resultOf(out.runId, m);
    assert.equal(r.verdict, 'cleared', `${m} passed its first look: ${r.verdict}, ${r.gap_pct}% on ${r.runs}`);
    assert.equal(r.confirm_verdict, 'missed', `and was found wanting on its second: ${r.confirm_verdict}`);
  }
  const steady = await resultOf(out.runId, STEADY);
  assert.equal(steady.verdict, 'cleared');
  assert.equal(steady.confirm_verdict, 'not_reached', 'the three looks a test takes were spent on the lucky three');
  const after = await load(w.id);
  assert.equal(after.routed_model, null, 'nothing switched on one look');
  assert.equal(after.status_note, 'A candidate cleared once and needs a second look');
  // said as what happens next, and no longer "the next measurement looks again", a month out
  const said = await lastActivity(w.id);
  assert.match(said.detail, /passed once too and was not tested again, so it is tested again on new requests as soon as enough of them arrive\./);
  assert.doesNotMatch(said.detail, /The next measurement looks again/);

  // owed its second look, and booked for the 88 calls no test has drawn that a look at a 3% bar needs
  const pending = await pendingSecondLook(w.id);
  assert.deepEqual(pending?.keys, [STEADY]);
  assert.equal(Number(after.measure_at_calls), 88, `waits for ${after.measure_at_calls}`);
  const wait = await waitOf(after);
  assert.equal(wait.secondLook, true);
  assert.equal(wait.have, await unseenCalls(after), 'counted as calls no test has drawn');
  const page = await api.get(`/workloads/${w.id}`);
  assert.equal(page.measure?.waitingFor?.secondLook, true, JSON.stringify(page.measure?.waitingFor));
  assert.equal(page.measure.waitingFor.calls, 88);

  // the model's own page says why it had no second look: a test looks again at the first three in line only
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  const view = await runAnswersOf(after, run, STEADY);
  assert.equal(view.looks.notReached, 'tries');
  assert.equal(view.looks.ended, "it wasn't reached, because each test gives a second look to only the first 3 models in line");
  assert.doesNotMatch(view.looks.ended, /another model passed first/, 'nothing passed in this test');

  // one call short starts nothing; the call that brings them starts a second look, not a whole test
  let i = 300;
  while ((await unseenCalls(await load(w.id))) < 87) await record(workspace.id, w.id, i++, set);
  await startWaiting();
  assert.deepEqual(await queued(w.id), [], 'one call short: nothing starts');
  await record(workspace.id, w.id, i++, set);
  assert.ok((await startWaiting()) >= 1);
  assert.deepEqual(await queued(w.id), ['second_look']);
  await cancelFor(w.id);
  // which races the one it waited for alone, and switches to it when it passes on the new calls
  const look = await luckyTest(w.id, { trigger: 'second_look' });
  assert.equal(look.ok, true, JSON.stringify(look));
  const tried = (await db.prepare(`SELECT model_id FROM eval_results WHERE run_id = ? AND verdict <> 'reference'`).all(look.runId)).map((r) => r.model_id);
  assert.deepEqual(tried, [STEADY], `only the one owed a look: ${tried.join(', ')}`);
  const again = await resultOf(look.runId, STEADY);
  assert.equal(again.confirm_verdict, 'cleared', `${again.confirm_verdict} on ${again.confirm_runs}`);
  assert.equal((await load(w.id)).routed_model, STEADY, 'and it switches by itself, as this workload does');
  assert.equal(await pendingSecondLook(w.id), null, 'nothing waits any more');
});

test('B1: a workload a test left owing a second look before this is found when a server starts and by the hourly pass', async () => {
  const x = await seeded({ n: 300, models: [...LUCKIES, STEADY] });
  const { workspace, workload: w, seq: set } = x;
  assert.equal((await luckyTest(w.id)).ok, true);
  /* as every test before 30 Sep 2026 left it: owing the look, waiting for nothing, and booked for its next test in the
     rhythm, here 25 days out (sooner than the 30 a new wait would book) */
  const booked = now() + 25 * DAY;
  await db.prepare('UPDATE workloads SET measure_at_calls = NULL, recheck_after = ? WHERE id = ?').run(booked, w.id);
  assert.ok(await pendingSecondLook(w.id), 'it owes the look');
  assert.ok((await waitToLookAgain()) >= 1);
  let now1 = await load(w.id);
  assert.equal(Number(now1.measure_at_calls), 88, 'set waiting for the calls its look needs');
  assert.equal(Number(now1.recheck_after), booked, 'and its booking, sooner than a new wait would make it, is kept');
  assert.equal(await waitToLookAgain(), 0, 'running it again sets nothing more');
  assert.equal(Number((await load(w.id)).measure_at_calls), 88);
  assert.equal(Number((await load(w.id)).recheck_after), booked, 'nor moves its booking');
  // a booking backed off further than a rhythm, after re-checks that changed nothing, is kept too: never pulled in
  const backedOff = now() + 120 * DAY;
  await db.prepare('UPDATE workloads SET measure_at_calls = NULL, recheck_after = ? WHERE id = ?').run(backedOff, w.id);
  await waitToLookAgain();
  assert.equal(Number((await load(w.id)).recheck_after), backedOff, 'the backoff kept as the fallback');

  // with its new calls already in, the pass a server starts with sets it waiting and starts it at once
  let i = 300;
  while ((await unseenCalls(await load(w.id))) < 100) await record(workspace.id, w.id, i++, set);
  await db.prepare('UPDATE workloads SET measure_at_calls = NULL, recheck_after = ? WHERE id = ?').run(booked, w.id);
  const boot = await convertWaits();
  assert.ok(boot.waiting >= 1 && boot.started >= 1, JSON.stringify(boot));
  assert.deepEqual(await queued(w.id), ['second_look'], 'a second look, queued as the server starts');
  await cancelFor(w.id);

  // and the hourly pass does the same
  await db.prepare('UPDATE workloads SET measure_at_calls = NULL, recheck_after = ? WHERE id = ?').run(booked, w.id);
  await enqueue('recheck', {}, { runAfter: now() - 1000 });
  assert.equal(await runOnce({ skipKinds: ['eval_run'] }), true, 'the hourly pass ran');
  assert.deepEqual(await queued(w.id), ['second_look'], 'a second look, queued by the hourly pass');
  await cancelFor(w.id);
  now1 = await load(w.id);
  assert.equal(now1.measure_at_calls, null, 'what it waited for has come');
});

test('B1 negatives: nothing is set waiting for a look nobody owes, or that its workload has had answered another way', async () => {
  const made = [];
  for (let k = 0; k < 8; k += 1) made.push(await seeded({ n: 120, models: [STEADY] }));
  const [owes, passed, switched, stopped, skipped, inQueue, askOnly, wanting] = made;
  for (const x of made) await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`)
    .run(now() + 20 * DAY, x.workload.id);
  await fakeTest(owes, { results: owed });
  // one whose second look passed: it is offered, or was switched to, and nothing is owed
  await fakeTest(passed, { results: [[REF, 'reference', null, 10], [STEADY, 'cleared', 'cleared', 1], [CLOSE, 'cleared', 'not_reached', 0.5]] });
  // switched since
  await fakeTest(switched, { results: owed });
  await db.prepare(`UPDATE workloads SET routed_model = ?, status = 'promoted' WHERE id = ?`).run(STEADY, switched.workload.id);
  // a person stopped a test of it since: their word stands
  await fakeTest(stopped, { results: owed, at: now() - 2 * HOUR });
  await fakeTest(stopped, { results: [], status: 'stopped', outcome: 'stopped', at: now() - HOUR });
  // its second look was turned down since (the model it waited for switched off): the calls would only start it again
  await fakeTest(skipped, { results: owed });
  await db.prepare('UPDATE workloads SET test_skip_json = ? WHERE id = ?')
    .run(JSON.stringify({ reason: 'other', short: null, text: 'Nothing you have switched on could be measured.', at: now() }), skipped.workload.id);
  // one already waiting in the queue
  await fakeTest(inQueue, { results: owed });
  await enqueue('eval_run', { workloadId: inQueue.workload.id, trigger: 'automatic' }, { unique: true });
  // a workspace that tests only when asked
  await fakeTest(askOnly, { results: owed });
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(askOnly.workspace.id);
  // one whose second look found it wanting on the full sample: owed nothing, and no closer look to wait for
  await fakeTest(wanting, { results: [[REF, 'reference', null, 10], [STEADY, 'cleared', 'review', 1]] });

  await waitToLookAgain();
  assert.equal(Number((await load(owes.workload.id)).measure_at_calls), 88, 'the one that owes a look waits for its calls');
  for (const [x, why] of [[passed, 'one passed both looks'], [switched, 'switched'], [stopped, 'a person stopped a test since'],
    [skipped, 'turned down since'], [inQueue, 'waiting in the queue'], [askOnly, 'tests only when asked'], [wanting, 'found wanting']]) {
    assert.equal((await load(x.workload.id)).measure_at_calls, null, `nothing waits: ${why}`);
  }
  assert.equal(await pendingSecondLook(passed.workload.id), null, 'nothing is owed once one passed both looks');
  await cancelFor(inQueue.workload.id);
  // left waiting for nothing, so what later tests start is only their own
  await db.prepare('UPDATE workloads SET measure_at_calls = NULL WHERE id = ?').run(owes.workload.id);
});

test('B1 negatives: a person\'s stop of a queued second look holds, and a switch back leaves nothing owed', async () => {
  // a look owed, its calls in: set waiting and queued, as the catch-up pass does
  const x = await seeded({ n: 150, models: [STEADY] });
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 20 * DAY, x.workload.id);
  await fakeTest(x, { results: owed });
  await waitToLookAgain();
  await startWaiting();
  assert.deepEqual(await queued(x.workload.id), ['second_look']);
  // a person presses Stop before it starts: it leaves no run, and the next passes must not queue it again
  const stop = await stopMeasuring(await load(x.workload.id));
  assert.equal(stop.state, 'cancelled', JSON.stringify(stop));
  assert.equal(JSON.parse((await load(x.workload.id)).test_skip_json).reason, 'stopped', 'the stop is noted on the workload');
  await waitToLookAgain();
  await startWaiting();
  assert.deepEqual(await queued(x.workload.id), [], 'the stop holds');
  assert.equal((await load(x.workload.id)).measure_at_calls, null);
  /* and when the look was already waiting for its calls, with a whole test queued by its booking in the meantime: the
     stop answers the wait as well, so the call that brings the count starts nothing */
  await db.prepare('UPDATE workloads SET measure_at_calls = 200, test_skip_json = NULL WHERE id = ?').run(x.workload.id);
  await enqueue('eval_run', { workloadId: x.workload.id, trigger: 'automatic' }, { unique: true });
  assert.equal((await stopMeasuring(await load(x.workload.id))).state, 'cancelled');
  assert.equal((await load(x.workload.id)).measure_at_calls, null, 'what it waited for is answered by the stop');
  for (let i = 150; i < 360; i += 1) await record(x.workspace.id, x.workload.id, i, x.seq);
  await startWaiting();
  assert.deepEqual(await queued(x.workload.id), [], 'the calls start nothing after a stop');

  /* a test taken while a cheaper model served and held up: the looks stop at what serves, so the one behind it was never
     reached for want of a look; switched back afterwards by the live watch, nothing is owed from that test */
  const y = await seeded({ n: 150, models: [STEADY, CLOSE] });
  await fakeTest(y, { results: [[REF, 'reference', null, 10], [STEADY, 'cleared', null, 1], [CLOSE, 'cleared', 'not_reached', 0.8]],
    choice: { holding: STEADY, servingKept: STEADY, chosen: STEADY } });
  await db.prepare(`UPDATE workloads SET status = 'certified', routed_model = NULL, measure_at_calls = NULL, recheck_after = ? WHERE id = ?`)
    .run(now() + 20 * DAY, y.workload.id);
  assert.equal(await pendingSecondLook(y.workload.id), null, 'nothing owed from a test run while a model served');
  // nor a row with nothing written: the setup serving is never looked at twice, and keeps none
  const z = await seeded({ n: 150, models: [STEADY] });
  await fakeTest(z, { results: [[REF, 'reference', null, 10], [STEADY, 'cleared', null, 1]] });
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 20 * DAY, z.workload.id);
  assert.equal(await pendingSecondLook(z.workload.id), null);
  await waitToLookAgain();
  for (const q of [y, z]) assert.equal((await load(q.workload.id)).measure_at_calls, null, 'nothing waits');
});

test('B1: a second look races what it waited for, and never looks twice at a model already found wanting', async () => {
  /* a measurement whose only one still owed is a setup built on a model (a cascade over the steady one), and whose second
     look found that model wanting on its own: the look races the model again to build the setup, and must never look at
     it twice, offer it, or switch to it */
  const x = await seeded({ n: 300, models: [STEADY] });
  const cascade = { kind: 'cascade', first: { model: STEADY, recipe: null }, fallback: { model: REF, recipe: null } };
  const key = `cascade:${STEADY}`;
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 20 * DAY, x.workload.id);
  const was = await fakeTest(x, { drew: 120, results: [[REF, 'reference', null, 10], [STEADY, 'cleared', 'review', 1], [key, 'cleared', 'not_reached', 0.9, cascade]] });
  const pending = await pendingSecondLook(x.workload.id);
  assert.deepEqual(pending?.keys, [key], 'the setup is owed its look');
  assert.deepEqual([...pending.models], [STEADY], 'raced through the model it is built on');
  const look = await runEvaluation(x.workload.id, { trigger: 'second_look' });
  assert.equal(look.ok, true, JSON.stringify(look));
  const plain = await resultOf(look.runId, STEADY);
  assert.equal(plain.verdict, 'cleared', 'the model passes its first look again');
  assert.equal(plain.confirm_verdict, 'review', `and keeps the second look that found it wanting (${was}): ${plain.confirm_verdict}`);
  assert.ok(!(Number(plain.confirm_runs) > 0), `with no second look of its own: ${plain.confirm_runs}`);
  // (no setup is built here, since Jev is off in these tests: what could switch is the model alone)
  assert.equal((await load(x.workload.id)).routed_model, null, 'never switched to');
  const results = await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(look.runId);
  assert.ok(!(await import('../src/eval/outcome.js')).cheaperCleared(results).some((r) => r.model_id === STEADY), 'nor offered');
  // and its row in this test says the earlier test found it wanting, with no second-look figures it does not have
  const story = await runPageOf(await load(x.workload.id), await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(look.runId));
  const row = story.cands.find((c) => c.key === STEADY);
  assert.match(row.why, /didn't hold up when an earlier test looked at it again on new requests/, row.why);

  // and one never found wanting, raced only to build the setup the look waited for, takes none of its looks
  const y = await seeded({ n: 300, models: [STEADY] });
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 20 * DAY, y.workload.id);
  await fakeTest(y, { drew: 120, results: [[REF, 'reference', null, 10], [key, 'cleared', 'not_reached', 0.9, cascade]] });
  const look2 = await runEvaluation(y.workload.id, { trigger: 'second_look' });
  assert.equal(look2.ok, true, JSON.stringify(look2));
  const part = await resultOf(look2.runId, STEADY);
  assert.equal(part.verdict, 'cleared');
  assert.ok(!(Number(part.confirm_runs) > 0), `no second look of its own in a look for another setup: ${part.confirm_verdict} on ${part.confirm_runs}`);
  assert.equal((await load(y.workload.id)).routed_model, null, 'and nothing switched on it');
  // said as that, never as a test that reached its limit, which this one did not
  const said = await lastActivity(y.workload.id);
  assert.doesNotMatch(said.detail, /reached its limit/, said.detail);
  assert.match(said.detail, /has not yet been looked at again on calls it had never seen/, said.detail);
  const answers = await runAnswersOf(await load(y.workload.id), await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(look2.runId), STEADY);
  assert.equal(answers.looks.notReached, 'part', 'its model page says it was tested only as part of the setup');
});

test('B2: a test that came close on fewer calls than a test can take waits for the calls a test on twice as many needs', async () => {
  const { workspace, workload: w, api, seq: set } = await seeded({ n: 200, models: [CLOSE] });
  const out = await closeTest(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const r = await resultOf(out.runId, CLOSE);
  assert.equal(r.runs, 100, 'a sample of half the 200 calls');
  assert.equal(r.verdict, 'review', `three wrong in a hundred straddles a 3% bar: ${r.verdict}, ${r.gap_pct}%`);
  let now1 = await load(w.id);
  assert.equal(now1.status_note, 'A candidate is close and needs a look');
  // 240 calls give a test of 120, the most one takes, rather than waiting out the rhythm
  assert.equal(Number(now1.measure_at_calls), 240, `waits for ${now1.measure_at_calls}`);
  const days = (Number(now1.recheck_after) - now()) / DAY;
  assert.ok(days > 29 && days < 31, `the rhythm kept as the fallback: ${days} days`);
  const said = await lastActivity(w.id);
  assert.match(said.detail, /It is tested again by itself on 120 requests once enough new ones arrive\./, said.detail);
  const wait = await waitOf(now1);
  assert.deepEqual(wait, { need: 240, have: await usableCalls(now1), secondLook: false }, 'counted as calls a test can use');
  const page = await api.get(`/workloads/${w.id}`);
  assert.deepEqual(page.measure?.waitingFor, { calls: 240, have: 200, secondLook: false });

  // the call that brings them starts a test of its own
  let i = 200;
  while ((await usableCalls(await load(w.id))) < 239) await record(workspace.id, w.id, i++, set);
  await startWaiting();
  assert.deepEqual(await queued(w.id), [], 'one call short: nothing starts');
  await record(workspace.id, w.id, i++, set);
  assert.ok((await startWaiting()) >= 1);
  assert.deepEqual(await queued(w.id), ['automatic']);
  await cancelFor(w.id);
  // which, run, reads it on 120 and, the most a test takes, waits for nothing more
  const next = await closeTest(w.id, { trigger: 'automatic' });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal((await resultOf(next.runId, CLOSE)).runs, 120);
  now1 = await load(w.id);
  assert.equal(now1.measure_at_calls, null, 'on the full sample there is nothing closer to wait for');
});

test('B2: waiting for a closer test keeps the backoff after re-checks that changed nothing', async () => {
  // a test nobody asked for that finds what the last one did, its second in a row: the next is four rhythms out
  const { workload: w } = await seeded({ n: 200, models: [CLOSE] });
  await db.prepare('UPDATE workloads SET recheck_streak = 1 WHERE id = ?').run(w.id);
  const out = await closeTest(w.id, { trigger: 'automatic' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await resultOf(out.runId, CLOSE)).verdict, 'review');
  const after = await load(w.id);
  assert.equal(Number(after.recheck_streak), 2);
  assert.equal(Number(after.measure_at_calls), 240, 'waits for the calls a closer test needs');
  const days = (Number(after.recheck_after) - now()) / DAY;
  assert.ok(days > 119 && days < 121, `with the backoff kept as the fallback, 120 days out: ${days}`);
});

test('B2 negatives: nothing waits after a test during which a person switched the workload', async () => {
  const { workload: w } = await seeded({ n: 200, models: [CLOSE] });
  midRun = { at: 50, wid: w.id, model: STEADY };
  const out = await closeTest(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await resultOf(out.runId, CLOSE)).verdict, 'review', 'it came close, as the one before did');
  const after = await load(w.id);
  assert.equal(after.routed_model, STEADY, 'switched while it ran');
  assert.equal(after.measure_at_calls, null, 'so it waits for no closer test on the model it no longer runs on');
});

test('B1: a second look that cannot run leaves the workload\'s next test where it was booked', async () => {
  const x = await seeded({ n: 150, models: [STEADY] });
  const booked = now() + 25 * DAY;
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(booked, x.workload.id);
  await fakeTest(x, { results: owed });
  await waitToLookAgain();
  await startWaiting();
  assert.deepEqual(await queued(x.workload.id), ['second_look']);
  assert.equal(Number((await load(x.workload.id)).recheck_after), booked, 'the call that starts it no longer brings the booking in');
  await cancelFor(x.workload.id);
  // the one it waited for switched off before it ran: it cannot run, and the booking stays
  await enable(x.workspace.id, []);
  const look = await runEvaluation(x.workload.id, { trigger: 'second_look' });
  assert.equal(look.ok, false, JSON.stringify(look));
  assert.equal(Number((await load(x.workload.id)).recheck_after), booked, 'never a whole rhythm from now, later than it was due');
});

test('B2 negatives: nothing waits for a close model that costs more than the customer\'s own', async () => {
  const x = await seeded({ n: 154, models: [CLOSE] });
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 25 * DAY, x.workload.id);
  await fakeTest(x, { results: [[REF, 'reference', null, 10], [CLOSE, 'review', null, 12]], sample: 27, floor: 23.1 });
  await waitToLookAgain();
  assert.equal((await load(x.workload.id)).measure_at_calls, null, 'it could never be offered, however closely it was read');
});

test('B2 negatives: nothing waits after a test on the full sample, or one where nothing came close', async () => {
  const full = await seeded({ n: 300, models: [CLOSE] });
  const a = await closeTest(full.workload.id);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal((await resultOf(a.runId, CLOSE)).verdict, 'review');
  assert.equal((await load(full.workload.id)).measure_at_calls, null, 'a sample of 120 is as close as a test reads');
  assert.doesNotMatch((await lastActivity(full.workload.id)).detail, /tested again by itself/);

  const worse = await seeded({ n: 200, models: [DRIFTY] });
  const b = await runEvaluation(worse.workload.id);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await resultOf(b.runId, DRIFTY)).verdict, 'missed');
  assert.equal((await load(worse.workload.id)).measure_at_calls, null, 'clearly worse is not read more closely by more calls');
});

test('B2: a workload that came close before this is found by the pass, and started when its calls are in', async () => {
  const x = await seeded({ n: 154, models: [CLOSE] });
  // as a summary workload was: close on 27 calls against a 23% bar, with 154 four days later, booked a month out
  await db.prepare(`UPDATE workloads SET status = 'certified', status_note = 'A candidate is close and needs a look', floor_pct = 23.1,
      measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 25 * DAY, x.workload.id);
  await fakeTest(x, { results: [[REF, 'reference', null, 10], [CLOSE, 'review', null, 1]], sample: 27, floor: 23.1, at: now() - 4 * DAY });
  const boot = await convertWaits();
  assert.ok(boot.waiting >= 1 && boot.started >= 1, JSON.stringify(boot));
  assert.deepEqual(await queued(x.workload.id), ['automatic'], 'a test on 54, queued as the server starts');
  await cancelFor(x.workload.id);
  // and not one that came close on as many calls as a test takes
  const y = await seeded({ n: 300, models: [CLOSE] });
  await db.prepare(`UPDATE workloads SET status = 'certified', measure_at_calls = NULL, recheck_after = ? WHERE id = ?`).run(now() + 25 * DAY, y.workload.id);
  await fakeTest(y, { results: [[REF, 'reference', null, 10], [CLOSE, 'review', null, 1]], sample: 120 });
  await waitToLookAgain();
  assert.equal((await load(y.workload.id)).measure_at_calls, null);
});

test('B3: choosing another rhythm books every tested workload again from its last test', async () => {
  const x = await seeded({ n: 30, models: [STEADY] });
  const { workspace, api } = x;
  // five workloads of one workspace: tested ten days ago; three days ago after a re-check that changed nothing; after a
  // test that failed a day ago, retrying in six hours; never tested; and one being tested now
  const extra = [];
  for (const topic of ['ticket', 'meeting', 'address', 'review']) {
    const wl = await workloadFor(workspace.id, requestOf(0, x.seq, topic));
    await record(workspace.id, wl.id, 0, x.seq, topic);
    await db.prepare(`UPDATE workloads SET state = 'live' WHERE id = ?`).run(wl.id);
    extra.push({ workspace, workload: await load(wl.id) });
  }
  assert.equal(new Set([x.workload.id, ...extra.map((e) => e.workload.id)]).size, 5, 'five workloads, not one');
  const [tenDays, backedOff, failed, fresh, busy] = [x, ...extra];
  // a sixth, tested ten days ago and waiting for the calls its second look needs
  const waitingWl = await workloadFor(workspace.id, { model: REF, messages: [{ role: 'system', content: `Translate this product listing into German, keeping units and prices, as JSON, lot ${x.seq}.` },
    { role: 'user', content: 'Invoice #0000' }], response_format: { type: 'json_object' } });
  await db.prepare(`UPDATE workloads SET state = 'live' WHERE id = ?`).run(waitingWl.id);
  const waiting = { workspace, workload: await load(waitingWl.id) };
  const t = now();
  const lastOf = { tenDays: t - 10 * DAY, backedOff: t - 3 * DAY, failed: t - DAY };
  await fakeTest(tenDays, { results: owed, at: lastOf.tenDays - 60000 });
  await fakeTest(backedOff, { results: owed, at: lastOf.backedOff - 60000 });
  await fakeTest(failed, { results: [], status: 'failed', outcome: 'interrupted', at: lastOf.failed - 60000 });
  await fakeTest(busy, { results: [], status: 'running', at: t - 60000 });
  await fakeTest(waiting, { results: owed, at: lastOf.tenDays - 60000 });
  await db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = 0, measure_at_calls = 88 WHERE id = ?').run(lastOf.tenDays + 30 * DAY, waiting.workload.id);
  await db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = 0 WHERE id = ?').run(lastOf.tenDays + 30 * DAY, tenDays.workload.id);
  await db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = 1 WHERE id = ?').run(lastOf.backedOff + 60 * DAY, backedOff.workload.id);
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(t + 6 * HOUR, failed.workload.id);
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(t + HOUR, fresh.workload.id);
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(t + 20 * DAY, busy.workload.id);
  const at = async (y) => Number((await load(y.workload.id)).recheck_after);
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 5000, `${why}: ${(a - t) / DAY} days from now, not ${(b - t) / DAY}`);

  // every 5 days: from each one's last test, never later than it was
  assert.equal((await api.post('/settings/measure-every', { days: 5 })).status, 200);
  near(await at(tenDays), lastOf.tenDays + 5 * DAY, 'five days after its last test, which is already past');
  near(await at(backedOff), lastOf.backedOff + 10 * DAY, 'the doubling after a re-check that changed nothing kept');
  near(await at(failed), t + 6 * HOUR, 'a retry that comes sooner keeps its time');
  near(await at(fresh), t + HOUR, 'one never tested is left to its first calls');
  near(await at(busy), t + 20 * DAY, 'one being tested books its own next test');
  assert.ok((await dueForRecheck(workspace.id, 5)).some((r) => r.id === tenDays.workload.id), 'and one past its time is due now');
  near(await at(waiting), t + 5 * DAY, 'one waiting for calls is never made due at once: a whole new rhythm from now');
  assert.ok(!(await dueForRecheck(workspace.id, 5)).some((r) => r.id === waiting.workload.id), 'so no whole test takes the calls its look waits for');

  // every 90 days: never sooner than the new rhythm, but a retry after a failure keeps its time
  assert.equal((await api.post('/settings/measure-every', { days: 90 })).status, 200);
  near(await at(tenDays), lastOf.tenDays + 90 * DAY, 'ninety days after its last test');
  near(await at(backedOff), lastOf.backedOff + 180 * DAY, 'doubled');
  near(await at(failed), t + 6 * HOUR, 'the retry keeps its time');

  // only when asked changes no booking; a rhythm chosen again books every one afresh from its last test
  const before = [await at(tenDays), await at(backedOff), await at(failed)];
  assert.equal((await api.post('/settings/measure-every', { days: 0 })).status, 200);
  assert.deepEqual([await at(tenDays), await at(backedOff), await at(failed)], before);
  assert.equal((await api.post('/settings/measure-every', { days: 10 })).status, 200);
  near(await at(tenDays), lastOf.tenDays + 10 * DAY, 'ten days after its last test');
  near(await at(backedOff), lastOf.backedOff + 20 * DAY, 'doubled');
  near(await at(failed), lastOf.failed + 10 * DAY, 'booked afresh from its last test');
  await db.prepare(`UPDATE eval_runs SET status = 'done', outcome = 'stopped', finished_at = ? WHERE workload_id = ? AND status = 'running'`)
    .run(now(), busy.workload.id);
});

test('the words: a model the second looks never came to is said to be not reached for the reason it was', async () => {
  const x = await seeded({ n: 30, models: [STEADY] });
  const view = async (runId) => runAnswersOf(await load(x.workload.id), await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId), STEADY);
  // another passed its second look first: the test chose it
  const passedRun = await fakeTest(x, { results: owed, choice: { chosen: CLOSE } });
  assert.equal((await view(passedRun)).looks.ended, "it wasn't reached, because another model passed first");
  // cut short at its limit before any look, nothing chosen
  const cut = await fakeTest(x, { results: owed, error: 'reached its limit of $0.40', choice: { chosen: null } });
  assert.equal((await view(cut)).looks.ended, "it wasn't reached, because the test ended before it got there");
  // over its quote after every look was taken: past the three, whatever the error says
  const three = [[CLOSE, 'cleared', 'review', 0.5, null, 60], [DRIFTY, 'cleared', 'review', 0.6, null, 60], [LUCKIES[0], 'cleared', 'missed', 0.4, null, 60]];
  const over = await fakeTest(x, { results: [...owed, ...three], error: 'reached its limit of $0.40', choice: { chosen: null } });
  assert.equal((await view(over)).looks.notReached, 'tries');
  // stopped by a person during its looks, which leaves no error: the test ended before it got there
  const stoppedRun = await fakeTest(x, { results: [...owed, [CLOSE, 'cleared', 'review', 0.5, null, 60]], status: 'stopped', outcome: 'stopped', choice: { chosen: null } });
  assert.equal((await view(stoppedRun)).looks.notReached, 'cut');
  // a verdict carried over from the test a second look continued took no look here, and is not counted as one
  const carried = [[CLOSE, 'cleared', 'review', 0.5], [DRIFTY, 'cleared', 'review', 0.6], [LUCKIES[0], 'cleared', 'missed', 0.4, null, 60]];
  const oneLook = await fakeTest(x, { results: [...owed, ...carried], choice: { chosen: null } });
  assert.equal((await view(oneLook)).looks.notReached, 'cut', 'one look taken, not three');
  // a test from before the choice was written down: read from whether any second look passed
  const oldPassed = await fakeTest(x, { results: [...owed, [CLOSE, 'cleared', 'cleared', 0.5, null, 60]] });
  assert.equal((await view(oldPassed)).looks.notReached, 'passed');
  const oldNone = await fakeTest(x, { results: [...owed, ...three] });
  assert.equal((await view(oldNone)).looks.notReached, 'tries');
  // raced in a second look only to build the setup it waited for
  const partRun = await fakeTest(x, { results: owed, trigger: 'second_look', plan: { secondLookOf: { runId: oldNone, keys: [`cascade:${STEADY}`] } },
    choice: { chosen: null } });
  assert.equal((await view(partRun)).looks.ended, "it wasn't reached, because this second look was only for the setup it was tested as part of");
  // switched back from before, so never switched to by itself again
  await promote(await load(x.workload.id), STEADY, { reason: 'cleared your bar', rollout: false });
  await revert(await load(x.workload.id), { reason: 'you asked for it' });
  const heldRun = await fakeTest(x, { results: owed, choice: { chosen: null } });
  assert.equal((await view(heldRun)).looks.notReached, 'held');
});
