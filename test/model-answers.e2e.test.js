/* One model in one test, request by request (runAnswersOf in src/workloadPage.js, served at
   /workloads/:id/runs/:runId/answers), end to end on a real database; and the answers a test keeps, through a real
   measurement against a provider and a judge we control.

   What is checked: a model's answers are exactly the ones its row in the table was read from, even when the same test
   finished it later for a setup built on it, so their average is its figure; which answers counted, as the test writes
   down (a judgement that did not come back, a refusal from a provider that was only busy), and for answers kept before
   it did, as far as they can still be told; what each request asked, and the original model's two answers beside this
   model's with the fields that differ from each; a tool call read back as the tool it called; content the retention
   window cleared said so, with the scores kept; a setup built on a model reading its lead model's answers and saying
   so; ten to a page; a model's second look, on new requests, kept and shown apart from its first without moving any
   figure its row shows; and the route, for the workload's owner only. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const APP_PORT = 4886;
const PROVIDER_PORT = 4887;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_answers_${process.pid}`;
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

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const auth = await import('../src/auth.js');
const { move } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { runAnswersOf, runPageOf } = await import('../src/workloadPage.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/steady-small';
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const CASCADE = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} against ${b}`);
const base = `http://127.0.0.1:${APP_PORT}`;

/* The provider and the judge, for the measurements run here: the customer's model and the steady one give the same
   answer to a request every time, in words or as JSON; the steady one words a written reply a little differently, so
   the judge is asked about it. The judge says SAME, except on every seventh request, where its reply cannot be read. */
const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const indexOf = (text) => Number((String(text).match(/#(\d+)/) || [])[1] || 0);
const judgeAsked = { all: 0, unread: 0 };
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    const user = String(p.messages?.find((m) => m.role === 'user')?.content ?? '');
    // a few milliseconds, so every answer has a time to read back
    const send = (content, cost = 0.0002) => setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model: p.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost } }));
    }, 5);
    if (p.model === 'judge/small') {
      judgeAsked.all += 1;
      const asked = (user.match(/<<<REQUEST\n([\s\S]*?)\nREQUEST>>>/) || [])[1] || '';
      const i = indexOf(asked);
      if (i && i % 7 === 0) { judgeAsked.unread += 1; return send('I would rather not say.'); }
      return send('SAME');
    }
    const i = indexOf(user);
    const pricey = p.model === REF ? 0.002 : 0.0002;
    if (user.startsWith('Reply to')) return send(p.model === REF ? `Reply number ${i}.` : `Reply number ${i}, kindly.`, pricey);
    return send(JSON.stringify(right(i)), pricey);
  });
});

