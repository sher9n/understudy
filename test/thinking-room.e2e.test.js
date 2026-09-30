/* A model that has to think, on a workload whose requests cap their answers at 300 tokens (EVAL_THINK_ALLOWANCE_TOKENS),
   and the test after one that found nothing (lastFailedOn), end to end on a real database, through a provider we control.

   What is checked: the model is tried rather than left out, asked to think as little as it allows, with the room above
   the cap on every request it is sent; switched to, a live call goes to it the same way, and what the call sets aside
   covers the room; a test that found nothing makes the next one climb to the likeliest models first; and that test's
   page says which settings kept models out, naming one. The provider answers a thinking model only when it has the room:
   given just the 300-token cap it runs out while thinking, as the three models of the first real measurement did. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';

const PROVIDER_PORT = 4915;
const PROXY_PORT = 4916;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_room_${process.pid}`;
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
process.env.MODEL_BACKOFF_START_MS = '5';
process.env.MODEL_BACKOFF_MAX_MS = '10';
process.env.UPSTREAM_RETRY_WAIT_MAX_MS = '5';
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
process.env.EXPLORE_SHARE_NORMAL = '0';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const auth = await import('../src/auth.js');
const { move, callShape, callBound, boundAt, withFee } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { runPageOf } = await import('../src/workloadPage.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { planFor } = await import('../src/eval/plan.js');
const { historyFor, lastFailedOn, forgetFleet } = await import('../src/eval/history.js');
const { promote } = await import('../src/eval/promote.js');
const { default: config } = await import('../src/config.js');
const { default: v1 } = await import('../src/proxy.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
// has to think before every answer, and cannot be told not to
const MUST = 'vendor/must-think';
// answers every request wrongly: a test that has only it finds nothing
const SMALL = 'vendor/small-wrong';
// dearer than the customer's model on these calls: left out on price, which the page names
const DEAR = 'vendor/dear';
// has to think too, and given the room writes answers longer than the customer's own cap allows
const LONG = 'vendor/long-winded';
const JUDGE = 'judge/small';
const MODELS = [MUST, SMALL, DEAR, LONG];
const CAP = 300;
const ROOM = config.EVAL_THINK_ALLOWANCE_TOKENS;

const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const indexOf = (text) => Number((String(text).match(/#(\d+)/) || [])[1] || 0);
// every request each model was sent, as it arrived: its cap, how it was asked to think, and what was set aside meanwhile
const seen = new Map();
let liveWs = null;
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = JSON.parse(body || '{}');
    const m = p.model;
    const cap = Number(p.max_completion_tokens ?? p.max_tokens) || null;
    const heldNow = liveWs && m === MUST
      ? Number((await db.prepare('SELECT COALESCE(MAX(amount_usd), 0) AS a FROM balance_holds WHERE workspace_id = ?').get(liveWs))?.a) : null;
    if (!seen.has(m)) seen.set(m, []);
    seen.get(m).push({ cap, reasoning: p.reasoning ?? null, held: heldNow });
    const user = String(p.messages?.find((x) => x.role === 'user')?.content ?? '');
    const i = indexOf(user);
    const send = (content, usage, finish = 'stop') => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model: m,
        choices: [{ finish_reason: finish, message: { role: 'assistant', content } }], usage }));
    };
    if (m === JUDGE) return send('SAME', { prompt_tokens: 50, completion_tokens: 1, cost: 0.00001 });
    if (m === MUST) {
      // it thinks 400 tokens before every answer: with only the customer's cap it runs out and says nothing
      if (!cap || cap < 400 + 60) return send('', { prompt_tokens: 800, completion_tokens: cap || 0, cost: 0.0004 }, 'length');
      return send(JSON.stringify(right(i)), { prompt_tokens: 800, completion_tokens: 460, completion_tokens_details: { reasoning_tokens: 400 }, cost: 0.0006 });
    }
    if (m === SMALL) return send(JSON.stringify({ total: 0, currency: 'EUR', lines: 0 }), { prompt_tokens: 800, completion_tokens: 20, cost: 0.00005 });
    // the right figures, in an answer of 500 tokens after 400 of thinking: 200 more than the customer's cap allows
    if (m === LONG) {
      if (!cap || cap < 900) return send('', { prompt_tokens: 800, completion_tokens: cap || 0, cost: 0.0004 }, 'length');
      return send(JSON.stringify(right(i)), { prompt_tokens: 800, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 400 }, cost: 0.0009 });
    }
    return send(JSON.stringify(right(i)), { prompt_tokens: 800, completion_tokens: 60, cost: m === REF ? 0.002 : 0.004 });
  });
});

const app = express();
app.use('/v1', v1);
let proxy = null;

test.before(async () => {
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  await new Promise((r) => { proxy = app.listen(PROXY_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: MUST, name: 'Vendor: Must Think', context_len: 128000, price_in: 3e-7, price_out: 1.2e-6, open_weights: 0, zdr: 1,
      max_output: 16000, reasoning_json: JSON.stringify({ mandatory: true, supported_efforts: ['low', 'high'], default_effort: 'high' }) },
    { model_id: SMALL, name: 'Vendor: Small', context_len: 128000, price_in: 5e-8, price_out: 1e-7, open_weights: 0, zdr: 1 },
    { model_id: LONG, name: 'Vendor: Long Winded', context_len: 128000, price_in: 2e-7, price_out: 8e-7, open_weights: 0, zdr: 1,
      max_output: 16000, reasoning_json: JSON.stringify({ mandatory: true, supported_efforts: ['low', 'high'], default_effort: 'high' }) },
    { model_id: DEAR, name: 'Vendor: Dear', context_len: 128000, price_in: 5e-6, price_out: 3e-5, open_weights: 0, zdr: 1 },
    { model_id: JUDGE, name: 'judge', context_len: 128000, price_in: 5e-8, price_out: 1e-7, open_weights: 0, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => provider.close(r));
  await new Promise((r) => proxy.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);
const rowsOf = async (runId) => new Map((await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId)).map((r) => [r.model_id, r]));

/* A workspace with one workload of `n` requests, each capped at CAP tokens, recorded as the customer's own model answered
   them, trying only `models`. */
