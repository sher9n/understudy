/* The measurement engine, end to end, against a provider we control.

   There is no OpenRouter key on this machine, so the only way to know the engine
   actually works is to stand up a provider that behaves like one and drive the real
   code path through it: sample, replay the reference twice, replay each candidate,
   score, set the bar, pick the cheapest model that cleared, switch. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4791;

/* A database of its own, created here and dropped at the end, so a test run never reads or
   writes the database anybody is developing against. */
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

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation, stopMeasuring, closeAbandoned } = await import('../src/eval/run.js');
const { move, withFee } = await import('../src/billing.js');
const { enqueue } = await import('../src/jobs.js');
const { considerMeasuring } = await import('../src/proxy.js');

await migrate({ quiet: true });

/* How each model behaves. The reference is slightly unstable with itself, which is what
   creates the bar; one candidate is steadier and cheaper, one drifts badly. */
const BEHAVIOUR = {
  'openai/gpt-5.4': (i, call) => ({ total: 100 + i, currency: 'USD', lines: call === 2 && i % 20 === 0 ? 9 : (i % 5) + 1 }),
  'vendor/steady-small': (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }),
  'vendor/drifty-small': (i) => ({ total: 999, currency: 'EUR', lines: 0 }),
};

let seen = 0;
/* While this is set, the provider holds every answer until it resolves, so a test can know a
   measurement is mid-flight at the moment it asks it to stop. */
let hold = null;
let held = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (hold) { held += 1; await hold; }
    const payload = JSON.parse(body || '{}');
    const model = payload.model;
    // the marker the request carries tells us which sampled call this is
    const text = payload.messages.find((m) => m.role === 'user')?.content || '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    seen += 1;
    const call = (BEHAVIOUR[model] === BEHAVIOUR['openai/gpt-5.4']) ? (seen % 2 === 0 ? 2 : 1) : 1;
    const answer = BEHAVIOUR[model] ? BEHAVIOUR[model](i, call) : { total: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gen-${seen}`,
      model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 800, completion_tokens: 60, cost: model.includes('steady') ? 0.0002 : 0.002 },
    }));
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

test('a full measurement run sets a bar, scores every candidate, and switches', async () => {
  const { workspace } = await createAccount({
    email: `e2e-${process.pid}@understudy.dev`, password: 'correct-horse', name: 'E2E',
  });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });

  await saveCatalog([
    { model_id: 'openai/gpt-5.4', name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: 'vendor/steady-small', name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/drifty-small', name: 'drifty', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
  ]);

  // 200 calls of one workload, spread over a fortnight so a monthly cost can be projected
  const DAY = 86400000;
  let workload = null;
  for (let i = 0; i < 200; i += 1) {
    const request = {
      model: 'openai/gpt-5.4',
      messages: [
        { role: 'system', content: `Extract the totals from invoice ${900000 + i}.` },
        { role: 'user', content: `document #${i}` },
      ],
      response_format: { type: 'json_object' },
    };
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace',
      requestedModel: 'openai/gpt-5.4', servedModel: 'openai/gpt-5.4', statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0.002,
      request, response: { choices: [{ message: { content: '{}' } }] },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ?')
    .run(now() - 14 * DAY, workload.id);

  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, `the run did not finish: ${JSON.stringify(out)}`);

  // the bar comes from the reference disagreeing with itself, and never drops below 3%
  assert.ok(out.floor >= 3, `bar should be at least the 3% minimum, got ${out.floor}`);

  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.outcome, 'compared', 'a run that tried models says so');
  assert.equal(run.sample_size, 100);

  const all = await db.prepare('SELECT * FROM eval_results WHERE run_id = ? ORDER BY model_id').all(out.runId);
  const results = all.filter((r) => r.verdict !== 'reference');
  assert.equal(results.length, 2, 'both candidates should have been tried');
  // the reference is recorded too, so every screen can compare against what it costs
  const ref = all.find((r) => r.verdict === 'reference');
  assert.ok(ref, 'the reference model should be recorded on the run');
  assert.equal(ref.model_id, 'openai/gpt-5.4');
  assert.ok(ref.cost_month_usd > 0, 'the reference should carry a monthly cost');

  const steady = results.find((r) => r.model_id === 'vendor/steady-small');
  const drifty = results.find((r) => r.model_id === 'vendor/drifty-small');

  assert.equal(steady.runs, 100, 'every sampled call should have been replayed');
  assert.equal(steady.verdict, 'cleared', `the steady model should clear, got ${steady.gap_pct}% against ${out.floor}%`);
  assert.equal(drifty.verdict, 'missed', `the drifting model should miss, got ${drifty.gap_pct}%`);
  assert.ok(drifty.gap_pct > steady.gap_pct, 'the drifting model must score worse');
  assert.ok(steady.cost_month_usd < (drifty.cost_month_usd ?? Infinity) * 100, 'a monthly cost should be projected');

  // auto is the default, so the cheapest model that cleared is already serving
  const after = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  assert.equal(after.routed_model, 'vendor/steady-small', 'the workload should have switched on its own');
  assert.equal(after.status, 'promoted');

  const promo = await db.prepare('SELECT * FROM promotions WHERE workload_id = ?').get(workload.id);
  assert.equal(promo.action, 'promote');
  assert.equal(promo.to_model, 'vendor/steady-small');

  // the replays were paid for out of the balance, the same way real traffic is
  const charged = (await db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger
                               WHERE workspace_id = ? AND kind = 'eval'`).get(workspace.id)).s;
  assert.ok(charged < 0, 'measuring should have been charged');
});

/* Stopping ----------------------------------------------------------------------------- */

const MIN = 60000;

/** A workspace of its own with one measurable workload, the same shape as the one above. */
async function seed(tag) {
  const { workspace } = await createAccount({
    email: `e2e-${tag}-${process.pid}@understudy.dev`, password: 'correct-horse', name: tag,
  });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  let workload = null;
  for (let i = 0; i < 200; i += 1) {
    const request = {
      model: 'openai/gpt-5.4',
      messages: [
        { role: 'system', content: `Extract the totals from invoice ${900000 + i}.` },
        { role: 'user', content: `document #${i}` },
      ],
      response_format: { type: 'json_object' },
    };
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace',
      requestedModel: 'openai/gpt-5.4', servedModel: 'openai/gpt-5.4', statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0.002,
      request, response: { choices: [{ message: { content: '{}' } }] },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ?').run(now() - 14 * 86400000, workload.id);
  return { workspace, workload };
}