let server = null;
test.before(async () => {
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'Vendor: Steady Small', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: 'judge/small', name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => provider.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

/* The records, written the way the app writes them ------------------------------------------------ */

let seq = 0;
async function account() {
  seq += 1;
  const email = `answers-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password: 'correct-horse-battery', name: `a${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  return { ws: workspace, email };
}
const hex = () => `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);
const loadRun = (rid) => db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(rid);

async function workload(ws, slug, { shape = 'json' } = {}) {
  const wid = id('wl');
  const t = now() - 40 * DAY;
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, optimize_mode, status,
      sample_prompt, tool_names, created_at, updated_at, calls_seen, state, named_at, name_source, recheck_streak)
    VALUES (?, ?, ?, ?, ?, ?, 'auto', 'new', 'Answer.', '[]', ?, ?, 0, 'live', ?, 'model', 0)`)
    .run(wid, ws.id, slug, hex(), shape, REF, t, t, t);
  return wid;
}

// one of the workload's real requests, as the customer's own model answered it
async function call(ws, wid, { at, text, system = 'Extract the totals as JSON.' }) {
  const cid = id('call');
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: text }];
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model, status_code, prompt_tokens,
      completion_tokens, cost_usd, charged_usd, latency_ms, request_json, response_json, created_at, request_hash, cost_estimated)
    VALUES (?, ?, ?, 'trace', ?, ?, 200, 1200, 40, 0.004, 0, 1000, ?, '{}', ?, ?, 0)`)
    .run(cid, ws.id, wid, REF, REF, JSON.stringify({ messages }), Math.round(at), hex());
  return cid;
}

async function run(ws, wid, { at, sample = 5, floor = 3, yardstick = 'agreement', shape = 'json', results = [] }) {
  const rid = id('run');
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, floor_pct, noise_pct,
      spend_usd, started_at, finished_at, created_at, trigger, outcome, yardstick, ref_latency_p50)
    VALUES (?, ?, ?, 'done', ?, ?, ?, ?, 1, 0.1, ?, ?, ?, 'manual', 'compared', ?, 2000)`)
    .run(rid, ws.id, wid, shape, REF, sample, floor, at - 11 * MIN, at, at - 11 * MIN, yardstick);
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, created_at)
    VALUES (?, ?, ?, ?, 0, 300, 'reference', ?)`).run(id('res'), rid, REF, sample * 2, at);
  for (const r of results) {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, gap_lo, gap_hi, cost_month_usd, verdict, created_at,
        arm_json, cost_ratio, latency_p50, stopped, confirm_verdict, confirm_runs, confirm_gap, confirm_hi, confirm_floor)
      VALUES (?, ?, ?, ?, ?, 0, ?, 30, ?, ?, ?, ?, 900, ?, ?, ?, ?, ?, ?)`)
      .run(id('res'), rid, r.key, r.runs ?? sample, r.gap ?? 0, r.hi ?? 2, r.verdict, at, r.spec ? JSON.stringify(r.spec) : null,
        'ratio' in r ? r.ratio : 0.1, r.stopped ?? null, r.confirm ?? null, r.confirmRuns ?? null, r.confirmGap ?? null,
        r.confirmHi ?? null, r.confirmFloor ?? null);
  }
  return rid;
}

// one model's answer to one request, as keepReplay in src/eval/run.js keeps it
async function answer(rid, callId, model, { at, text = '{"total":1}', score = 0, slot = 0, scored = null, look = null, failure = null,
  status = 200, judgedBy = null, cost = 0.0004, ms = 800, reused = 0 }) {
  await db.prepare(`INSERT INTO eval_replays (id, run_id, call_id, model_id, slot, reused, status, failure, answer, latency_ms, cost_usd, score,
      judged_by, scored, look, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('rep'), rid, callId, model, slot, reused, status, failure, text, ms, cost, score, judgedBy, scored, look, Math.round(at));
}

// a response as a provider sends it: words, or an object for a tool call
const reply = (content) => JSON.stringify(typeof content === 'object' ? content : { choices: [{ message: { role: 'assistant', content } }] });

// the original model's two answers to a request, as a test keeps them: their words, and their times and costs
async function sample(rid, callId, a, b, { at, look = null } = {}) {
  await db.prepare(`INSERT INTO eval_samples (id, run_id, call_id, quartile, ref_a_json, ref_b_json, charged) VALUES (?, ?, ?, 0, ?, ?, 0)`)
    .run(id('smp'), rid, callId, a === null ? null : reply(a), b === null ? null : reply(b));
  await answer(rid, callId, REF, { at, slot: 0, text: typeof a === 'string' ? a : null, score: null, look, cost: 0.004, ms: 2100 });
  await answer(rid, callId, REF, { at, slot: 1, text: typeof b === 'string' ? b : null, score: null, look, cost: 0.004, ms: 1900 });
}

/* 1. The answers a row was read from --------------------------------------------------------------- */

test('a model finished later for a setup built on it shows only the answers its row was read from', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'finished-later');
  const at = now() - HOUR;
  const calls = [];
  for (let i = 0; i < 5; i += 1) calls.push(await call(ws, wid, { at: at - DAY + i * MIN, text: `document #${i}` }));
  const rid = await run(ws, wid, { at, sample: 5, results: [
    { key: CHEAP, runs: 3, gap: 100 / 3, verdict: 'missed', stopped: 'bar' },
    { key: `cascade:${CHEAP}`, runs: 5, gap: 20, verdict: 'cleared', spec: CASCADE },
  ] });
  for (const c of calls) await sample(rid, c, '{"total":1}', '{"total":1}', { at: at - 55 * MIN });
  // its own look, stopped after three; then the same test finishes it for the setup, going through all five again
  const own = [0, 1, 0];
  for (let i = 0; i < 3; i += 1) await answer(rid, calls[i], CHEAP, { at: at - 50 * MIN + i, score: own[i], scored: 1 });
  const again = [0, 0, 0, 1, 0];
  for (let i = 0; i < 5; i += 1) await answer(rid, calls[i], CHEAP, { at: at - 20 * MIN + i, score: again[i], scored: 1 });
  const w = await load(wid);
  const r = await loadRun(rid);
  const mine = await runAnswersOf(w, r, CHEAP);
  assert.equal(mine.total, 3, 'its first three, the ones its row counts');
  near(mine.average, 1 / 3, 'their average');
  near(mine.figure, 1 / 3, 'which is the figure in its row');
  assert.deepEqual(mine.counts, { same: 2, partly: 0, different: 1, failed: 0, busy: 0, unjudged: 0 });
  assert.deepEqual(mine.rows.map((x) => x.callId), calls.slice(0, 3), 'in the order it answered them');
  assert.deepEqual(mine.rows.map((x) => x.n), [1, 2, 3]);
  assert.equal(mine.from, null, 'its own answers');
  const built = await runAnswersOf(w, r, `cascade:${CHEAP}`);
  assert.equal(built.from.model, CHEAP, "a setup built on a model shows its lead model's answers");
  assert.equal(built.from.name, 'Steady Small', 'named as people know it, without its maker');
  assert.match(built.from.why, /checks each answer, sending any that fail the check on to GPT-5\.4/);
  assert.match(built.from.why, /keeps no answers of its own/);
  assert.equal(built.total, 5, 'every request, once');
  assert.deepEqual(built.rows.map((x) => x.score), again, 'the finishing reading of each, which the setup read');
  assert.equal(built.looks.kept, 0, 'and no second look of its own is looked for');
});

