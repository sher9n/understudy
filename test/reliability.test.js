/* The service keeps answering: a burst of new calls, a switched model that fails, a model that left
   the catalogue, a malformed body, background work that must not crowd out live calls. End to end,
   against the real app and a provider we control. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4783;
const APP_PORT = 4784;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_rel_${process.pid}`;
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
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.REQUEST_LOGS = 'false';
process.env.LIVE_RETRY_WAIT_MAX_MS = '10';

const { db, now } = await import('../src/db/index.js');
const { default: config } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const billing = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const jobs = await import('../src/jobs.js');
const { promote, watchCatalogue } = await import('../src/eval/promote.js');
const { learningSettled } = await import('../src/traffic.js');
const { forgetWorkspace } = await import('../src/workspace.js');
const { app } = await import('../src/server.js');

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/cheap';
// how the provider behaves for each model, changed by the tests as they go
const behave = new Map();
const seen = [];
// the model list OpenRouter answers with, set by the test that reads it
let modelList = [];
const provider = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: modelList }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    seen.push(p);
    const how = behave.get(p.model) || 'ok';
    if (how === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Provider overloaded' } })); return; }
    if (how === 'too-long') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'This model\'s maximum context length is 8192 tokens' } })); return; }
    if (how === 'bad-request') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'messages[0].role is invalid' } })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'gen', model: p.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `answer from ${p.model}` } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0002 } }));
  });
});
let server = null;
const base = `http://127.0.0.1:${APP_PORT}`;
let key = null;
let ws = null;

const call = (body, k = key) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test.before(async () => {
  await new Promise((r) => provider.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'cheap', context_len: 8192, price_in: 0.1e-6, price_out: 0.4e-6, open_weights: 1, zdr: 1 },
  ]);
  const a = await auth.createAccount({ email: 'reliable@example.test', password: 'password-123' });
  key = a.key.secret;
  ws = a.workspace;
  await billing.move(ws.id, { kind: 'credit', amountUsd: 50, note: 'test credit' });
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

test('a burst of a brand new kind of call is answered, every one', async () => {
  // a sorting call names a short answer, as it would: an uncapped one sets aside its model's whole window
  const statuses = await Promise.all(Array.from({ length: 25 }, (_, i) => call({
    model: REF, max_tokens: 20, messages: [{ role: 'system', content: 'Sort the parcel note into late, damaged or fine.' }, { role: 'user', content: `note ${i}` }],
  }).then((r) => r.status)));
  assert.deepEqual([...new Set(statuses)], [200], JSON.stringify(statuses));
  const w = await workloadOf('Sort the parcel note');
  assert.equal(Number(w.calls_seen), 25, 'every call counted, none lost to calls arriving together');
  assert.equal(w.state, 'live');
});

test('a model named the way its maker names it is found, and an unknown one is refused plainly', async () => {
  const r = await call({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello there' }] });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).model, REF, 'sent under the catalogue\'s name');
  const bad = await call({ model: 'gpt-imaginary', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /not a model we route to/);
});

test('a body that is not JSON, or too big, is the caller\'s problem, said as one', async () => {
  const r = await call('{"model": "openai/gpt-5.4", "messages": [ ... ]}');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /not valid JSON/);
  const big = await call({ model: REF, messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] });
  assert.equal(big.status, 413);
});

// the workload a prompt was grouped into, found through its calls (the instruction is kept normalised)
async function workloadOf(text) {
  const c = await db.prepare(`SELECT workload_id FROM calls WHERE workspace_id = ? AND request_json LIKE ? AND workload_id IS NOT NULL LIMIT 1`)
    .get(ws.id, `%${text}%`);
  return c ? await db.prepare('SELECT * FROM workloads WHERE id = ?').get(c.workload_id) : undefined;
}

async function switchedWorkload(prompt) {
  for (let i = 0; i < 3; i += 1) {
    await call({ model: REF, messages: [{ role: 'system', content: prompt }, { role: 'user', content: `item ${i}` }] });
  }
  const w = await workloadOf(prompt);
  const r = await promote(w, CHEAP, { reason: 'test switch' });
  assert.equal(r.ok, true);
  return w;
}

test('when what serves a switched workload fails, the customer\'s own model answers, and the failure counts', async () => {
  const w = await switchedWorkload('Summarise the delivery note in five words.');
  behave.set(CHEAP, 'down');
  const r = await call({ model: REF, messages: [{ role: 'system', content: 'Summarise the delivery note in five words.' }, { role: 'user', content: 'item 9' }] });
  assert.equal(r.status, 200, 'answered, not failed');
  assert.equal((await r.json()).choices[0].message.content, `answer from ${REF}`);
  const rows = await db.prepare(`SELECT served_model, status_code, check_json FROM calls WHERE workload_id = ? AND source = 'routed'
                                   ORDER BY created_at DESC LIMIT 2`).all(w.id);
  assert.ok(rows.some((c) => c.served_model === CHEAP && c.status_code === 503 && /fell back/.test(c.check_json)), JSON.stringify(rows));
  // a call longer than the new model takes: the customer's model has room for it
  behave.set(CHEAP, 'too-long');
  const long = await call({ model: REF, messages: [{ role: 'system', content: 'Summarise the delivery note in five words.' }, { role: 'user', content: 'item 10' }] });
  assert.equal(long.status, 200);
  // a request that is simply wrong would fail on their model too: said as it is, not tried twice
  behave.set(CHEAP, 'bad-request');
  const before = seen.length;
  const wrong = await call({ model: REF, messages: [{ role: 'system', content: 'Summarise the delivery note in five words.' }, { role: 'user', content: 'item 11' }] });
  assert.equal(wrong.status, 400);
  assert.equal(seen.length - before, 1, 'no second model was asked');
  behave.delete(CHEAP);
});

test('a switched model that leaves the catalogue is switched back within the hour', async () => {
  const w = await switchedWorkload('Pick the shipping carrier for the order.');
  await db.prepare('DELETE FROM models_catalog WHERE model_id = ?').run(CHEAP);
  assert.ok(await watchCatalogue() >= 1);
  const after = await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(w.id);
  assert.equal(after.routed_model, null);
  const said = await db.prepare(`SELECT reason, action FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(w.id);
  assert.equal(said.action, 'soft_revert');
  assert.match(said.reason, /no longer offered/);
  // the whole catalogue comes back, the customer's model included: saving a list takes out what it leaves out
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'cheap', context_len: 8192, price_in: 0.1e-6, price_out: 0.4e-6, open_weights: 1, zdr: 1 },
  ]);
});

test('a workspace that allows providers keeping data briefly never allows ones that train on it', async () => {
  assert.equal((await call({ model: REF, messages: [{ role: 'user', content: 'retention check' }] })).status, 200);
  assert.equal(seen.at(-1).provider.zdr, true, 'zero data retention by default');
  assert.equal(seen.at(-1).provider.data_collection, 'deny');
  await db.prepare('UPDATE workspaces SET zdr_required = 0 WHERE id = ?').run(ws.id);
  forgetWorkspace(ws.id);
  await call({ model: REF, messages: [{ role: 'user', content: 'retention check two' }] });
  assert.equal(seen.at(-1).provider.zdr, undefined, 'retention allowed');
  assert.equal(seen.at(-1).provider.data_collection, 'deny', 'training never');
  await db.prepare('UPDATE workspaces SET zdr_required = 1 WHERE id = ?').run(ws.id);
  forgetWorkspace(ws.id);
});

test('background work runs a few at a time, and measurements fewer still', async () => {
  let running = 0;
  let most = 0;
  let mostEval = 0;
  let runningEval = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  jobs.handle('test_sleep', async () => { running += 1; most = Math.max(most, running); await sleep(80); running -= 1; return { ok: true }; });
  jobs.handle('eval_run', async () => {
    running += 1; runningEval += 1; most = Math.max(most, running); mostEval = Math.max(mostEval, runningEval);
    await sleep(80); running -= 1; runningEval -= 1; return { ok: true };
  });
  for (let i = 0; i < 8; i += 1) await jobs.enqueue('test_sleep', { i });
  for (let i = 0; i < 6; i += 1) await jobs.enqueue('eval_run', { workloadId: `wl_${i}` });
  config.JOBS_ENABLED = true;
  config.JOBS_TICK_MS = 20;
  jobs.startJobs();
  for (let t = 0; t < 200; t += 1) {
    const left = Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind IN ('test_sleep', 'eval_run') AND status IN ('queued', 'claimed')`).get()).n);
    if (!left && running === 0) break;
    await sleep(25);
  }
  await jobs.stopJobs();
  config.JOBS_ENABLED = false;
  assert.ok(most <= config.JOBS_CONCURRENCY, `at most ${config.JOBS_CONCURRENCY} at once, saw ${most}`);
  assert.ok(mostEval <= config.EVAL_CONCURRENCY, `at most ${config.EVAL_CONCURRENCY} measurements at once, saw ${mostEval}`);
  assert.ok(most >= 2, 'and more than one at a time when there is work');
});

test('a measurement somebody asked for starts at once, while measurements nobody asked for fill their places', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = [];
  let evals = 0;
  let mostEvals = 0;
  let others = 0;
  let mostAll = 0;
  jobs.handle('test_slow', async () => { others += 1; mostAll = Math.max(mostAll, evals + others); await sleep(600); others -= 1; return { ok: true }; });
  jobs.handle('eval_run', async (payload) => {
    started.push({ trigger: payload.trigger, at: Date.now() });
    evals += 1;
    mostEvals = Math.max(mostEvals, evals);
    mostAll = Math.max(mostAll, evals + others);
    await sleep(payload.trigger === 'manual' ? 50 : 600);
    evals -= 1;
    return { ok: true };
  });
  // two measurements nobody asked for take their two places, and other work takes what is left of the rest
  for (let i = 0; i < 2; i += 1) await jobs.enqueue('eval_run', { workloadId: `wl_auto_${i}`, trigger: 'automatic' });
  for (let i = 0; i < 3; i += 1) await jobs.enqueue('test_slow', { i });
  const was = { tick: config.JOBS_TICK_MS };
  config.JOBS_ENABLED = true;
  // a tick far longer than the test, so only waking the runner can start the one asked for in time
  config.JOBS_TICK_MS = 60000;
  jobs.startJobs();
  try {
    for (let t = 0; t < 40 && started.filter((s) => s.trigger === 'automatic').length < 2; t += 1) await sleep(10);
    assert.equal(started.filter((s) => s.trigger === 'automatic').length, 2, 'the two nobody asked for are running');
    const asked = Date.now();
    await jobs.enqueue('eval_run', { workloadId: 'wl_asked', trigger: 'manual' });
    jobs.wakeJobs();
    for (let t = 0; t < 40 && !started.some((s) => s.trigger === 'manual'); t += 1) await sleep(10);
    const mine = started.find((s) => s.trigger === 'manual');
    assert.ok(mine, 'the one asked for started');
    assert.ok(mine.at - asked < 300, `at once, not at the next tick: ${mine.at - asked} ms`);
    assert.equal(mostEvals, 3, 'beside the two nobody asked for, in a place of its own');
    // and never more of them than their own places: three asked for at once, two side by side
    let asked2 = 0;
    let mostAsked = 0;
    jobs.handle('eval_run', async (payload) => {
      if (payload.trigger === 'manual') { asked2 += 1; mostAsked = Math.max(mostAsked, asked2); }
      await sleep(payload.trigger === 'manual' ? 150 : 600);
      if (payload.trigger === 'manual') asked2 -= 1;
      return { ok: true };
    });
    for (let i = 0; i < 3; i += 1) await jobs.enqueue('eval_run', { workloadId: `wl_asked_${i}`, trigger: 'manual' });
    jobs.wakeJobs();
    for (let t = 0; t < 100; t += 1) {
      const left = Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'eval_run' AND (payload::jsonb ->> 'trigger') = 'manual'
          AND status IN ('queued', 'claimed')`).get()).n);
      if (!left && asked2 === 0) break;
      await sleep(20);
    }
    assert.equal(mostAsked, config.EVAL_MANUAL_CONCURRENCY, `at most ${config.EVAL_MANUAL_CONCURRENCY} asked for side by side: ${mostAsked}`);
    // the places every other job shares were never exceeded to make room for it
    assert.ok(mostAll - 1 <= config.JOBS_CONCURRENCY, `the shared places held: ${mostAll - 1} of ${config.JOBS_CONCURRENCY}`);
    for (let t = 0; t < 200; t += 1) {
      const left = Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind IN ('test_slow', 'eval_run') AND status IN ('queued', 'claimed')`).get()).n);
      if (!left && evals === 0 && others === 0) break;
      await sleep(25);
    }
  } finally {
    await jobs.stopJobs();
    config.JOBS_ENABLED = false;
    config.JOBS_TICK_MS = was.tick;
  }
});

test('a restart does not start again a measurement a person stopped, nor one something is still running', async () => {
  const t = now();
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, sample_prompt, created_at, updated_at)
                     VALUES ('wl_boot', ?, 'boot', 'fp_boot', 'free_text', ?, 'x', ?, ?)`).run(ws.id, REF, t, t);
  const claimedLongAgo = t - 30 * 60000;
  const job = (id, kind = 'eval_run') => db.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, run_after, claimed_at, created_at)
                     VALUES (?, ?, ?, 'claimed', 1, ?, ?, ?)`).run(id, kind, JSON.stringify({ workloadId: 'wl_boot', n: id }), claimedLongAgo, claimedLongAgo, claimedLongAgo);
  const run = (id, jobId, { stop = null, heartbeat }) => db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind,
                     reference_model, created_at, job_id, stop_requested_at, heartbeat_at)
                     VALUES (?, ?, 'wl_boot', 'running', 'free_text', ?, ?, ?, ?, ?)`).run(id, ws.id, REF, claimedLongAgo, jobId, stop, heartbeat);
  await job('job_boot_stopped');
  await run('run_boot_stopped', 'job_boot_stopped', { stop: t - 20 * 60000, heartbeat: t - 25 * 60000 });
  await job('job_boot_live');
  await run('run_boot_live', 'job_boot_live', { heartbeat: t - 60000 });
  await job('job_boot_dead');
  await run('run_boot_dead', 'job_boot_dead', { heartbeat: t - 25 * 60000 });
  await job('job_boot_other', 'catalog_sync');
  await jobs.requeueStale();
  const status = async (id) => (await db.prepare('SELECT status FROM jobs WHERE id = ?').get(id)).status;
  assert.equal(await status('job_boot_stopped'), 'cancelled', 'a person said stop');
  assert.equal(await status('job_boot_live'), 'claimed', 'something may still be running it');
  assert.equal(await status('job_boot_dead'), 'queued', 'nothing is, so it can go again');
  assert.equal(await status('job_boot_other'), 'queued', 'other work goes back as before');
});

test('a process being stopped hands its measurements over at once, and leaves a stopped one stopped', async () => {
  const t = now();
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, sample_prompt, created_at, updated_at)
                     VALUES ('wl_hand', ?, 'hand', 'fp_hand', 'free_text', ?, 'x', ?, ?)`).run(ws.id, REF, t, t);
  // a stand-in measurement that writes its run and then waits, as a long one does
  let finish = null;
  const started = new Promise((ok) => {
    jobs.handle('eval_run', async (_p, job) => {
      await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, created_at, job_id, heartbeat_at)
                         VALUES (?, ?, 'wl_hand', 'running', 'free_text', ?, ?, ?, ?)`).run(`run_${job.id}`, ws.id, REF, now(), job.id, now());
      ok(job.id);
      await new Promise((r) => { finish = r; });
      return { ok: true };
    });
  });
  await db.prepare(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'claimed')`).run();
  const id = await jobs.enqueue('eval_run', { workloadId: 'wl_hand', trigger: 'manual' });
  const running = jobs.runOnce();
  assert.equal(await started, id);
  assert.equal(await jobs.releaseMine(), 1, 'its job goes back in the queue');
  const run = await db.prepare('SELECT heartbeat_at FROM eval_runs WHERE job_id = ?').get(id);
  assert.equal(Number(run.heartbeat_at), 0, 'and its run reads as nothing running it');
  finish();
  await running;
  assert.equal((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(id)).status, 'queued', 'finishing here does not undo the hand-over');
  // a stopped one is not handed over
  await db.prepare(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'claimed')`).run();
  const stopped = jobs.enqueue('eval_run', { workloadId: 'wl_hand', trigger: 'manual', n: 2 });
  const sid = await stopped;
  const going = jobs.runOnce();
  await new Promise((r) => setTimeout(r, 200));
  await db.prepare('UPDATE eval_runs SET stop_requested_at = ? WHERE job_id = ?').run(now(), sid);
  assert.equal(await jobs.releaseMine(), 0);
  finish();
  await going;
  assert.equal((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(sid)).status, 'done');
});

test('a much shorter model list is kept out the first time, and taken when it comes back the same', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `vendor/m${i}`, name: `m${i}`, context_length: 8192,
    pricing: { prompt: '0.0000001', completion: '0.0000004' } }));
  const row = (m) => ({ model_id: m.id, name: m.name, context_len: 8192, price_in: 1e-7, price_out: 4e-7, open_weights: 0, zdr: 1 });
  const ours = [
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'cheap', context_len: 8192, price_in: 0.1e-6, price_out: 0.4e-6, open_weights: 1, zdr: 1 },
  ];
  await saveCatalog([...many.map(row), ...ours]);
  const count = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get()).n);
  assert.equal(await count(), 32);
  // only this reading runs: anything else waiting is set aside
  await db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'`).run();
  modelList = many.slice(0, 10);
  await jobs.enqueue('catalog_sync', {});
  assert.equal(await jobs.runOnce(), true);
  assert.equal(await count(), 32, 'ten models against thirty two, seen once: kept out');
  const seenOnce = await db.prepare(`SELECT note FROM fact_sync WHERE source = 'catalog_shrink'`).get();
  assert.equal(seenOnce?.note, '10', 'the sighting is kept in the database, so a restart still counts it');
  const again = await db.prepare(`SELECT run_after FROM jobs WHERE kind = 'catalog_sync' AND status = 'queued'`).all();
  assert.equal(again.length, 1, 'one reading booked');
  assert.ok(Number(again[0].run_after) < now() + 20 * 60000, 'and soon');
  const readNow = async () => {
    await db.prepare(`UPDATE jobs SET run_after = ? WHERE kind = 'catalog_sync' AND status = 'queued'`).run(now() - 1000);
    assert.equal(await jobs.runOnce(), true);
  };
  // the whole list comes back: taken, and the earlier sighting goes with it
  modelList = many;
  await readNow();
  assert.equal(await count(), 30);
  assert.equal(await db.prepare(`SELECT 1 FROM fact_sync WHERE source = 'catalog_shrink'`).get(), undefined, 'a full list clears the sighting');
  // so a short list after it is a first sighting again, and kept out
  await saveCatalog([...many.map(row), ...ours]);
  modelList = many.slice(0, 10);
  await readNow();
  assert.equal(await count(), 32, 'not taken on the strength of a sighting from before a full list');
  // the same short list again: the catalogue did shrink, and it is taken
  await readNow();
  assert.equal(await count(), 10, 'taken the second time');
  assert.equal(await db.prepare(`SELECT 1 FROM fact_sync WHERE source = 'catalog_shrink'`).get(), undefined, 'and the sighting is cleared');
  const next = await db.prepare(`SELECT MIN(run_after) AS t FROM jobs WHERE kind = 'catalog_sync' AND status = 'queued'`).get();
  assert.ok(Number(next.t) <= now() + 31 * 60000, 'read again within the half hour, in case it was a mistake');
  // a list that is not much shorter is taken at once, as before
  modelList = many.slice(0, 8);
  await db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'`).run();
  await jobs.enqueue('catalog_sync', {});
  assert.equal(await jobs.runOnce(), true);
  assert.equal(await count(), 8);
  await saveCatalog(ours);
});