const load = async (workloadId) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(workloadId);

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waited too long');
}

test('a running measurement stops when asked, pays only for what ran, and switches nothing', async () => {
  const { workspace, workload } = await seed('stop');

  let release;
  hold = new Promise((r) => { release = r; });
  held = 0;
  const running = runEvaluation(workload.id);
  // mid-flight for certain: the run exists and its first call is waiting on the provider
  await until(async () => held > 0 && !!await db.prepare(
    `SELECT 1 FROM eval_runs WHERE workload_id = ? AND status = 'running'`).get(workload.id));
  assert.equal((await load(workload.id)).status, 'measuring', 'a running workload says so');

  const asked = await stopMeasuring(await load(workload.id), { actorUserId: 'usr_test' });
  assert.equal(asked.state, 'stopping', 'a live run is asked to stop, not killed');
  hold = null;
  release();
  const out = await running;
  assert.equal(out.stopped, true, `the run should have stopped: ${JSON.stringify(out)}`);

  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.outcome, 'stopped');
  assert.equal(run.stopped_by, 'usr_test');
  assert.equal(run.phase, null, 'a stopped run says nothing is happening');
  assert.ok(run.steps_done > 0 && run.steps_done < run.steps_total,
    `it stopped part way, at ${run.steps_done} of ${run.steps_total}`);

  // the call in flight came back and was counted, and the ledger holds exactly that, with the fee
  assert.ok(run.spend_usd > 0, 'the calls that ran were paid for');
  const charged = (await db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger
                               WHERE workspace_id = ? AND kind = 'eval'`).get(workspace.id)).s;
  assert.ok(Math.abs(-charged - withFee(run.spend_usd)) < 1e-7,
    `charged ${-charged}, should be what ran plus the fee, ${withFee(run.spend_usd)}`);
  const replays = (await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'replay'`)
    .get(workload.id)).n;
  assert.equal(replays, run.steps_done, 'nothing more was sent once the stop was seen');

  const after = await load(workload.id);
  assert.equal(after.routed_model, null, 'a stopped run switches nothing');
  assert.equal(after.status, 'new', 'and the workload goes back to what it was, not "Measuring"');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n, 0);
  const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(workload.id);
  assert.match(said.title, /stopped/);

  // the next call of a stopped workload must not start it again behind the person's back
  const before = (await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'eval_run'`).get()).n;
  await considerMeasuring(workspace.id, after);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'eval_run'`).get()).n, before);
});