/* 2. Which answers counted -------------------------------------------------------------------------- */

test('which answers counted: as the test wrote down, and for answers kept before it did, as far as they can be told', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'counted', { shape: 'free_text' });
  const at = now() - HOUR;
  const c = [];
  for (let i = 0; i < 6; i += 1) c.push(await call(ws, wid, { at: at - DAY + i * MIN, text: `Where is order #${i}?`, system: 'Answer the customer.' }));
  const rid = await run(ws, wid, { at, sample: 6, shape: 'free_text', results: [{ key: CHEAP, runs: 6, gap: 50, verdict: 'missed' }] });
  for (const x of c) await sample(rid, x, 'It ships today.', 'It ships today.', { at: at - 40 * MIN });
  const t = at - 30 * MIN;
  // counted: the same, and a different answer
  await answer(rid, c[0], CHEAP, { at: t, text: 'It ships today.', score: 0, scored: 1, judgedBy: 'same text' });
  await answer(rid, c[1], CHEAP, { at: t + 1, text: 'It shipped last week.', score: 1, scored: 1, judgedBy: 'llm' });
  // the judge's reply could not be read: kept with a score, and left out
  await answer(rid, c[2], CHEAP, { at: t + 2, text: 'Soon.', score: 1, scored: 0, judgedBy: 'llm' });
  // kept before answers were marked: a refusal from a provider that was only busy, left out; one that would come again, counted
  await answer(rid, c[3], CHEAP, { at: t + 3, text: null, score: 1, failure: 'refused', status: 429 });
  await answer(rid, c[4], CHEAP, { at: t + 4, text: null, score: 1, failure: 'refused', status: 404 });
  // and an answer with nothing in it, which counts against the model
  await answer(rid, c[5], CHEAP, { at: t + 5, text: '', score: 1, scored: 1, failure: 'empty' });
  const got = await runAnswersOf(await load(wid), await loadRun(rid), CHEAP);
  assert.deepEqual(got.counts, { same: 1, partly: 0, different: 1, failed: 2, busy: 1, unjudged: 1 });
  near(got.average, 3 / 4, 'the average of the four that counted: the same, a different one, and two failures');
  assert.equal(got.unmarked, 2, 'two were kept before answers were marked');
  const by = Object.fromEntries(got.rows.map((x) => [x.callId, x]));
  assert.equal(by[c[0]].verdict.text, 'Same answer');
  assert.equal(by[c[0]].compared, 'The text was identical');
  assert.equal(by[c[1]].verdict.text, 'Different');
  assert.equal(by[c[1]].compared, 'Read by a judge model');
  assert.equal(by[c[2]].verdict.text, "Couldn't be judged, so it doesn't count");
  assert.equal(by[c[2]].counted, false);
  assert.equal(by[c[2]].compared, null, 'a judgement that did not come back says nothing of how they compared');
  assert.equal(by[c[3]].verdict.text, "Provider busy, so it doesn't count");
  assert.equal(by[c[3]].counted, false);
  assert.equal(by[c[4]].verdict.text, 'Failed: the provider refused or failed it');
  assert.equal(by[c[4]].counted, true);
  assert.equal(by[c[5]].verdict.text, 'Failed: the answer was empty');
  assert.equal(by[c[0]].asked, 'Where is order #0?', 'what was asked is the last thing the person asked');
  assert.equal(by[c[0]].request, 'SYSTEM\nAnswer the customer.\n\nUSER\nWhere is order #0?', 'and the whole request, every message in order');
  assert.equal(by[c[0]].messages, 2);
  assert.deepEqual(by[c[0]].original, ['It ships today.', 'It ships today.']);
  assert.equal(by[c[0]].ms, 800);
  assert.equal(by[c[0]].original_ms, 2100, "the original model's time on the same request");
  near(by[c[0]].original_cost, 0.004, "and what it was paid for it");
});

