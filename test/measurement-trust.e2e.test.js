/* Measurements that can be trusted and that cost what they are worth, end to end: a provider and a
   judge we control, a real database, the real measurement.

   What is checked here is what the platform promises about a measurement: the customer's own
   recorded answers are used rather than paid for again; nothing is switched on one lucky look; only a
   model that can be shown cheaper is switched to; a measurement nobody asked for runs only when it can
   show something and pays for itself; re-checks space out and come forward when something changes;
   calls are grouped into the workloads the customer means; written work with no one right answer is
   held to "at least as good"; and other workspaces' results only help where they said they may. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4811;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_trust_${process.pid}`;
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
process.env.MEASURE_READY_CHECK_MS = '0';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { move } = await import('../src/billing.js');
const { promote } = await import('../src/eval/promote.js');
const { scheduleNext, deferAutomatic, nudgeForCatalog, dueForRecheck } = await import('../src/eval/schedule.js');
const { calibrationFor, calibrated, forgetCalibration } = await import('../src/eval/calibrate.js');
const { planFor, barNeed } = await import('../src/eval/plan.js');
const { considerMeasuring, convertWaits, startWaiting, waitAfterSmall } = await import('../src/proxy.js');
const { valueOf } = await import('../src/eval/value.js');
const { enqueue } = await import('../src/jobs.js');
const { forgetFacts } = await import('../src/models/facts.js');

await migrate({ quiet: true });

const DAY = 86400000;
const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const words = (n, seed) => Array.from({ length: n }, (_, k) => `word${(seed * 31 + k * 7) % 97}`).join(' ');

// how many times each model has been asked each call
const asks = new Map();
const judged = { quality: 0, agreement: 0 };
const BEHAVIOUR = {
  'openai/gpt-5.4': (i) => right(i),
  'vendor/steady-small': (i) => right(i),
  // right on its first hundred calls, then wrong on one call in five: a lucky first look
  'vendor/lucky-small': (i, n) => (n > 100 && i % 5 === 0 ? { ...right(i), total: 0 } : right(i)),
  'acme/unlisted': (i) => right(i),
  // wrong on every call: it cannot win, and is dropped once it shows it
  'vendor/wrong-small': (i) => ({ ...right(i), total: -1 }),
  // right on every call, and listed far cheaper than it charges: a measurement quoted low that spends more
  'vendor/pricey-small': (i) => right(i),
};
// a delay before a model answers, so its calls can be seen out at once, and how many of each model's are out
const delayFor = new Map();
const inflight = new Map();
const mostOut = new Map();
/* The two looks counted apart for a model that answers every call: its first look asks exactly the sample's calls,
   so the ones after that many are its second look (the two never overlap). */