test('a measurement a restart left behind is closed the moment somebody stops it', async () => {
  const { workspace, workload } = await seed('orphan');
  const t = now();
  // as a deploy leaves one: still "running", and not heard from in twenty minutes
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, heartbeat_at, steps_total, steps_done)
              VALUES ('run_orphan_stop', ?, ?, 'running', 'json', 'openai/gpt-5.4', 100, ?, ?, ?, 300, 40)`)
    .run(workspace.id, workload.id, t - 25 * MIN, t - 25 * MIN, t - 20 * MIN);
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  await db.prepare(`UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE kind = 'eval_run'
              AND (payload::jsonb ->> 'workloadId') = ?`).run(t - 25 * MIN, workload.id);
  await db.prepare(`UPDATE workloads SET status = 'measuring' WHERE id = ?`).run(workload.id);

  const out = await stopMeasuring(await load(workload.id));
  assert.equal(out.state, 'stopped', 'nothing would ever answer a stop request, so it is closed now');
  const run = await db.prepare(`SELECT * FROM eval_runs WHERE id = 'run_orphan_stop'`).get();
  assert.equal(run.status, 'stopped');
  assert.equal(run.outcome, 'stopped');
  assert.equal((await load(workload.id)).status, 'new');
  // and its job leaves the queue, or the next restart would put it back and start again
  const job = await db.prepare(`SELECT status FROM jobs WHERE kind = 'eval_run'
                AND (payload::jsonb ->> 'workloadId') = ?`).get(workload.id);
  assert.equal(job.status, 'cancelled');
});

test('a measurement nothing is running any more is closed without anybody asking', async () => {
  const { workspace, workload } = await seed('sweep');
  const t = now();
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model,
              sample_size, created_at, started_at, heartbeat_at, steps_total, steps_done)
              VALUES ('run_orphan_sweep', ?, ?, 'running', 'json', 'openai/gpt-5.4', 100, ?, ?, ?, 300, 40),
                     ('run_alive_sweep', ?, ?, 'running', 'json', 'openai/gpt-5.4', 100, ?, ?, ?, 300, 12)`)
    .run(workspace.id, workload.id, t - 40 * MIN, t - 40 * MIN, t - 30 * MIN,
         workspace.id, workload.id, t - 2 * MIN, t - 2 * MIN, t - 5000);

  assert.equal(await closeAbandoned(workload.id), 1, 'only the one gone quiet is closed');
  const gone = await db.prepare(`SELECT * FROM eval_runs WHERE id = 'run_orphan_sweep'`).get();
  assert.equal(gone.status, 'failed');
  assert.equal(gone.outcome, 'interrupted');
  const alive = await db.prepare(`SELECT status FROM eval_runs WHERE id = 'run_alive_sweep'`).get();
  assert.equal(alive.status, 'running', 'a run that wrote a heartbeat seconds ago is left alone');
  await db.prepare(`UPDATE eval_runs SET status = 'failed' WHERE id = 'run_alive_sweep'`).run();
});

test('a stop that lands while a measurement is being picked up ends it before anything is sent', async () => {
  const { workload } = await seed('pickup');
  // claimed by the runner, then cancelled by a stop, before the run existed to be asked
  const jobId = await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  await db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(jobId);
  const out = await runEvaluation(workload.id, { jobId });
  assert.equal(out.stopped, true, JSON.stringify(out));
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.steps_done, 0);
  const sent = (await db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND source = 'replay'`)
    .get(workload.id)).n;
  assert.equal(sent, 0, 'not one call was sent');
  assert.equal((await load(workload.id)).status, 'new');
});

test('stopping a measurement that has not started takes it out of the queue', async () => {
  const { workload } = await seed('queued');
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' }, { unique: true });
  await db.prepare(`UPDATE workloads SET status = 'measuring' WHERE id = ?`).run(workload.id);

  const out = await stopMeasuring(await load(workload.id));
  assert.equal(out.state, 'cancelled');
  const job = await db.prepare(`SELECT status FROM jobs WHERE kind = 'eval_run'
                AND (payload::jsonb ->> 'workloadId') = ?`).get(workload.id);
  assert.equal(job.status, 'cancelled');
  assert.equal((await load(workload.id)).status, 'new', 'no longer "Measuring", because nothing will');
});