/* 3. What each request shows ------------------------------------------------------------------------ */

test("a structured answer's differing fields are named against each of the original model's two answers", async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'fields');
  const at = now() - HOUR;
  const c = await call(ws, wid, { at: at - DAY, text: 'invoice #4' });
  const rid = await run(ws, wid, { at, sample: 1, results: [{ key: CHEAP, runs: 1, gap: 50, verdict: 'missed' }] });
  const note = 'Delivered to the front desk on Tuesday morning by the courier';
  await sample(rid, c, JSON.stringify({ total: 12.5, lines: 2, note }), JSON.stringify({ total: 12.5, lines: 3, note }), { at: at - 40 * MIN });
  const mine = { total: 12.5, lines: 3, note: 'Left at the front desk by the courier on Tuesday morning' };
  await answer(rid, c, CHEAP, { at: at - 30 * MIN, text: JSON.stringify(mine), score: 0.5, scored: 1 });
  const got = await runAnswersOf(await load(wid), await loadRun(rid), CHEAP);
  const x = got.rows[0];
  assert.deepEqual(x.heldTo, [true, true], 'held to each of the two, the score their average');
  assert.deepEqual(x.fields[0], { decide: ['lines'], written: ['note'] }, 'against the first: a deciding field, and a written one worded differently');
  assert.deepEqual(x.fields[1], { decide: [], written: ['note'] }, 'against the second: only the wording');
  assert.equal(x.verdict.text, 'Different from one of the two answers');
  assert.equal(x.verdict.tone, 'warn');
  assert.equal(x.compared, 'Compared field by field');
  assert.deepEqual(x.values.answer, mine, 'the answer as the test read it, to be laid out and marked');
  assert.deepEqual(x.values.original[0], { total: 12.5, lines: 2, note });
  assert.equal(got.counts.partly, 1);
});