const firstLook = new Map();
const nthOf = new Map();
const mostOutFirst = new Map();
const mostOutSecond = new Map();
const fenced = (text, label) => (text.match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    const model = p.model;
    const sys = p.messages?.find((m) => m.role === 'system')?.content || '';
    const user = p.messages?.find((m) => m.role === 'user')?.content || '';
    inflight.set(model, (inflight.get(model) || 0) + 1);
    mostOut.set(model, Math.max(mostOut.get(model) || 0, inflight.get(model)));
    if (firstLook.has(model)) {
      const nth = (nthOf.get(model) || 0) + 1;
      nthOf.set(model, nth);
      const most = nth > firstLook.get(model) ? mostOutSecond : mostOutFirst;
      most.set(model, Math.max(most.get(model) || 0, inflight.get(model)));
    }
    const send = (content, cost = 0.0001) => {
      const go = () => {
        inflight.set(model, inflight.get(model) - 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 800, completion_tokens: 60, cost: model === 'vendor/pricey-small' ? 0.01 : cost } }));
      };
      if (delayFor.get(model)) setTimeout(go, delayFor.get(model)); else go();
    };
    if (model === 'judge/small') {
      // the quality judge: a clearly shorter answer is worse, otherwise a tie
      if (String(sys).includes('say which one serves')) {
        judged.quality += 1;
        const a = fenced(user, 'FIRST');
        const b = fenced(user, 'SECOND');
        if (a.length > b.length * 1.6) return send('FIRST');
        if (b.length > a.length * 1.6) return send('SECOND');
        return send('TIE');
      }
      // the agreement judge: two poems are never the same poem
      judged.agreement += 1;
      return send('DIFFERENT');
    }
    const text = typeof user === 'string' ? user : '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    const key = `${model}#${i}`;
    asks.set(model, (asks.get(model) || 0) + 1);
    asks.set(key, (asks.get(key) || 0) + 1);
    // written work: a different forty-word poem every time it is asked
    if (String(text).startsWith('Write a poem')) return send(words(40, asks.get(key) * 13 + i), model.includes('small') ? 0.0002 : 0.002);
    const f = BEHAVIOUR[model] || (() => ({ total: 0 }));
    return send(JSON.stringify(f(i, asks.get(model))), model.includes('small') ? 0.0002 : 0.002);
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await saveCatalog([
    { model_id: 'openai/gpt-5.4', name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: 'vendor/steady-small', name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/lucky-small', name: 'lucky', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/poet-small', name: 'poet', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
    { model_id: 'judge/small', name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
    { model_id: 'vendor/wrong-small', name: 'wrong', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
    { model_id: 'vendor/pricey-small', name: 'pricey', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
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
/** A workspace with one workload: `n` calls, recorded the way the customer's own model answered them. */
async function seed({ n = 200, model = 'openai/gpt-5.4', days = 14, enabled = null, mode = 'auto', poem = false } = {}) {
  seq += 1;
  const { workspace } = await createAccount({ email: `trust-${seq}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `t${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(mode, workspace.id);
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const request = poem
      ? { model, messages: [{ role: 'system', content: 'You are a poet.' }, { role: 'user', content: `Write a poem about the sea, #${i}` }] }
      : { model, messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}, set ${seq}.` }, { role: 'user', content: `document #${i}` }],
        response_format: { type: 'json_object' } };
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: model, servedModel: model, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0,
      request, response: { choices: [{ message: { content: poem ? words(40, i) : JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
    });
  }
  // spread over the days, as real traffic is
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % ?::int)::bigint * 86400000 WHERE workload_id = ?')
    .run(now() - DAY, days, workload.id);
  if (enabled) {
    for (const m of ['vendor/steady-small', 'vendor/lucky-small', 'vendor/poet-small', 'judge/small', 'vendor/wrong-small', 'vendor/pricey-small']) {
      await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, enabled.includes(m) ? 1 : 0, now());
    }
  }
  return { workspace, workload: await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id) };
}
const load = (id) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(id);
const results = (runId) => db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId);
const resultOf = async (runId, model) => (await results(runId)).find((r) => r.model_id === model);

test('the customer\'s own recorded answer is one of the bar\'s two, and only one is paid for', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'] });
  const before = asks.get('openai/gpt-5.4') || 0;
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.recorded_refs >= run.sample_size, true, `recorded answers used: ${run.recorded_refs} of ${run.sample_size}`);
  // the bar asked the customer's model once per sampled call, and the second look once per fresh call
  const asked = (asks.get('openai/gpt-5.4') || 0) - before;
  const steady = (await results(out.runId)).find((r) => r.model_id === 'vendor/steady-small');
  assert.equal(steady.verdict, 'cleared');
  assert.ok(asked <= run.sample_size + (steady.confirm_runs || 0) + 2, `the customer's model was asked ${asked} times`);
  assert.ok(run.quote_usd > 0, 'the quote is kept beside what was spent');
});

test('a model that clears on one lucky look is not switched: the second look on fresh calls catches it', async () => {
  const { workload } = await seed({ enabled: ['vendor/lucky-small'] });
  asks.set('vendor/lucky-small', 0);
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const lucky = (await results(out.runId)).find((r) => r.model_id === 'vendor/lucky-small');
  assert.equal(lucky.verdict, 'cleared', `its first look: ${lucky.gap_pct}%`);
  assert.notEqual(lucky.confirm_verdict, 'cleared', `its second look: ${lucky.confirm_gap}%, at most ${lucky.confirm_hi}%`);
  assert.ok(lucky.confirm_runs >= 88, `a second look as large as the first: ${lucky.confirm_runs}`);
  const w = await load(workload.id);
  assert.equal(w.routed_model, null, 'nothing is switched on one look');
  assert.equal(w.status_note, 'A candidate cleared once and needs a second look');
  const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 3`).all(workload.id);
  assert.ok(said.some((a) => /cleared your bar .* once/.test(a.title)), JSON.stringify(said));
});

test('a model that clears is not switched to when the customer\'s own model has no price to hold it against', async () => {
  const { workload } = await seed({ model: 'acme/unlisted', enabled: ['vendor/steady-small'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const steady = (await results(out.runId)).find((r) => r.model_id === 'vendor/steady-small');
  assert.equal(steady?.verdict, 'cleared');
  assert.equal((await load(workload.id)).routed_model, null, 'nothing is shown cheaper, so nothing is switched');
  const said = await db.prepare(`SELECT title, detail FROM activity WHERE workload_id = ? AND title LIKE '%cannot be switched to%'`).all(workload.id);
  assert.equal(said.length, 1, 'and it says why');
  assert.match(said[0].detail, /could not price acme\/unlisted/);
});

test('a measurement nobody asked for waits until it could show anything, and costs nothing to turn down', async () => {
  const { workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  const runsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM eval_runs').get()).n;
  const out = await runEvaluation(workload.id, { trigger: 'automatic' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Waiting for more calls/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM eval_runs').get()).n, runsBefore, 'no run, and nothing spent');
  const w = await load(workload.id);
  assert.ok(w.recheck_after > now(), 'looked at again later, not every hour');
  // a person can always ask
  const plan = await planFor(w, { canRoute: true });
  assert.equal(plan.notWorth, false);
});


/* More calls for a workload, recorded as its own are, then moved to one day, so the count a measurement draws on
   (every usable call, however many a day) is known exactly. */
async function addCalls(workspace, workload, count, daysAgo) {
  for (let i = 0; i < count; i += 1) {
    const request = { model: 'openai/gpt-5.4', messages: [{ role: 'user', content: `document #${daysAgo}-${i}-${Math.random()}` }],
      response_format: { type: 'json_object' } };
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: 'openai/gpt-5.4', servedModel: 'openai/gpt-5.4',
      statusCode: 200, promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0,
      request, response: { choices: [{ message: { content: JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare(`UPDATE calls SET created_at = ? WHERE id IN (SELECT id FROM calls WHERE workload_id = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT ?)`).run(now() - daysAgo * DAY, workload.id, now() - 5 * 60000, count);
}
const queuedFor = async (workloadId) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'eval_run' AND status = 'queued'
    AND (payload::jsonb ->> 'workloadId') = ?`).get(workloadId)).n);
const cancelFor = (workloadId) => db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE kind = 'eval_run' AND status = 'queued'
    AND (payload::jsonb ->> 'workloadId') = ?`).run(workloadId);

test('a measurement waiting for calls starts on the call that brings them, never at a guess of when that will be', async () => {
  const { workspace, workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  const out = await runEvaluation(workload.id, { trigger: 'first' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Waiting for more calls/);
  let w = await load(workload.id);
  // structured answers are first held to a 3% bar: 88 in a sample clear it, which 176 usable calls give
  const need = barNeed(w).calls;
  assert.equal(need, 176);
  assert.equal(Number(w.measure_at_calls), need, 'it keeps the count it waits for');
  assert.ok(Number(w.recheck_after) > now() + 6 * DAY, `and a far booking, only in case its calls stop coming: ${(w.recheck_after - now()) / DAY} days`);
  const v = await valueOf(w);
  assert.equal(v.tests.need, 176, 'the page says how many');
  assert.equal(v.tests.have, 40, 'and how many there are');

  // the calls arrive, most of them on one day: every one counts, however many a day brings
  await addCalls(workspace, workload, 125, 20);
  await addCalls(workspace, workload, 10, 21);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 0, 'one call short: nothing yet');
  assert.equal((await valueOf(await load(workload.id))).tests.have, 175, 'a busy day is counted whole, not held to 60');
  // the call that brings the count, on the day that already brought 125
  await addCalls(workspace, workload, 1, 20);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 1, 'started by that call');
  w = await load(workload.id);
  assert.equal(w.measure_at_calls, null, 'and waits for nothing more');
  assert.ok(Math.abs(Number(w.recheck_after) - (now() + 3600000)) < 60000, 'held for the hour it takes to start');
  const job = await db.prepare(`SELECT payload FROM jobs WHERE kind = 'eval_run' AND status = 'queued' AND (payload::jsonb ->> 'workloadId') = ?`).get(workload.id);
  assert.equal(JSON.parse(job.payload).trigger, 'first', 'as the first measurement of a new workload');
  await cancelFor(workload.id);

  // calls arriving together, or on two servers, start it once
  await db.prepare('UPDATE workloads SET measure_at_calls = ? WHERE id = ?').run(need, workload.id);
  const fresh = await load(workload.id);
  await Promise.all([considerMeasuring(workspace.id, fresh), considerMeasuring(workspace.id, fresh), considerMeasuring(workspace.id, fresh)]);
  assert.equal(await queuedFor(workload.id), 1, 'once');
  await cancelFor(workload.id);
});

test('a workspace that measures only when asked never starts a waiting workload by itself', async () => {
  const { workspace, workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workloads SET measure_at_calls = 30, recheck_after = ? WHERE id = ?').run(now() + 30 * DAY, workload.id);
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(workspace.id);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 0, 'only when asked means only when asked');
  await db.prepare('UPDATE workspaces SET measure_every_days = 7 WHERE id = ?').run(workspace.id);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 1, 'measuring by itself again, it starts');
  await cancelFor(workload.id);
});

test('the last call of a burst starts a waiting workload, even when no call comes after it', async () => {
  const { workspace, workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workloads SET measure_at_calls = 45, recheck_after = ? WHERE id = ?').run(now() + 30 * DAY, workload.id);
  const was = config.MEASURE_READY_CHECK_MS;
  // a wait long enough that the whole burst lands inside it however slow this machine is
  config.MEASURE_READY_CHECK_MS = 2500;
  try {
    // the first call of the burst has them counted: 41 of the 45
    await addCalls(workspace, workload, 1, 0);
    const began = Date.now();
    await considerMeasuring(workspace.id, await load(workload.id));
    assert.equal(await queuedFor(workload.id), 0, 'four short');
    // the other four arrive inside the wait, which does not count them again call by call
    for (let i = 0; i < 4; i += 1) {
      await addCalls(workspace, workload, 1, 0);
      await considerMeasuring(workspace.id, await load(workload.id));
    }
    assert.ok(Date.now() - began < 2500, 'the burst landed inside the wait');
    assert.equal(await queuedFor(workload.id), 0, 'not counted again yet');
    // and no call comes after them: they are counted again the moment the wait is up, and that starts it
    let n = 0;
    for (let k = 0; k < 100 && n === 0; k += 1) {
      await new Promise((r) => { setTimeout(r, 100); });
      n = await queuedFor(workload.id);
    }
    assert.equal(n, 1, 'started with no call after the last one');
    assert.ok(Date.now() - began >= 2400, 'when the wait was up, not before');
    assert.equal((await load(workload.id)).measure_at_calls, null);
  } finally {
    config.MEASURE_READY_CHECK_MS = was;
  }
  await cancelFor(workload.id);
});

test('a workload whose calls came as a server stopped is started when a server starts, and by the hourly pass', async () => {
  const made = [];
  for (let k = 0; k < 3; k += 1) made.push(await seed({ n: 40, enabled: ['vendor/steady-small'] }));
  const [ready, short, asked] = made;
  // all three waiting: one whose count its calls reached with no server there to count them, one still short, and
  // one in a workspace that measures only when asked
  await db.prepare('UPDATE workloads SET measure_at_calls = 40, recheck_after = ? WHERE id = ?').run(now() + 30 * DAY, ready.workload.id);
  await db.prepare('UPDATE workloads SET measure_at_calls = 176, recheck_after = ? WHERE id = ?').run(now() + 30 * DAY, short.workload.id);
  await db.prepare('UPDATE workloads SET measure_at_calls = 40, recheck_after = ? WHERE id = ?').run(now() + 30 * DAY, asked.workload.id);
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(asked.workspace.id);
  assert.ok((await startWaiting()) >= 1);
  assert.equal(await queuedFor(ready.workload.id), 1, 'the one whose calls are here is started');
  assert.equal((await load(ready.workload.id)).measure_at_calls, null, 'and waits for nothing more');
  assert.equal(await queuedFor(short.workload.id), 0, 'the one still short keeps waiting');
  assert.equal(Number((await load(short.workload.id)).measure_at_calls), 176);
  assert.equal(await queuedFor(asked.workload.id), 0, 'only when asked means only when asked');
  // looking again changes nothing
  await startWaiting();
  assert.equal(await queuedFor(ready.workload.id), 1);
  await cancelFor(ready.workload.id);
});

test('the hourly pass never queues a workload that is being measured or already waiting in the queue', async () => {
  const { workspace, workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  // booked an hour ahead for its measurement to start, and the hour is up
  await db.prepare("UPDATE workloads SET state = 'live', recheck_after = ? WHERE id = ?").run(now() - 60000, workload.id);
  const due = async () => (await dueForRecheck(workspace.id, 30)).some((r) => r.id === workload.id);
  assert.equal(await due(), true, 'its booking has come due');
  // but the measurement it was held for is still going, as one can more than an hour on
  const runId = `run_busy_${process.pid}`;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, created_at)
      VALUES (?, ?, ?, 'running', 'json', 'openai/gpt-5.4', ?)`).run(runId, workspace.id, workload.id, now() - 3600000);
  assert.equal(await due(), false, 'not while it is being measured');
  await db.prepare(`UPDATE eval_runs SET status = 'done', outcome = 'compared', finished_at = ? WHERE id = ?`).run(now(), runId);
  // or it is waiting its turn in the queue behind two others
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'first' }, { unique: true });
  assert.equal(await due(), false, 'nor while its measurement is waiting in the queue');
  await cancelFor(workload.id);
  assert.equal(await due(), true, 'and due again once neither is so');
});

test('a measurement nobody asked for, queued while another of the workload ran, is answered by that one', async () => {
  const { workspace, workload } = await seed({ n: 40, enabled: ['vendor/steady-small'] });
  const jobOf = () => db.prepare(`SELECT id, created_at FROM jobs WHERE kind = 'eval_run' AND status = 'queued'
      AND (payload::jsonb ->> 'workloadId') = ?`).get(workload.id);
  const runs = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ?').get(workload.id)).n);
  const addRun = (id, status, outcome, finishedAt, jobId) => db.prepare(
    `INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, created_at, finished_at, job_id)
      VALUES (?, ?, ?, ?, ?, 'json', 'openai/gpt-5.4', ?, ?, ?)`).run(`${id}_${process.pid}`, workspace.id, workload.id, status, outcome,
    finishedAt - 3600000, finishedAt, jobId);
  // queued by the hourly pass while the first measurement, under a job of its own, was still going
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'automatic' }, { unique: true });
  const queued = await jobOf();
  await addRun('run_first', 'done', 'compared', Number(queued.created_at) + 1, 'job_first');
  const before = await runs();
  const out = await runEvaluation(workload.id, { trigger: 'automatic', jobId: queued.id });
  assert.equal(out.ok, false);
  assert.match(out.reason, /measured since this was queued/, JSON.stringify(out));
  assert.equal(await runs(), before, 'measured once, not again straight after, and nothing spent');
  await cancelFor(workload.id);

  // a stop answers it the same way: a person said stop
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'automatic' }, { unique: true });
  const beforeStop = await jobOf();
  await addRun('run_stopped', 'stopped', 'stopped', Number(beforeStop.created_at) + 1, 'job_stopped');
  assert.match((await runEvaluation(workload.id, { trigger: 'automatic', jobId: beforeStop.id })).reason, /measured since this was queued/);
  await cancelFor(workload.id);

  // one queued after the last one ended is not answered by it
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'automatic' }, { unique: true });
  const after = await jobOf();
  await db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(now() + 60000, after.id);
  const ahead = await runEvaluation(workload.id, { trigger: 'automatic', jobId: after.id });
  assert.doesNotMatch(String(ahead.reason), /measured since this was queued/, 'asked for after it ended, it goes ahead');

  // and a run of its own job that a restart interrupted is what the job is here to try again, not an answer
  const own = await db.prepare('SELECT id, created_at FROM jobs WHERE id = ?').get(after.id);
  await addRun('run_own', 'failed', 'interrupted', Number(own.created_at) + 1, own.id);
  const retried = await runEvaluation(workload.id, { trigger: 'automatic', jobId: own.id });
  assert.doesNotMatch(String(retried.reason), /measured since this was queued/, 'its own interrupted run does not answer it');
  await cancelFor(workload.id);

  // a person asking is never answered this way
  const asked = await runEvaluation(workload.id, { trigger: 'manual', jobId: queued.id });
  assert.doesNotMatch(String(asked?.reason ?? ''), /measured since this was queued/);
});

test('a measurement too small to switch anything waits for the calls one that could needs, not a whole rhythm', async () => {
  // a person presses Measure now on a new workload with 54 calls: 27 in the sample, where a 3% bar takes 88
  const { workspace, workload } = await seed({ n: 54, enabled: ['vendor/steady-small'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  let w = await load(workload.id);
  const need = barNeed(w);
  const sample = Number((await db.prepare('SELECT sample_size FROM eval_runs WHERE id = ?').get(out.runId)).sample_size);
  assert.ok(sample < need.need, `too few to clear its bar: ${sample} of ${need.need}`);
  assert.equal(Number(w.measure_at_calls), need.calls, 'it waits for the calls a measurement that can switch needs');
  const days = (Number(w.recheck_after) - now()) / DAY;
  assert.ok(days > 29 && days < 31, `with the rhythm kept only as the fallback: ${days} days`);
  // and the call that brings them starts it, as the automatic measurement it now is
  await addCalls(workspace, workload, 60, 20);
  await addCalls(workspace, workload, 60, 21);
  await addCalls(workspace, workload, need.calls - 54 - 120 - 1, 22);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 0, 'one call short: nothing yet');
  await addCalls(workspace, workload, 1, 22);
  await considerMeasuring(workspace.id, await load(workload.id));
  assert.equal(await queuedFor(workload.id), 1, 'the call that brings the count starts it');
  const job = await db.prepare(`SELECT payload FROM jobs WHERE kind = 'eval_run' AND status = 'queued' AND (payload::jsonb ->> 'workloadId') = ?`).get(workload.id);
  assert.equal(JSON.parse(job.payload).trigger, 'automatic');
  await cancelFor(workload.id);

  // one on enough calls to switch is booked on the rhythm as before
  const big = await seed({ n: 200, enabled: ['vendor/steady-small'] });
  assert.equal((await runEvaluation(big.workload.id)).ok, true);
  assert.equal((await load(big.workload.id)).measure_at_calls, null, 'a measurement that could switch waits for no calls');

  // and in a workspace that measures only when asked, nothing waits to start by itself
  const asked = await seed({ n: 54, enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(asked.workspace.id);
  assert.equal((await runEvaluation(asked.workload.id)).ok, true);
  assert.equal((await load(asked.workload.id)).measure_at_calls, null, 'only when asked means only when asked');
});

test('a workload whose last measurement was too small to switch anything is set waiting for the calls when a server starts', async () => {
  const made = [];
  for (let k = 0; k < 5; k += 1) made.push(await seed({ n: 40, enabled: ['vendor/steady-small'] }));
  const [small, enough, noisy, busy, asked] = made;
  const addRun = (x, sample, outcome, status = 'done') => db.prepare(
    `INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, sample_size, floor_pct, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'json', 'openai/gpt-5.4', ?, 3, ?, ?)`).run(`run_small_${x.workload.id}`, x.workspace.id, x.workload.id, status, outcome, sample,
    now() - 3600000, status === 'done' ? now() - 60000 : null);
  for (const x of made) {
    await db.prepare("UPDATE workloads SET state = 'live', status = 'no_match', floor_pct = 3, measure_at_calls = NULL, recheck_after = ? WHERE id = ?")
      .run(now() + 30 * DAY, x.workload.id);
  }
  await addRun(small, 27, 'compared');
  await addRun(enough, 100, 'compared');
  await addRun(noisy, 27, 'unmeasurable');
  await addRun(busy, 27, 'compared');
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, created_at)
      VALUES (?, ?, ?, 'running', 'json', 'openai/gpt-5.4', ?)`).run(`run_busy_${busy.workload.id}`, busy.workspace.id, busy.workload.id, now());
  await addRun(asked, 27, 'compared');
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(asked.workspace.id);
  assert.ok((await waitAfterSmall()) >= 1);
  assert.equal(Number((await load(small.workload.id)).measure_at_calls), 176, 'too small for its 3% bar: it waits for the 176 calls one that can needs');
  assert.equal((await load(enough.workload.id)).measure_at_calls, null, 'one measured on enough calls is left on its rhythm');
  assert.equal((await load(noisy.workload.id)).measure_at_calls, null, 'more calls would not steady a model that disagrees with itself');
  assert.equal((await load(busy.workload.id)).measure_at_calls, null, 'one being measured is left to that measurement');
  assert.equal((await load(asked.workload.id)).measure_at_calls, null, 'only when asked means only when asked');
  // running it again changes nothing
  await waitAfterSmall();
  assert.equal(Number((await load(small.workload.id)).measure_at_calls), 176);
  await db.prepare(`UPDATE eval_runs SET status = 'done', outcome = 'compared', finished_at = ? WHERE id = ?`).run(now(), `run_busy_${busy.workload.id}`);
});

test('a model\'s calls go a few at a time once it has answered one, and it finds just what one at a time found', async () => {
  const was = config.EVAL_CALLS_PER_MODEL;
  delayFor.set('vendor/steady-small', 25);
  delayFor.set('openai/gpt-5.4', 25);
  try {
    const measure = async (width) => {
      config.EVAL_CALLS_PER_MODEL = width;
      const { workload } = await seed({ n: 200, enabled: ['vendor/steady-small'] });
      mostOut.clear();
      mostOutFirst.clear();
      mostOutSecond.clear();
      nthOf.delete('vendor/steady-small');
      firstLook.set('vendor/steady-small', 100);
      const out = await runEvaluation(workload.id);
      assert.equal(out.ok, true, JSON.stringify(out));
      return { r: await resultOf(out.runId, 'vendor/steady-small'), cand: mostOut.get('vendor/steady-small'), ref: mostOut.get('openai/gpt-5.4'),
        first: mostOutFirst.get('vendor/steady-small'), second: mostOutSecond.get('vendor/steady-small') };
    };
    const one = await measure(1);
    const few = await measure(3);
    assert.equal(one.cand, 1, 'one at a time');
    assert.ok(few.cand >= 2 && few.cand <= 3, `a few at a time, never more than three: ${few.cand}`);
    // in its first look and in its second, each on its own
    assert.ok(few.first >= 2 && few.first <= 3, `its first look a few at a time: ${few.first}`);
    assert.ok(few.second >= 2 && few.second <= 3, `its second look a few at a time: ${few.second}`);
    assert.equal(one.first, 1);
    assert.equal(one.second, 1);
    // the customer's own model is asked by the bar and the second look side by side, and never past the cap
    assert.ok(few.ref <= config.MODEL_MAX_IN_FLIGHT, `your own model never more than ${config.MODEL_MAX_IN_FLIGHT} at once: ${few.ref}`);
    // and what it finds is the same
    assert.equal(few.r.verdict, one.r.verdict);
    assert.equal(few.r.runs, one.r.runs);
    assert.equal(Number(few.r.gap_pct), Number(one.r.gap_pct));
    assert.equal(few.r.confirm_verdict, one.r.confirm_verdict, 'the second look too');
    assert.equal(few.r.confirm_runs, one.r.confirm_runs);
  } finally {
    config.EVAL_CALLS_PER_MODEL = was;
    delayFor.clear();
    firstLook.clear();
  }
});

test('a model that cannot win answers at most two calls more than it did one at a time', async () => {
  const was = config.EVAL_CALLS_PER_MODEL;
  delayFor.set('vendor/wrong-small', 20);
  try {
    const measure = async (width) => {
      config.EVAL_CALLS_PER_MODEL = width;
      const { workload } = await seed({ n: 200, enabled: ['vendor/wrong-small'] });
      mostOut.clear();
      const out = await runEvaluation(workload.id);
      assert.equal(out.ok, true, JSON.stringify(out));
      return { ...(await resultOf(out.runId, 'vendor/wrong-small')), out: mostOut.get('vendor/wrong-small') };
    };
    const one = await measure(1);
    const few = await measure(3);
    // dropped in its first look, so these are that look's calls: one at a time, then a few once it answered one
    assert.equal(one.out, 1);
    assert.ok(few.out >= 2 && few.out <= 3, `a few of its calls at once: ${few.out}`);
    assert.equal(one.verdict, 'missed', 'it cannot win, and is dropped');
    assert.equal(few.verdict, 'missed');
    assert.ok(few.runs >= one.runs && few.runs <= one.runs + 2, `${few.runs} calls a few at a time against ${one.runs} one at a time`);
  } finally {
    config.EVAL_CALLS_PER_MODEL = was;
    delayFor.clear();
  }
});

test('with calls out at once, a measurement still never spends past its limit', async () => {
  // a model listed far cheaper than it charges, and a budget that just covers the quote: the limit is reached part way
  const { workspace, workload } = await seed({ n: 200, enabled: ['vendor/pricey-small'] });
  delayFor.set('vendor/pricey-small', 20);
  try {
    // the quote a person sees, our fee in it and corrected by how far tests run over their estimates (see quoteCalibration)
    const quote = (await planFor(await load(workload.id), { canRoute: true })).aboutUsd;
    const budget = Math.ceil(quote * 100 + 3) / 100;
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(budget, workspace.id);
    const limit = budget / (1 + config.ROUTING_FEE_PCT / 100);
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const run = await db.prepare('SELECT spend_usd, sample_size FROM eval_runs WHERE id = ?').get(out.runId);
    // a model the limit stops part way has no result of its own (nothing can be said of it), only the calls it answered
    const asked = Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ?')
      .get(out.runId, 'vendor/pricey-small')).n);
    assert.ok(asked > 0 && asked < Number(run.sample_size), `stopped by the limit part way: ${asked} of its ${run.sample_size} calls`);
    assert.equal(await resultOf(out.runId, 'vendor/pricey-small'), undefined);
    // never more than one call past it, however many were out: counted with what the ones out were likely to cost
    assert.ok(Number(run.spend_usd) <= limit + 0.01 + 1e-9, `spent ${run.spend_usd} against a limit of ${limit}`);
  } finally {
    delayFor.clear();
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = NULL WHERE id = ?').run(workspace.id);
  }
});

test('workloads left waiting on a guessed time are measured at once when they have the calls, and wait for them when not', async () => {
  const made = [];
  for (let k = 0; k < 5; k += 1) made.push(await seed({ n: 30, enabled: ['vendor/steady-small'] }));
  const [ready, short, measured, counted, queued] = made.map((x) => x.workload);
  // every one live, as thirty calls make it, and booked for a guessed time, as the rule before this one left them
  for (const w of [ready, short, measured, counted, queued]) {
    await db.prepare("UPDATE workloads SET state = 'live', recheck_after = ? WHERE id = ?").run(now() + 6 * 3600000, w.id);
  }
  // one measured before, one already waiting for its count, and one already in the queue: none of them is touched
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, created_at, finished_at)
      VALUES (?, ?, ?, 'done', 'compared', 'json', 'openai/gpt-5.4', ?, ?)`).run(`run_waits_${process.pid}`, measured.workspace_id, measured.id, now(), now());
  await db.prepare('UPDATE workloads SET measure_at_calls = 176 WHERE id = ?').run(counted.id);
  await enqueue('eval_run', { workloadId: queued.id, trigger: 'first' }, { unique: true });
  // the plan's answer for each, so this is about which workloads are looked at and what is done with the answer
  const asked = [];
  const plan = async (w) => {
    asked.push(w.id);
    if (w.id === ready.id) return { canRun: true };
    if (w.id === short.id) return { canRun: false, needCalls: 50 };
    return { canRun: false };
  };
  const first = await convertWaits({ plan });
  assert.ok(first.started >= 1 && first.waiting >= 1, JSON.stringify(first));
  for (const w of [measured, counted, queued]) assert.ok(!asked.includes(w.id), 'never looked at: it was measured, counted or queued already');
  assert.equal(await queuedFor(ready.id), 1, 'the one with its calls is measured now');
  assert.ok(Math.abs(Number((await load(ready.id)).recheck_after) - (now() + 3600000)) < 60000);
  assert.equal(Number((await load(short.id)).measure_at_calls), 50, 'the one without waits for its count');
  assert.equal(await queuedFor(short.id), 0);
  assert.equal(await queuedFor(queued.id), 1, 'the one in the queue stays there once');
  // running it again changes nothing
  asked.length = 0;
  await convertWaits({ plan });
  assert.ok(!asked.includes(ready.id) && !asked.includes(short.id), 'both are in the new rule now');
  assert.equal(await queuedFor(ready.id), 1);
  for (const w of [ready, queued]) await cancelFor(w.id);
});

test('a measurement nobody asked for runs only when what it can find pays for it', async () => {
  // two hundred calls over a month: a measurement would cost more than two months of what it could find
  const { workload } = await seed({ n: 200, days: 30, enabled: ['vendor/steady-small'] });
  const plan = await planFor(workload, { canRoute: true, automatic: true, forRun: false });
  assert.equal(plan.notWorth, true, plan.reason);
  assert.match(plan.reason, /Not worth measuring by itself yet|Waiting for more calls/);
  assert.ok(plan.worth.expectedMonthlyUsd >= 0);
  // the same workload measured on request is quoted as usual
  const asked = await planFor(workload, { canRoute: true });
  assert.equal(asked.canRun, true, asked.reason);
  assert.equal(asked.worth.worthIt, false, 'and the page can say it would not pay for itself');
});

test('re-checks that change nothing space out, and a change brings the next one forward', async () => {
  const { workspace, workload } = await seed({ n: 60, enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workspaces SET measure_every_days = 7 WHERE id = ?').run(workspace.id);
  const first = await scheduleNext(workload.id, { changed: false });
  assert.ok(Math.abs(first - (now() + 14 * DAY)) < 60000, 'once confirmed: twice the rhythm');
  const second = await scheduleNext(workload.id, { changed: false });
  assert.ok(Math.abs(second - (now() + 28 * DAY)) < 60000, 'twice: four times');
  for (let k = 0; k < 5; k += 1) await scheduleNext(workload.id, { changed: false });
  const capped = (await load(workload.id)).recheck_after;
  assert.ok(Math.abs(capped - (now() + 7 * 8 * DAY)) < 60000, 'never past eight times the rhythm');
  const reset = await scheduleNext(workload.id, { changed: true });
  assert.ok(Math.abs(reset - (now() + 7 * DAY)) < 60000, 'something changed: back to the rhythm');
  // a workspace that measures only when asked has nothing scheduled
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(workspace.id);
  assert.equal(await scheduleNext(workload.id, { changed: false }), null);
  // and one turned down waits about as long as its calls take to arrive, within a day and the rhythm
  await db.prepare('UPDATE workspaces SET measure_every_days = 7 WHERE id = ?').run(workspace.id);
  const at = await deferAutomatic(workload.id, { waitMs: 3 * DAY });
  assert.ok(Math.abs(at - (now() + 3 * DAY)) < 60000);
  // a wait worked out from a daily pace is a fraction of a millisecond, and a bigint column refuses that
  const odd = await deferAutomatic(workload.id, { waitMs: (10 / 3) * DAY + 0.5 });
  assert.equal(Number.isInteger(odd), true);
  assert.equal(Number((await load(workload.id)).recheck_after), odd);
});

test('a new cheaper model brings forward the next measurement of the workloads it could matter to', async () => {
  const a = await seed({ n: 30 });
  const b = await seed({ n: 30 });
  await db.prepare(`UPDATE workloads SET state = 'live', recheck_after = ? WHERE id = ANY(?::text[])`).run(now() + 20 * DAY, [a.workload.id, b.workload.id]);
  // b was measured two days ago; a never
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, created_at)
      VALUES ('run_recent_b', ?, ?, 'done', 'json', 'openai/gpt-5.4', 10, ?)`).run(b.workspace.id, b.workload.id, now() - 2 * DAY);
  const before = await db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all();
  const after = [...before, { model_id: 'vendor/brand-new', price_in: 0.05e-6, price_out: 0.1e-6 }];
  // in the catalogue, as the sync that read it saves it before nudging: only a model a measurement would try nudges
  await db.prepare(`INSERT INTO models_catalog (model_id, name, context_len, price_in, price_out, open_weights, zdr, synced_at)
      VALUES ('vendor/brand-new', 'brand new', 128000, 0.05e-6, 0.1e-6, 1, 1, ?)`).run(now());
  forgetFacts();
  try {
    const moved = await nudgeForCatalog(before, after);
    assert.ok(moved.added >= 1);
    const wa = await load(a.workload.id);
    const wb = await load(b.workload.id);
    assert.ok(wa.recheck_after <= now() + config.EVAL_NUDGE_HOURS * 3600000 + 1000, 'brought forward');
    assert.ok(wb.recheck_after > now() + 10 * DAY, 'not for one measured in the last week');
  } finally {
    await db.prepare(`DELETE FROM models_catalog WHERE model_id = 'vendor/brand-new'`).run();
    forgetFacts();
  }
});