let seq = 0;
const request = (i, s) => ({ model: REF, max_tokens: CAP,
  messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}, set ${s}.` },
    { role: 'user', content: `document #${String(i).padStart(4, '0')}` }], response_format: { type: 'json_object' } });
async function seeded({ n = 300, models }) {
  seq += 1;
  const { workspace } = await auth.createAccount({ email: `room-${seq}-${process.pid}@example.test`, password: 'correct-horse', name: `r${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare("UPDATE workspaces SET default_optimize_mode = 'auto' WHERE id = ?").run(workspace.id);
  let wl = null;
  for (let i = 0; i < n; i += 1) {
    const body = request(i, seq);
    wl = wl || await workloadFor(workspace.id, body);
    await recordCall({
      workspaceId: workspace.id, workloadId: wl.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0, request: body,
      response: { choices: [{ message: { content: JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?').run(now() - 86400000, wl.id);
  for (const m of [...MODELS, JUDGE]) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, models.includes(m) || m === JUDGE ? 1 : 0, now());
  }
  return { workspace, workload: await load(wl.id) };
}

let passed = null;

test('a model that has to think is tried with room above a 300-token cap, and passes, where before it was left out', async () => {
  const { workspace, workload: w } = await seeded({ models: [MUST, LONG] });
  forgetFleet();
  const plan = await planFor(w, { canRoute: true });
  const planned = plan.order.find((o) => o.model === MUST);
  assert.ok(planned, `planned rather than left out: ${JSON.stringify(plan.excluded)}`);
  assert.deepEqual(planned.recipe, { reasoning: { effort: 'low' }, room: ROOM });
  assert.match(planned.note, new RegExp(`room to think beyond your ${CAP}-token cap`));

  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = (await rowsOf(out.runId)).get(MUST);
  assert.ok(row, 'measured');
  assert.equal(row.verdict, 'cleared', `with room to think it answers as the customer's model does: ${row.verdict} ${row.gap_pct}`);
  assert.equal(JSON.parse(row.recipe_json).room, ROOM, 'the room travels with its result, so a switch to it serves it the same way');
  const sent = seen.get(MUST) || [];
  assert.ok(sent.length >= 100, `${sent.length} requests`);
  assert.ok(sent.every((x) => x.cap === CAP + ROOM), `every request had the cap and the room: ${[...new Set(sent.map((x) => x.cap))]}`);
  assert.ok(sent.every((x) => x.reasoning?.effort === 'low'), 'each asked to think as little as it allows');
  // one that answers past the customer's own cap with the room is read as the cut-off answer it would have been
  const long = (await rowsOf(out.runId)).get(LONG);
  assert.ok(long, 'measured');
  assert.notEqual(long.verdict, 'cleared', `writing past the cap is never a pass: ${long.verdict} ${long.gap_pct}`);
  const stored = await db.prepare(`SELECT response_json FROM replay_cache WHERE model_id = ? AND response_json IS NOT NULL LIMIT 1`).get(LONG);
  assert.equal(JSON.parse(stored.response_json).understudy_past_cap?.cap, CAP, 'and kept as cut off, with why');
  passed = { workspace, w, runId: out.runId };
});

test('switched to it, a live call is sent the same way, and what the call sets aside covers the room', async () => {
  assert.ok(passed, 'needs the test before');
  const w = await load(passed.w.id);
  const p = await promote(w, MUST, { runId: passed.runId, auto: true });
  assert.equal(p.ok, true, JSON.stringify(p));
  const key = await issueKey(passed.workspace.id, 'room');
  seen.delete(MUST);
  liveWs = passed.workspace.id;
  const body = request(7, 'live');
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  liveWs = null;
  assert.equal(res.status, 200, text);
  assert.equal(res.headers.get('x-understudy-served-by') ?? MUST, MUST);
  const live = seen.get(MUST) || [];
  assert.equal(live.length, 1, 'the live call went to it');
  assert.equal(live[0].cap, CAP + ROOM, 'with the room it was measured with');
  assert.equal(live[0].reasoning?.effort, 'low');
  /* What it set aside covers what the call can cost: the switched model at the raised cap, and the customer's model it can
     fall back to at the request's own (it is sent no room). Held at 300 tokens for the first, a model writing 2,300 could
     spend past it; held at 2,300 for the second, several times what the call could cost was held. */
  const shape = await callShape(body);
  const at = async (m, cap) => { const b = await callBound(m, { ...shape, cap }, { zdr: true }); return boundAt(b.parts, b.ceiling); };
  const worst = Math.max(await at(MUST, CAP + ROOM), await at(REF, CAP));
  assert.ok(live[0].held >= withFee(worst) - 1e-9, `held ${live[0].held} against ${withFee(worst)}`);
  assert.ok(live[0].held < withFee(await at(REF, CAP + ROOM)), `never the customer's model at the raised cap: ${live[0].held}`);
  await learningSettled();
});

test('a test that finds nothing makes the next one climb, and its page says which settings kept models out', async () => {
  const { workload: w } = await seeded({ models: [SMALL, DEAR] });
  assert.equal(await lastFailedOn(w.id), false, 'never tested: nothing has failed yet');
  forgetFleet();
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const rows = await rowsOf(out.runId);
  assert.equal(rows.get(SMALL)?.verdict, 'missed');
  assert.equal(rows.has(DEAR), false, 'dearer than the customer model: never tried');
  assert.equal(await lastFailedOn(w.id), true, 'the newest test that compared models found nothing to switch to');
  // one cut short at the most it could spend did not finish, and says nothing either way
  await db.prepare('UPDATE eval_runs SET error = ? WHERE id = ?').run('reached its limit of $0.50 while testing models', out.runId);
  assert.equal(await lastFailedOn(w.id), false);
  await db.prepare('UPDATE eval_runs SET error = NULL WHERE id = ?').run(out.runId);
  assert.equal((await historyFor(await load(w.id))).lastFailed, true);
  forgetFleet();
  const next = await planFor(await load(w.id), { canRoute: true });
  assert.equal(next.climb, true, 'so the next one tries the likeliest first');
  // the page of the test that found nothing names the setting that kept a model out, and one it kept out
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  const page = await runPageOf(await load(w.id), run);
  assert.match(page.take, /Some models were not tried: 1 costs more than (GPT-5\.4|gpt-5\.4) on your requests, so switching to it could not save anything \(for example vendor\/dear\)\./, page.take);
  // and the workload whose test found a model: nothing failed there
  assert.equal(await lastFailedOn(passed.w.id), false);
  const passedRun = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(passed.runId);
  assert.doesNotMatch((await runPageOf(await load(passed.w.id), passedRun)).take, /Some models were not tried/);
});