test('a tool call reads back as the tool it called, and a different tool is the field that differs', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'tools', { shape: 'tool_call' });
  const at = now() - HOUR;
  const c = await call(ws, wid, { at: at - DAY, text: 'cancel my order #7' });
  const rid = await run(ws, wid, { at, sample: 1, shape: 'tool_call', results: [{ key: CHEAP, runs: 1, gap: 100, verdict: 'missed' }] });
  const called = (name) => ({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: '{"id":7}' } }] } }] });
  await sample(rid, c, called('lookup_order'), called('lookup_order'), { at: at - 40 * MIN });
  await answer(rid, c, CHEAP, { at: at - 30 * MIN, text: JSON.stringify([{ name: 'cancel_order', arguments: '{"id":7}' }]), score: 1, scored: 1 });
  const x = (await runAnswersOf(await load(wid), await loadRun(rid), CHEAP)).rows[0];
  assert.equal(x.answer, 'CALLED cancel_order\n{"id":7}');
  assert.equal(x.original[0], 'CALLED lookup_order\n{"id":7}');
  assert.deepEqual(x.fields[0], { decide: ['the tool called'], written: [] });
  assert.deepEqual(x.values.answer, [{ name: 'cancel_order', args: { id: 7 } }]);
});

test('held to "at least as good", an answer is read against the first of the original answers the test could read', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'quality', { shape: 'free_text' });
  const at = now() - HOUR;
  const a = await call(ws, wid, { at: at - DAY, text: 'Write a story #1', system: null });
  const b = await call(ws, wid, { at: at - DAY + MIN, text: 'Write a story #2', system: null });
  const rid = await run(ws, wid, { at, sample: 2, shape: 'free_text', yardstick: 'quality', results: [{ key: CHEAP, runs: 2, gap: 50, verdict: 'missed' }] });
  await sample(rid, a, 'Once, a fox.', 'Once, a hare.', { at: at - 40 * MIN });
  await sample(rid, b, null, 'Once, a crow.', { at: at - 40 * MIN });
  await answer(rid, a, CHEAP, { at: at - 30 * MIN, text: 'Once, a badger.', score: 0, scored: 1, judgedBy: 'llm-quality' });
  await answer(rid, b, CHEAP, { at: at - 30 * MIN + 1, text: 'Crow.', score: 1, scored: 1, judgedBy: 'llm-quality' });
  const got = await runAnswersOf(await load(wid), await loadRun(rid), CHEAP);
  assert.equal(got.yardstick, 'quality');
  assert.deepEqual(got.rows[0].heldTo, [true, false], 'its first answer, where it could be read');
  assert.deepEqual(got.rows[1].heldTo, [false, true], 'its second, where the first could not');
  assert.equal(got.rows[0].verdict.text, 'At least as good');
  assert.equal(got.rows[1].verdict.text, 'Clearly worse');
  assert.equal(got.rows[0].fields.every((f) => f === null), true, 'written work has no fields to name');
});

test('what was asked and answered goes with the retention window, and how each was scored stays', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'purged');
  const at = now() - HOUR;
  const c = await call(ws, wid, { at: at - DAY, text: 'invoice #3' });
  const rid = await run(ws, wid, { at, sample: 1, results: [{ key: CHEAP, runs: 1, gap: 100, verdict: 'missed' }] });
  await sample(rid, c, '{"total":1}', '{"total":1}', { at: at - 40 * MIN });
  await answer(rid, c, CHEAP, { at: at - 30 * MIN, text: '{"total":2}', score: 1, scored: 1 });
  // as the retention purge in src/server.js leaves them
  await db.prepare('UPDATE calls SET content_purged_at = ?, request_json = NULL WHERE id = ?').run(now(), c);
  await db.prepare('UPDATE eval_samples SET content_purged_at = ?, ref_a_json = NULL, ref_b_json = NULL WHERE run_id = ?').run(now(), rid);
  await db.prepare('UPDATE eval_replays SET answer = NULL WHERE run_id = ?').run(rid);
  const x = (await runAnswersOf(await load(wid), await loadRun(rid), CHEAP)).rows[0];
  assert.equal(x.purged, true);
  assert.equal(x.asked, null);
  assert.equal(x.request, null);
  assert.equal(x.answer, null);
  assert.deepEqual(x.original, [null, null]);
  assert.equal(x.score, 1, 'the score is kept');
  assert.equal(x.verdict.text, 'Different');
  assert.equal(x.ms, 800);
  assert.equal(x.original_ms, 2100);
});

