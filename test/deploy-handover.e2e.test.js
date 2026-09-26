/* A test running when its process goes: a deploy asking it to stop, or a kill or a crash that asks nothing.

   Asked, the process hands it over: it stops at its next step, is charged for what it ran, gives back what it set aside,
   and its job goes back in the queue, which the next process takes up at once, closing the old run as restarted and
   starting again with every answer already paid for. Not asked, the next process finds it by the silence of its
   heartbeat, which a living process keeps fresh however slow the call it waits on, and does the same within minutes.

   Driven through the real queue and the real measurement against a provider stood up here. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4941;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_handover_${process.pid}`;
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
process.env.CONTROL_ENABLED = 'false';
// a heartbeat every fifth of a second, so a test can watch a living process keep one fresh
process.env.EVAL_BEAT_SEC = '0.2';

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const run = await import('../src/eval/run.js');
const jobs = await import('../src/jobs.js');
const { move } = await import('../src/billing.js');
const { pageOf } = await import('../src/workloadPage.js');
// the server registers what an eval_run job does (and migrates), as the running app does
await import('../src/server.js');

await migrate({ quiet: true });

const { runEvaluation, handOver, resumeAfterHandOver, closeAbandoned, stopMeasuring } = run;
const { HANDED_OVER, HANDED_OVER_DEPLOY, HANDED_OVER_SILENT } = jobs;
const REF = 'openai/gpt-5.4';
const STEADY = 'vendor/steady-small';
const DAY = 86400000;

/* The provider: the customer's model disagrees with itself now and then, one candidate is steady and cheap. Every
   answer takes `delayMs`, so a measurement lasts long enough to be handed over part way; while `paused` is set every
   answer waits for it, which is a call that never comes back until the test says so. */
const BEHAVIOUR = {
  [REF]: (i, call) => ({ total: 100 + i, currency: 'USD', lines: call === 2 && i % 10 === 0 ? 9 : (i % 5) + 1 }),
  [STEADY]: (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }),
};
const asksOf = new Map();
let paused = null;
let delayMs = 0;
let seen = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (paused) await paused;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: STEADY, name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

let seq = 0;
async function account(credit = 50) {
  seq += 1;
  const { workspace } = await createAccount({ email: `handover-${seq}-${process.pid}@example.test`, password: 'correct-horse-battery', name: `h${seq}` });
  if (credit > 0) await move(workspace.id, { kind: 'credit', amountUsd: credit, note: 'test' });
  return workspace;
}

// two hundred calls of one workload over a fortnight, as real traffic arrives
async function workloadWithCalls(ws, n = 200) {
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
      requestedModel: REF, servedModel: REF, statusCode: 200, promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0.002,
      request, response: { choices: [{ message: { content: JSON.stringify({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 }) } }] },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14) * 86400000 WHERE workload_id = ?').run(now() - DAY, workload.id);
  return db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
}
const heldFor = async (wsId) => Number((await db.prepare(
  'SELECT COALESCE(SUM(amount_usd), 0) AS s FROM balance_holds WHERE workspace_id = ? AND expires_at > ?').get(wsId, now())).s);