test('calls are grouped the way the customer means: by name, by model, and by the job behind a shared instruction', async () => {
  const { workspace } = await createAccount({ email: `group-${process.pid}@understudy.dev`, password: 'correct-horse', name: 'g' });
  // named: different prompts, one workload, the customer's name
  const named = (i) => ({ model: 'openai/gpt-5.4', messages: [{ role: 'user', content: `Totally different words ${i} ${words(5, i)}` }] });
  const n1 = await workloadFor(workspace.id, named(1), { name: 'Invoice Extraction' });
  const n2 = await workloadFor(workspace.id, named(2), { name: 'invoice extraction' });
  assert.equal(n1.id, n2.id);
  assert.equal(n1.slug, 'invoice-extraction');
  assert.equal(Number(n1.named_by_customer), 1);
  // the same prompt on two models: two workloads, the second named after the first
  const onModel = (m) => ({ model: m, messages: [{ role: 'system', content: 'Classify the ticket.' }, { role: 'user', content: 'ticket 1' }] });
  const m1 = await workloadFor(workspace.id, onModel('openai/gpt-5.4'));
  const m2 = await workloadFor(workspace.id, onModel('vendor/steady-small'));
  assert.notEqual(m1.id, m2.id);
  assert.equal(m2.sibling_of, m1.id);
  assert.equal(m2.reference_model, 'vendor/steady-small');
  assert.equal((await workloadFor(workspace.id, onModel('openai/gpt-5.4'))).id, m1.id, 'the first model keeps its workload');
  // one long shared instruction, three jobs behind it: split once the openings show it
  const shared = 'You are the assistant for Acme. Follow the house style. Be accurate and brief. Never invent facts.';
  const job = (opening, i) => ({ model: 'openai/gpt-5.4', messages: [{ role: 'system', content: shared }, { role: 'user', content: `${opening}: item ${i} ${words(6, i)}` }] });
  const openings = ['Summarise the following thread', 'Translate this into French', 'Classify the sentiment of this review'];
  let parent = null;
  for (let i = 0; i < 60; i += 1) parent = await workloadFor(workspace.id, job(openings[i % 3], i));
  const p = await load(parent.id);
  assert.ok(p.split_heads, 'the shared workload knows it is several jobs');
  assert.equal(JSON.parse(p.split_heads).length, 2, 'the commonest opening stays, the other two get their own');
  const child = await workloadFor(workspace.id, job(openings[1], 999));
  const child2 = await workloadFor(workspace.id, job(openings[2], 998));
  assert.notEqual(child.id, parent.id);
  assert.notEqual(child2.id, parent.id);
  assert.notEqual(child.id, child2.id);
  assert.ok(child.head_key, 'and says which opening it is');
  // a chat, whose user turns open differently every time, never splits
  let chat = null;
  for (let i = 0; i < 60; i += 1) {
    chat = await workloadFor(workspace.id, { model: 'openai/gpt-5.4', messages: [{ role: 'system', content: 'You are a helpful support agent for Globex.' },
      { role: 'user', content: `${words(4, i * 17 + 3)} question number ${i}?` }] });
  }
  assert.equal((await load(chat.id)).split_heads, null);
});