test('ten requests to a page, numbered through, and a page past the end is empty', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'paged');
  const at = now() - HOUR;
  const rid = await run(ws, wid, { at, sample: 12, results: [{ key: CHEAP, runs: 12, gap: 0, verdict: 'cleared' }] });
  for (let i = 0; i < 12; i += 1) {
    const c = await call(ws, wid, { at: at - DAY + i * MIN, text: `invoice #${i}` });
    await sample(rid, c, '{"total":1}', '{"total":1}', { at: at - 40 * MIN });
    await answer(rid, c, CHEAP, { at: at - 30 * MIN + i, text: '{"total":1}', score: 0, scored: 1 });
  }
  const w = await load(wid);
  const r = await loadRun(rid);
  const one = await runAnswersOf(w, r, CHEAP);
  assert.equal(one.rows.length, 10);
  assert.equal(one.more, true);
  const two = await runAnswersOf(w, r, CHEAP, { page: 2 });
  assert.deepEqual(two.rows.map((x) => x.n), [11, 12]);
  assert.equal(two.more, false);
  const far = await runAnswersOf(w, r, CHEAP, { page: 99 });
  assert.deepEqual([far.rows.length, far.more, far.total], [0, false, 12]);
});

/* 4. The second look ------------------------------------------------------------------------------- */

test("a model's second look, on new requests, is shown apart from its first and moves nothing its row shows", async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'second-look');
  const at = now() - HOUR;
  const rid = await run(ws, wid, { at, sample: 3, results: [{ key: CHEAP, runs: 3, gap: 0, verdict: 'cleared', ratio: null,
    confirm: 'missed', confirmRuns: 2, confirmGap: 50, confirmHi: 90, confirmFloor: 10 }] });
  for (let i = 0; i < 3; i += 1) {
    const c = await call(ws, wid, { at: at - DAY + i * MIN, text: `invoice #${i}` });
    await sample(rid, c, '{"total":1}', '{"total":1}', { at: at - 40 * MIN });
    await answer(rid, c, CHEAP, { at: at - 30 * MIN + i, text: '{"total":1}', score: 0, scored: 1, cost: 0.0004 });
  }
  // two new requests, the original model's answers to them, and this model's, dearer, so a cost read from them would show
  const fresh = [];
  for (let i = 0; i < 2; i += 1) {
    const c = await call(ws, wid, { at: at - 2 * DAY + i * MIN, text: `invoice #${10 + i}` });
    fresh.push(c);
    await sample(rid, c, '{"total":10}', '{"total":10}', { at: at - 20 * MIN, look: 2 });
    await answer(rid, c, CHEAP, { at: at - 10 * MIN + i, text: i ? '{"total":11}' : '{"total":10}', score: i, scored: 1, look: 2, cost: 0.02 });
  }
  const w = await load(wid);
  const r = await loadRun(rid);
  const first = await runAnswersOf(w, r, CHEAP);
  assert.equal(first.look, 1);
  assert.equal(first.total, 3, 'the first look, on the test\'s own requests');
  assert.deepEqual(first.looks, { first: 3, second: 2, kept: 2, ended: "it didn't pass" });
  const second = await runAnswersOf(w, r, CHEAP, { look: 2 });
  assert.equal(second.look, 2);
  assert.equal(second.total, 2);
  assert.deepEqual(second.rows.map((x) => x.callId), fresh);
  near(second.average, 0.5, 'its average');
  near(second.figure, 0.5, 'the figure its second look found');
  near(second.bar, 0.1, 'and the most it allowed');
  assert.equal(second.rows[1].original_ms, 2100, "the original model's time on a new request, kept with it");
  assert.deepEqual(second.rows[1].fields[0], { decide: ['total'], written: [] });
  const page = await runPageOf(w, r);
  const cand = page.cands.find((x) => x.key === CHEAP);
  assert.equal(cand.n, 3);
  assert.equal(cand.second, 2, 'its row counts the new requests beside its own');
  near(cand.perCall, 0.0004, "its cost a request is read from its first look's answers, as before");
});

/* 5. The route -------------------------------------------------------------------------------------- */