const until = async (what, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await what();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const clearQueue = () => db.prepare(`UPDATE jobs SET status = 'done' WHERE status IN ('queued', 'claimed')`).run();

test('a test running when its process is asked to stop is handed over, and the next process starts it again at once', async () => {
  const ws = await account(50);
  const w = await workloadWithCalls(ws);
  await clearQueue();
  const jobId = await jobs.enqueue('eval_run', { workloadId: w.id, trigger: 'manual' });
  delayMs = 25;
  try {
    // the old process takes the job up and gets part way
    const first = jobs.runOnce();
    const r0 = await until(() => db.prepare(`SELECT * FROM eval_runs WHERE job_id = ? AND steps_done >= 30`).get(jobId));
    const left = await handOver({ waitMs: 15000 });
    assert.equal(left, 0, 'every measurement here ended within the wait');
    await first;
    const old = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(r0.id);
    assert.equal(old.status, 'running', 'left for the next process to close');
    assert.equal(Number(old.heartbeat_at), 0, 'with nothing running it');
    assert.equal(old.error, HANDED_OVER_DEPLOY);
    assert.ok(Number(old.spend_usd) > 0, 'what it ran is charged');
    const charged = await db.prepare(`SELECT COUNT(*)::int AS n FROM ledger WHERE workspace_id = ? AND kind = 'eval'`).get(ws.id);
    assert.ok(charged.n > 0, 'on the ledger');
    assert.equal(await heldFor(ws.id), 0, 'what it set aside is given back');
    const job = await db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(jobId);
    assert.deepEqual([job.status, job.error], ['queued', HANDED_OVER_DEPLOY], 'its job is back in the queue');
    // nothing here writes its heartbeat again, which would say this process still runs it
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(Number((await db.prepare('SELECT heartbeat_at FROM eval_runs WHERE id = ?').get(r0.id)).heartbeat_at), 0);

    /* the next process's sweep of runs nothing is running may close the old run just as that process takes the job up
       (both happen at its boot): the job stays with the process that took it, not ended under it */
    await db.prepare(`UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ?`).run(now(), jobId);
    assert.equal(await closeAbandoned(w.id), 1, 'the sweep closes the handed-over run');
    assert.equal((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).status, 'claimed', 'and leaves its job alone');
    await db.prepare(`UPDATE jobs SET status = 'queued' WHERE id = ?`).run(jobId);

    // the next process takes the job up
    resumeAfterHandOver();
    assert.equal(await jobs.runOnce(), true);
    const closed = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(r0.id);
    assert.deepEqual([closed.status, closed.outcome], ['failed', 'interrupted']);
    assert.ok(String(closed.error).startsWith(HANDED_OVER));
    const again = await db.prepare(`SELECT * FROM eval_runs WHERE job_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1`).get(jobId, r0.id);
    assert.equal(again.status, 'done', 'the same job measured it again, to the end');
    assert.ok(Number(again.reused) > 0, `using again what the first run paid for (${again.reused} answers)`);
    assert.equal((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).status, 'done');
    const said = await db.prepare(`SELECT title, detail FROM activity WHERE workspace_id = ? AND title LIKE 'Testing % is starting again after a restart'`).all(ws.id);
    assert.equal(said.length, 1);
    assert.match(said[0].detail, /uses again the answers it had already paid for\. Nothing was switched\./);
    const page = await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
    const row = page.measurements.find((m) => m.id === r0.id);
    assert.equal(row.tag.text, 'Restarted');
    // a restart is no failure: the next test nobody asks for is not put off for it
    const failures = await db.prepare(`SELECT COUNT(*)::int AS n FROM eval_runs WHERE workload_id = ? AND status = 'failed' AND COALESCE(error, '') NOT LIKE ?`).get(w.id, `${HANDED_OVER}%`);
    assert.equal(failures.n, 0);
  } finally {
    resumeAfterHandOver();
    delayMs = 0;
  }
});

test("a person's Stop that arrives while a process hands over still ends the test as stopped", async () => {
  const ws = await account(50);
  const w = await workloadWithCalls(ws);
  await clearQueue();
  const jobId = await jobs.enqueue('eval_run', { workloadId: w.id, trigger: 'manual' });
  let release = null;
  try {
    const first = jobs.runOnce();
    await until(() => db.prepare(`SELECT 1 FROM eval_runs WHERE job_id = ? AND status = 'running'`).get(jobId));
    // calls are out and waiting when both arrive: the person's Stop, then the hand over
    paused = new Promise((r) => { release = r; });
    await new Promise((r) => setTimeout(r, 100));
    await stopMeasuring(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(w.id));
    const waiting = handOver({ waitMs: 15000 });
    paused = null;
    release();
    assert.equal(await waiting, 0);
    await first;
    const r = await db.prepare('SELECT status, outcome FROM eval_runs WHERE job_id = ?').get(jobId);
    assert.deepEqual([r.status, r.outcome], ['stopped', 'stopped'], 'a stop is a stop');
    assert.notEqual((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).status, 'queued', 'and it is not started again');
    assert.equal(await heldFor(ws.id), 0);
  } finally {
    resumeAfterHandOver();
    if (release) release();
    paused = null;
  }
});

test('a test whose process was killed goes back in the queue once it is silent, and one alive or stopped is left be', async () => {
  const ws = await account(10);
  const w = await workloadWithCalls(ws, 20);
  await clearQueue();
  const t = now();
  const silent = t - (config.EVAL_SILENT_SEC + 30) * 1000;
  const make = async (name, { heartbeat, attempts = 1, stop = null }) => {
    const jid = `job_${name}_${process.pid}`;
    await db.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, run_after, claimed_at, created_at)
        VALUES (?, 'eval_run', ?, 'claimed', ?, ?, ?, ?)`).run(jid, JSON.stringify({ workloadId: w.id, trigger: 'manual', n: name }), attempts, t - 60000, t - 60000, t - 60000);
    const rid = `run_${name}_${process.pid}`;
    await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size,
        created_at, started_at, heartbeat_at, steps_total, steps_done, job_id, stop_requested_at)
        VALUES (?, ?, ?, 'running', 'json', ?, 100, ?, ?, ?, 300, 40, ?, ?)`).run(rid, ws.id, w.id, REF, t - 60000, t - 60000, heartbeat, jid, stop);
    return { jid, rid };
  };
  const dead = await make('dead', { heartbeat: silent });
  const alive = await make('alive', { heartbeat: t - 20000 });
  const stopped = await make('stopped', { heartbeat: silent, stop: t - 90000 });
  const looping = await make('looping', { heartbeat: silent, attempts: 5 });
  await closeAbandoned();
  const runOf = (x) => db.prepare('SELECT status, outcome, error FROM eval_runs WHERE id = ?').get(x.rid);
  const jobOf = async (x) => (await db.prepare('SELECT status FROM jobs WHERE id = ?').get(x.jid)).status;
  // killed: closed as restarted, and its job back in the queue to start it again
  assert.equal((await runOf(dead)).error, HANDED_OVER_SILENT);
  assert.deepEqual([(await runOf(dead)).status, (await runOf(dead)).outcome], ['failed', 'interrupted']);
  assert.equal(await jobOf(dead), 'queued');
  // heard from twenty seconds ago: something is running it
  assert.equal((await runOf(alive)).status, 'running');
  assert.equal(await jobOf(alive), 'claimed');
  // a person stopped it: ended as stopped, not started again
  assert.equal((await runOf(stopped)).status, 'stopped');
  assert.notEqual(await jobOf(stopped), 'queued');
  // taken up five times already: a measurement that takes its process down is ended, not started a sixth time
  assert.deepEqual([(await runOf(looping)).status, (await runOf(looping)).error], ['failed', 'interrupted']);
  assert.equal(await jobOf(looping), 'failed');
  const said = await db.prepare(`SELECT title FROM activity WHERE workspace_id = ? AND title LIKE '% after a restart'`).all(ws.id);
  assert.equal(said.length, 1, 'only the killed one says it starts again');
  await db.prepare(`UPDATE eval_runs SET status = 'failed' WHERE id = ?`).run(alive.rid);
});

test('a living process keeps its test heard from while it waits on a slow call', async () => {
  const ws = await account(50);
  const w = await workloadWithCalls(ws);
  let release = null;
  try {
    paused = new Promise((r) => { release = r; });
    const going = runEvaluation(w.id);
    const r0 = await until(() => db.prepare(`SELECT id FROM eval_runs WHERE workload_id = ? AND status = 'running'`).get(w.id));
    // every call is waiting; nothing the measurement does writes a heartbeat now, only the process's beat
    await new Promise((r) => setTimeout(r, 300));
    const before = Number((await db.prepare('SELECT heartbeat_at FROM eval_runs WHERE id = ?').get(r0.id)).heartbeat_at);
    await new Promise((r) => setTimeout(r, 700));
    const after = Number((await db.prepare('SELECT heartbeat_at FROM eval_runs WHERE id = ?').get(r0.id)).heartbeat_at);
    assert.ok(after > before, `the beat moved it on (${before} to ${after})`);
    assert.equal(run.isAbandoned({ heartbeat_at: after }), false);
    paused = null;
    release();
    const out = await going;
    assert.equal(out.ok, true, JSON.stringify(out));
  } finally {
    if (release) release();
    paused = null;
  }
});