test('written work with no one right answer is held to "at least as good"', async () => {
  const { workload } = await seed({ poem: true, enabled: ['vendor/poet-small', 'judge/small'] });
  assert.equal(workload.shape_kind, 'free_text');
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  assert.equal(run.yardstick, 'quality', 'no two poems are the same poem, so the bar is "at least as good"');
  assert.equal(run.outcome, 'compared');
  const check = JSON.parse(run.judge_check_json || 'null');
  assert.ok(check && check.errors === 0, `the quality judge passed the pairs it was tested with: ${run.judge_check_json}`);
  const poet = (await results(out.runId)).find((r) => r.model_id === 'vendor/poet-small');
  assert.equal(poet.verdict, 'cleared', `${poet.gap_pct}% against ${run.floor_pct}%`);
  assert.ok(judged.quality > 0);
});

test('chances are read through how often chances like them came true, and only opted-in workspaces count for others', async () => {
  forgetCalibration();
  const mine = await seed({ n: 1 });
  const theirs = await seed({ n: 1 });
  const other = await seed({ n: 1 });
  const add = async (ws, wl, chance, verdict, k) => {
    await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, created_at)
        VALUES (?, ?, ?, 'done', 'json', 'openai/gpt-5.4', 10, ?) ON CONFLICT DO NOTHING`).run(`run_cal_${wl}`, ws, wl, now() - DAY);
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, verdict, created_at, rank_json)
        VALUES (?, ?, ?, 10, 1, ?, ?, ?)`).run(`res_cal_${wl}_${k}`, `run_cal_${wl}`, `m${k}`, verdict, now(), JSON.stringify({ rawChance: chance, chance }));
  };
  // chances of 0.8 that came true only a quarter of the time, in a workspace that shares
  await db.prepare('UPDATE workspaces SET share_stats = 1 WHERE id = ?').run(theirs.workspace.id);
  for (let k = 0; k < 60; k += 1) await add(theirs.workspace.id, theirs.workload.id, 0.85, k % 4 === 0 ? 'cleared' : 'missed', k);
  // and a workspace that does not share, whose chances all came true
  for (let k = 0; k < 60; k += 1) await add(other.workspace.id, other.workload.id, 0.85, 'cleared', k);
  const table = await calibrationFor(mine.workspace.id);
  assert.ok(table, 'enough results to read chances through');
  const p = calibrated(table, 0.85);
  assert.ok(p < 0.45, `a chance of 0.85 that came true a quarter of the time reads lower: ${p}`);
  forgetCalibration();
  // the workspace that does not share counts only for itself
  const own = calibrated(await calibrationFor(other.workspace.id), 0.85);
  assert.ok(own > p, `its own record counts for it: ${own}`);
});