test("the answers route: the workload's owner only, a model the test tried, its first look or its second", async () => {
  const mine = await account();
  const theirs = await account();
  const wid = await workload(mine.ws, 'route');
  const at = now() - HOUR;
  const rid = await run(mine.ws, wid, { at, sample: 12, results: [{ key: CHEAP, runs: 12, gap: 0, verdict: 'cleared', confirm: 'cleared', confirmRuns: 1, confirmGap: 0, confirmFloor: 3 }] });
  for (let i = 0; i < 12; i += 1) {
    const c = await call(mine.ws, wid, { at: at - DAY + i * MIN, text: `invoice #${i}` });
    await sample(rid, c, '{"total":1}', '{"total":1}', { at: at - 40 * MIN });
    await answer(rid, c, CHEAP, { at: at - 30 * MIN + i, score: 0, scored: 1 });
  }
  const f = await call(mine.ws, wid, { at: at - 2 * DAY, text: 'invoice #99' });
  await sample(rid, f, '{"total":1}', '{"total":1}', { at: at - 20 * MIN, look: 2 });
  await answer(rid, f, CHEAP, { at: at - 10 * MIN, score: 0, scored: 1, look: 2 });
  const other = await workload(theirs.ws, 'route-theirs');
  const otherRun = await run(theirs.ws, other, { at, results: [{ key: CHEAP, verdict: 'cleared' }] });
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.91' },
    body: JSON.stringify({ email: mine.email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const get = (path, headers = { cookie }) => fetch(`${base}/api${path}`, { headers });
  const q = (m) => encodeURIComponent(m);
  const one = await get(`/workloads/${wid}/runs/${rid}/answers?model=${q(CHEAP)}`);
  assert.equal(one.status, 200);
  const body = await one.json();
  assert.deepEqual([body.key, body.total, body.rows.length, body.more, body.look], [CHEAP, 12, 10, true, 1]);
  assert.equal((await (await get(`/workloads/${wid}/runs/${rid}/answers?model=${q(CHEAP)}&page=2`)).json()).rows.length, 2);
  const again = await (await get(`/workloads/${wid}/runs/${rid}/answers?model=${q(CHEAP)}&look=2`)).json();
  assert.deepEqual([again.look, again.total, again.rows[0].callId], [2, 1, f], 'its second look, asked for by name');
  for (const [path, why] of [
    [`/workloads/${wid}/runs/${rid}/answers?model=${q(REF)}`, 'the original model is not one of the models tried'],
    [`/workloads/${wid}/runs/${rid}/answers`, 'nor is no model at all'],
    [`/workloads/${wid}/runs/${rid}/answers?model=${q('vendor/never-tried')}`, 'nor one the test never tried'],
    [`/workloads/${other}/runs/${otherRun}/answers?model=${q(CHEAP)}`, "another workspace's workload is not found"],
    [`/workloads/${wid}/runs/${otherRun}/answers?model=${q(CHEAP)}`, "nor another workload's test"],
  ]) assert.equal((await get(path)).status, 404, why);
  assert.equal((await get(`/workloads/${wid}/runs/${rid}/answers?model=${q(CHEAP)}`, {})).status, 401, 'nobody signed in is told to sign in');
});

/* 6. What a real measurement keeps ----------------------------------------------------------------- */

// a workspace with one workload: `n` requests, recorded the way the customer's own model answered them
async function seeded({ n, written = false }) {
  seq += 1;
  const { workspace } = await auth.createAccount({ email: `answers-run-${seq}-${process.pid}@example.test`, password: 'correct-horse', name: `r${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run('ask', workspace.id);
  let wl = null;
  for (let i = 0; i < n; i += 1) {
    const request = written
      ? { model: REF, messages: [{ role: 'system', content: `Answer the customer kindly, set ${seq}.` }, { role: 'user', content: `Reply to message #${i}` }] }
      : { model: REF, messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}, set ${seq}.` }, { role: 'user', content: `document #${i}` }],
        response_format: { type: 'json_object' } };
    wl = wl || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: wl.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0, request,
      response: { choices: [{ message: { content: written ? `Reply number ${i}.` : JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?').run(now() - DAY, wl.id);
  await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, 1, ?), (?, 'judge/small', 0, ?)
      ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, CHEAP, now(), workspace.id, now());
  return { workspace, workload: await load(wl.id) };
}

test("a measurement keeps every answer marked, a model's second look with them, and the page reads them back as the test did", async () => {
  const { workload: w } = await seeded({ n: 300 });
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const r = await loadRun(out.runId);
  const row = await db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(out.runId, CHEAP);
  assert.equal(row.verdict, 'cleared', `its first look: ${row.gap_pct}%`);
  assert.ok(row.confirm_runs > 0, `and a second look on new requests: ${row.confirm_verdict}, ${row.confirm_runs}`);
  const kept = await db.prepare(`SELECT look, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE scored IS NULL)::int AS unmarked,
      COUNT(*) FILTER (WHERE scored = 1)::int AS counted FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 GROUP BY look ORDER BY look`)
    .all(out.runId, CHEAP);
  const firstLook = kept.find((x) => x.look === null);
  const secondLook = kept.find((x) => x.look === 2);
  assert.equal(firstLook.unmarked, 0, 'every answer to its first look says whether it counted');
  assert.equal(firstLook.n, row.runs);
  assert.equal(secondLook.unmarked, 0, 'and every answer to its second');
  assert.equal(secondLook.counted, row.confirm_runs, 'the second look counted exactly the answers it was read on');
  const refs = await db.prepare(`SELECT COUNT(*)::int AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND look = 2`).get(out.runId, REF);
  assert.equal(refs.n, secondLook.n * 2, "the original model's two answers to each new request are kept beside them");
  const one = await runAnswersOf(w, r, CHEAP);
  near(one.average, Number(row.gap_pct) / 100, 'the first look reads back to its figure');
  assert.equal(one.looks.second, row.confirm_runs);
  const two = await runAnswersOf(w, r, CHEAP, { look: 2 });
  assert.equal(two.total, secondLook.n);
  near(two.average, Number(row.confirm_gap) / 100, 'and the second to the figure its look found');
  const seen = new Set(one.rows.map((x) => x.callId));
  assert.equal(two.rows.some((x) => seen.has(x.callId)), false, 'on requests the first look never saw');
  assert.ok(two.rows.every((x) => x.original_ms > 0 && x.original[0] !== null), "each beside the original model's answer and time");
});

test('a judgement that does not come back is kept, marked as not counting, and left out of the figure exactly as the test left it', async () => {
  const { workload: w } = await seeded({ n: 120, written: true });
  const unreadBefore = judgeAsked.unread;
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(judgeAsked.unread > unreadBefore, 'the judge could not be read on some requests');
  const r = await loadRun(out.runId);
  const row = await db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(out.runId, CHEAP);
  assert.ok(row, 'the steady model was tried');
  const marks = await db.prepare(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE scored = 0)::int AS left_out,
      COUNT(*) FILTER (WHERE scored IS NULL)::int AS unmarked FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0
      AND look IS DISTINCT FROM 2`).get(out.runId, CHEAP);
  assert.equal(marks.unmarked, 0);
  assert.ok(marks.left_out > 0, `some answers were left out: ${JSON.stringify(marks)}`);
  const got = await runAnswersOf(w, r, CHEAP);
  assert.equal(got.counts.unjudged, marks.left_out, "each shown as couldn't be judged");
  near(got.average, Number(row.gap_pct) / 100, 'the answers that counted average to its figure');
  const left = [];
  for (let p = 1; p <= Math.ceil(got.total / got.per); p += 1) {
    const pg1 = p === 1 ? got : await runAnswersOf(w, r, CHEAP, { page: p });
    left.push(...pg1.rows.filter((x) => !x.counted));
  }
  assert.equal(left.length, marks.left_out);
  assert.ok(left.every((x) => x.verdict.text === "Couldn't be judged, so it doesn't count" && x.score === 1),
    'kept with the score it was given, and said not to count');
  assert.ok(left.every((x) => /#\d+/.test(x.asked) && Number(x.asked.match(/#(\d+)/)[1]) % 7 === 0), 'on the requests the judge could not be read on');
});
