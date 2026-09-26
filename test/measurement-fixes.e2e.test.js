/* The measurement engine keeping its word, end to end: a provider and a judge we control, a real
   database, the real measurement. Each test here is one thing an independent review found the engine
   getting wrong, with the case beside it that must not change.

   The provider charges every answer exactly what the catalogue says it costs (800 tokens in, 60 out),
   so a quote and what a run spends can be held against each other to the cent. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4831;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_fixes_${process.pid}`;
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
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
// never the real Jev, whatever .env says: a test must not reach a paid service
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
// no test here is about speed: a busy machine must not make a model look slow
process.env.SPEED_SLACK_MS = '5000';
process.env.REQUEST_LOGS = 'false';
process.env.EVAL_JUDGE_MODEL = 'judge/small';
process.env.RESEND_API_KEY = '';
process.env.ROLLOUT_ENABLED = 'true';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation, stopMeasuring, restingStatus } = await import('../src/eval/run.js');
const { move } = await import('../src/billing.js');
const { promote, rollBack } = await import('../src/eval/promote.js');
const { nudgeForCatalog, dueForRecheck } = await import('../src/eval/schedule.js');
const { calibrationFor, calibrated, forgetCalibration } = await import('../src/eval/calibrate.js');
const { planFor } = await import('../src/eval/plan.js');
const { forgetFacts } = await import('../src/models/facts.js');
const { upsertArm, referenceSpec } = await import('../src/learn/arms.js');
const { enqueue } = await import('../src/jobs.js');
const { cheaperCleared, confirmed } = await import('../src/eval/outcome.js');
const { replayOnce } = await import('../src/eval/replay.js');
const { judgePair, judgeQuality } = await import('../src/eval/judge.js');

await migrate({ quiet: true });

const DAY = 86400000;
const HOUR = 3600000;
const REF = 'openai/gpt-5.4';
const THINKER = 'thinker/big';
const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const wrong = (i) => ({ ...right(i), total: 0 });
const words = (n, seed) => Array.from({ length: n }, (_, k) => `word${(seed * 31 + k * 7) % 97}`).join(' ');

/* Prices per token, the catalogue's and the provider's alike. */
const PRICES = {
  [REF]: [2.5e-6, 15e-6],
  [THINKER]: [2.5e-6, 15e-6],
  'vendor/steady-small': [0.2e-6, 0.6e-6],
  'vendor/twin-small': [0.3e-6, 0.9e-6],
  'vendor/worse-small': [0.25e-6, 0.75e-6],
  'vendor/fifth-small': [0.15e-6, 0.45e-6],
  'vendor/lucky-a': [0.05e-6, 0.15e-6],
  'vendor/lucky-b': [0.08e-6, 0.24e-6],
  'vendor/eighth-small': [0.1e-6, 0.3e-6],
  'vendor/fading-poet': [0.1e-6, 0.3e-6],
  'vendor/poet-small': [0.12e-6, 0.36e-6],
  'judge/small': [0.05e-6, 0.1e-6],
};
const perCall = (model) => (PRICES[model] ? PRICES[model][0] * 800 + PRICES[model][1] * 60 : 0.001);

// how many times each model has been asked, and each model each call
const asks = new Map();
const countOf = (model) => asks.get(model) || 0;
// the calls a model's answers turn on: n is how many times that model has been asked so far, this one included
const BEHAVIOUR = {
  [REF]: (i) => right(i),
  [THINKER]: (i) => right(i),
  'vendor/steady-small': (i) => right(i),
  // as good as the customer's own model: one of its calls in twenty differs, whichever call it is
  'vendor/twin-small': (i, n) => (n % 20 === 0 ? wrong(i) : right(i)),
  // clearly worse: one call in seven
  'vendor/worse-small': (i, n) => (n % 7 === 0 ? wrong(i) : right(i)),
  // one call in five
  'vendor/fifth-small': (i) => (i % 5 === 0 ? wrong(i) : right(i)),
  // right on the first look's calls, and one call in five wrong after them: a lucky first look
  'vendor/lucky-a': (i, n) => (n > luckyAfter && i % 5 === 0 ? wrong(i) : right(i)),
  'vendor/lucky-b': (i, n) => (n > luckyAfter && i % 5 === 0 ? wrong(i) : right(i)),
  // one call in eight
  'vendor/eighth-small': (i) => (i % 8 === 3 ? wrong(i) : right(i)),
};
let luckyAfter = 100;
// how much the thinking model thinks on each answer
let thinkerReasoning = 0;
// our own account with the provider refused, from the Nth call to the customer's model on
let refusesFrom = null;
// every call to these models answered with this status
const failing = new Map();
// answers from these models carry no cost ('cost'), no usage at all ('usage'), or a cost of nothing ('zero')
const costless = new Map();
const fenced = (text, label) => (text.match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    const model = p.model;
    const sys = p.messages?.find((m) => m.role === 'system')?.content || '';
    const user = String(p.messages?.find((m) => m.role === 'user')?.content || '');
    const send = (content, extra = {}) => {
      const how = costless.get(model);
      const usage = how === 'usage' ? null
        : { prompt_tokens: 800, completion_tokens: 60, ...(how === 'cost' ? {} : { cost: how === 'zero' ? 0 : perCall(model) }), ...extra };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) }));
    };
    const refuse = (status) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: status === 402 ? 'Insufficient credits' : 'Provider is overloaded' } }));
    };
    if (model === 'judge/small') {
      // the quality judge: a clearly shorter answer is worse, otherwise a tie
      if (String(sys).includes('say which one serves')) {
        const a = fenced(user, 'FIRST');
        const b = fenced(user, 'SECOND');
        if (a.length > b.length * 1.6) return send('FIRST');
        if (b.length > a.length * 1.6) return send('SECOND');
        return send('TIE');
      }
      // the agreement judge: two poems are never the same poem
      return send(fenced(user, 'A').trim() === fenced(user, 'B').trim() ? 'SAME' : 'DIFFERENT');
    }
    asks.set(model, countOf(model) + 1);
    const n = countOf(model);
    if (failing.has(model)) return refuse(failing.get(model));
    if ((model === REF || model === THINKER) && refusesFrom !== null && n >= refusesFrom) return refuse(402);
    const i = Number((user.match(/#(\d+)/) || [])[1] || 0);
    if (user.startsWith('Write a poem')) {
      // a different forty-word poem every time; the fading poet writes eight words on one call in five after its first hundred
      const short = model === 'vendor/fading-poet' && n > 100 && i % 5 === 0;
      return send(words(short ? 8 : 40, n * 13 + i));
    }
    const f = BEHAVIOUR[model] || (() => ({ total: 0 }));
    return send(JSON.stringify(f(i, n)),
      model === THINKER ? { completion_tokens_details: { reasoning_tokens: thinkerReasoning } } : {});
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await saveCatalog(Object.entries(PRICES).map(([id, [pin, pout]]) => ({
    model_id: id, name: id.split('/').pop(), context_len: 200000, price_in: pin, price_out: pout,
    open_weights: 0, zdr: 1,
    ...(id === THINKER ? { reasoning_json: JSON.stringify({ default_enabled: true, supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium' }) } : {}),
  })));
  // the thinking model is sold by two providers, one of them at half the price
  for (const [tag, share] of [['cheapco', 0.5], ['fullco', 1]]) {
    await db.prepare(`INSERT INTO model_endpoints (model_id, tag, provider, price_in, price_out, status, uptime_30m, uptime_1d, synced_at)
        VALUES (?, ?, ?, ?, ?, 0, 100, 100, ?)`).run(THINKER, tag, tag, 2.5e-6 * share, 15e-6 * share, now());
  }
  forgetFacts();
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
/** A workspace with one workload of `n` calls over `days` days, answered the way the customer's own model answered them. */
async function seed({
  n = 200, model = REF, days = 14, enabled = [], disabled = [], mode = 'ask', poem = false, cadence = null,
  recordedAnswer = (i) => JSON.stringify(right(i)), armFor = null, promptTokens = 800,
} = {}) {
  seq += 1;
  const { workspace } = await createAccount({ email: `fix-${seq}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `f${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  // providers that keep data briefly are allowed here, so a model sold by only some providers is priced by its catalogue entry
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ?, zdr_required = 0, measure_every_days = ? WHERE id = ?')
    .run(mode, cadence, workspace.id);
  // only the models the test names can be tried
  for (const m of new Set([...Object.keys(PRICES), ...enabled, ...disabled])) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, enabled.includes(m) ? 1 : 0, now());
  }
  const request = (i) => (poem
    ? { model, messages: [{ role: 'system', content: 'You are a poet.' }, { role: 'user', content: `Write a poem about the sea, #${i}` }] }
    : { model, messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}, set ${seq}.` }, { role: 'user', content: `document #${i}` }],
      response_format: { type: 'json_object' } });
  const workload = await workloadFor(workspace.id, request(0));
  const arms = armFor ? await armFor(workload) : null;
  for (let i = 0; i < n; i += 1) {
    const answer = poem ? words(40, i) : recordedAnswer(i);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: model, servedModel: model, statusCode: 200,
      promptTokens, completionTokens: 60, costUsd: perCall(model), chargedUsd: 0, armId: arms ? arms(i) : null,
      request: request(i), response: answer === null ? null : { choices: [{ message: { content: answer } }], usage: { cost: perCall(model) } },
    });
  }
  // spread over the days, as real traffic is
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % ?::int)::bigint * 86400000 WHERE workload_id = ?')
    .run(now() - DAY, days, workload.id);
  await db.prepare(`UPDATE workloads SET state = 'live' WHERE id = ?`).run(workload.id);
  return { workspace, workload: await load(workload.id) };
}
const load = (id) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(id);
const runOf = (id) => db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id);
const results = (runId) => db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId);
const resultOf = async (runId, model) => (await results(runId)).find((r) => r.model_id === model);
const runsOf = async (workloadId) => Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ?').get(workloadId)).n);
const reverts = async (workloadId) => Number((await db.prepare(
  `SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ? AND action IN ('revert', 'auto_revert', 'soft_revert')`).get(workloadId)).n);
/* The hourly pass's own rule for what is due (dueForRecheck, used by src/server.js), for one workload. */
const dueNow = async (workloadId) => {
  const w = await load(workloadId);
  return (await dueForRecheck(w.workspace_id, 30)).some((r) => r.id === workloadId);
};

/* 1. The second look under "at least as good" ---------------------------------------------- */

test('under "at least as good", the second look is held to a bar read by that same yardstick', async () => {
  const { workload } = await seed({ poem: true, enabled: ['vendor/fading-poet'], mode: 'auto' });
  asks.set('vendor/fading-poet', 0);
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'quality', 'no two poems are the same poem, so the bar is "at least as good"');
  const fading = await resultOf(out.runId, 'vendor/fading-poet');
  assert.equal(fading.verdict, 'cleared', `its first look: ${fading.gap_pct}% against ${run.floor_pct}%`);
  // read from the agreement scores as well, this bar came out near 60%, and one call in five clearly worse passed it
  assert.ok(fading.confirm_floor < 10, `the second look's bar: ${fading.confirm_floor}%`);
  assert.notEqual(fading.confirm_verdict, 'cleared', `its second look: ${fading.confirm_gap}%, at most ${fading.confirm_hi}%`);
  assert.equal((await load(workload.id)).routed_model, null, 'a model clearly worse on one call in five is not switched to');
});

test('a poet as good as the customer\'s own still clears both looks and is switched to', async () => {
  const { workload } = await seed({ poem: true, enabled: ['vendor/poet-small'], mode: 'auto' });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const poet = await resultOf(out.runId, 'vendor/poet-small');
  assert.equal(poet.verdict, 'cleared');
  assert.equal(poet.confirm_verdict, 'cleared', `${poet.confirm_gap}% against ${poet.confirm_floor}%`);
  assert.equal((await load(workload.id)).routed_model, 'vendor/poet-small');
});

/* 2. What serves, re-checked ------------------------------------------------------------------ */

test('what serves is judged on its range over every call, and one that came close is not switched back', async () => {
  const { workload } = await seed({ enabled: ['vendor/twin-small'], mode: 'auto' });
  await promote(await load(workload.id), 'vendor/twin-small', { recipe: null, rollout: false });
  asks.set('vendor/twin-small', 0);
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  const twin = await resultOf(out.runId, 'vendor/twin-small');
  // dropped at its fourth difference, as soon as the best it could still do was past 3.75%, it was "missed"
  assert.equal(twin.runs, run.sample_size, 'what serves answers every call, never dropped part way');
  assert.equal(twin.stopped, null);
  assert.equal(twin.verdict, 'review', `${twin.gap_pct}% against a ${run.floor_pct}% bar, at least ${twin.gap_lo}%`);
  const w = await load(workload.id);
  assert.equal(w.routed_model, 'vendor/twin-small', 'still serving');
  assert.equal(w.status, 'promoted');
  assert.equal(await reverts(workload.id), 0, 'and not switched back, for good or otherwise');
  const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  assert.match(said.title, /came close to your bar/);
});

test('what serves and really is worse is still switched back, for good', async () => {
  const { workload } = await seed({ enabled: ['vendor/worse-small'], mode: 'auto' });
  await promote(await load(workload.id), 'vendor/worse-small', { recipe: null, rollout: false });
  asks.set('vendor/worse-small', 0);
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const worse = await resultOf(out.runId, 'vendor/worse-small');
  assert.equal(worse.verdict, 'missed', `${worse.gap_pct}%, at least ${worse.gap_lo}%`);
  assert.equal((await load(workload.id)).routed_model, null);
  const back = await db.prepare(`SELECT action FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  assert.equal(back.action, 'auto_revert');
});

/* 3. Stops that stick, failures that back off, retries that use what was bought ---------------- */

test('a new workload\'s first measurement, stopped, is not started again by the hourly pass', async () => {
  // busy enough that a measurement nobody asked for pays for itself, so it gets as far as starting
  const { workload } = await seed({ n: 900, enabled: ['vendor/steady-small'] });
  // booked an hour ahead when its calls came in, and that hour has passed
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(now() - 1000, workload.id);
  const jobId = await enqueue('eval_run', { workloadId: workload.id, trigger: 'first' });
  await db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(jobId);
  const out = await runEvaluation(workload.id, { trigger: 'first', jobId });
  assert.equal(out.stopped, true, JSON.stringify(out));
  const w = await load(workload.id);
  assert.ok(w.recheck_after > now() + 29 * DAY, `the next one waits a whole rhythm: ${(w.recheck_after - now()) / DAY} days`);
  assert.equal(await dueNow(workload.id), false, 'the hourly pass leaves it alone');
});

test('a measurement taken out of the queue by Stop is not started again by the hourly pass', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(now() - 1000, workload.id);
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'automatic' }, { unique: true });
  const out = await stopMeasuring(await load(workload.id));
  assert.equal(out.state, 'cancelled');
  assert.ok((await load(workload.id)).recheck_after > now() + 29 * DAY);
  assert.equal(await dueNow(workload.id), false);
});

test('a measurement cut short by the provider waits a few hours, longer each time, and never an hour', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'] });
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(now() - 1000, workload.id);
  failing.set(REF, 503);
  try {
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal((await db.prepare('SELECT outcome FROM eval_runs WHERE workload_id = ?').get(workload.id)).outcome, 'interrupted');
    const first = Number((await load(workload.id)).recheck_after) - now();
    assert.ok(first > 5.9 * HOUR && first < 6.1 * HOUR, `put off ${first / HOUR} hours`);
    assert.equal(await dueNow(workload.id), false);
    await runEvaluation(workload.id);
    const second = Number((await load(workload.id)).recheck_after) - now();
    assert.ok(second > 11.9 * HOUR && second < 12.1 * HOUR, `the second time in a row, ${second / HOUR} hours`);
  } finally {
    failing.delete(REF);
  }
});

test('the measurement that tries again after one was cut short uses the bar it bought', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'] });
  failing.set('vendor/steady-small', 402);
  let out;
  try {
    out = await runEvaluation(workload.id);
  } finally {
    failing.delete('vendor/steady-small');
  }
  const cut = await db.prepare('SELECT * FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
  assert.equal(cut.outcome, 'interrupted', JSON.stringify(out));
  assert.match(cut.error, /account/);
  const again = await runEvaluation(workload.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  /* the bar's answers this run paid for, rather than read from the call or from what the cut-short one bought: the first
     look's, since the customer's model's answers to a second look's new requests are kept too (look 2), and are always new */
  const bought = Number((await db.prepare(`SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND reused = 0
      AND look IS DISTINCT FROM 2`).get(again.runId, REF)).n);
  // counted as a finished measurement's calls, they were steered away from, and a whole new bar was paid for
  assert.ok(bought < 30, `the customer's model was paid for ${bought} of the bar's answers, on ${cut.sample_size} calls`);
});

/* 4. Recorded answers are the customer's own only ----------------------------------------------- */

const LIGHTER = { kind: 'model', model: REF, recipe: { reasoning: { effort: 'low' } } };

test('answers a switch served are never taken for the customer\'s own, even when the switch is the same model', async () => {
  // every call answered by the customer's model thinking less, recorded as served by that model; three in ten of them differ
  const { workload } = await seed({
    enabled: ['vendor/fifth-small'],
    recordedAnswer: (i) => JSON.stringify(i % 10 < 3 ? wrong(i) : right(i)),
    armFor: async (w) => { const arm = await upsertArm(w, LIGHTER, { status: 'serving' }); return () => arm.id; },
  });
  const plan = await planFor(workload, { canRoute: true });
  assert.equal(plan.recordedShare, 0, 'none of them is the customer\'s own answer');
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.recorded_refs, 0);
  // held against the lighter answers, the customer's model seemed to disagree with itself three times in ten, and the bar was 37.5%
  assert.equal(run.noise_pct, 0);
  assert.equal(run.floor_pct, config.EVAL_FLOOR_MIN_PCT);
  assert.equal((await resultOf(out.runId, 'vendor/fifth-small')).verdict, 'missed', 'a model wrong one call in five does not clear');
});

test('answers the customer\'s own model gave, or gave as the control of a switch, are still used', async () => {
  const { workload } = await seed({
    enabled: ['vendor/steady-small'],
    armFor: async (w) => { const arm = await upsertArm(w, referenceSpec(w), { status: 'baseline' }); return (i) => (i % 2 ? arm.id : null); },
  });
  const plan = await planFor(workload, { canRoute: true });
  assert.ok(plan.recordedShare > 0.99, `${plan.recordedShare}`);
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.recorded_refs >= run.sample_size, true, `${run.recorded_refs} of ${run.sample_size}`);
});

/* 5. A second look never reached is not a second look passed -------------------------------------- */

test('a model the second look never reached is not read as confirmed', async () => {
  luckyAfter = 120;
  // two second looks, so the third model that cleared is one they never reach
  const tries = config.EVAL_CONFIRM_TRIES;
  config.EVAL_CONFIRM_TRIES = 2;
  try {
    const { workload } = await seed({ n: 400, enabled: ['vendor/lucky-a', 'vendor/lucky-b', 'vendor/steady-small'] });
    asks.set('vendor/lucky-a', 0);
    asks.set('vendor/lucky-b', 0);
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const run = await runOf(out.runId);
    assert.equal(run.sample_size, 120);
    const [a, b, steady] = await Promise.all(['vendor/lucky-a', 'vendor/lucky-b', 'vendor/steady-small'].map((m) => resultOf(out.runId, m)));
    for (const r of [a, b, steady]) assert.equal(r.verdict, 'cleared', `${r.model_id} on its first look`);
    assert.notEqual(a.confirm_verdict, 'cleared');
    assert.notEqual(b.confirm_verdict, 'cleared');
    assert.equal(steady.confirm_verdict, 'not_reached', 'two looks were spent on the two cheaper ones');
    assert.equal(confirmed(steady), 0);
    /* nothing stood behind any of them twice: the two that did not hold up on their second look are never offered (the
       owner's rule of 26 Sep 2026, failedSecondLook), the one the looks never reached waits for its own, and nobody is told
       it is ready */
    assert.deepEqual(cheaperCleared(await results(out.runId)).map((r) => r.model_id), ['vendor/steady-small']);
    const rest = await restingStatus(workload.id);
    assert.equal(rest.note, 'A candidate cleared once and needs a second look');
    const w = await load(workload.id);
    assert.equal(w.status_note, 'A candidate cleared once and needs a second look');
    /* the calls the second looks used are kept with the run, like its sample; both looks were on the
       same calls, so the customer's model was paid for them once */
    const kept = Number((await db.prepare('SELECT COUNT(DISTINCT call_id) AS n FROM eval_samples WHERE run_id = ?').get(out.runId)).n);
    assert.equal(b.confirm_runs, a.confirm_runs);
    assert.equal(kept, run.sample_size + a.confirm_runs, `${kept} calls kept for ${run.sample_size} + ${a.confirm_runs}`);
  } finally {
    luckyAfter = 100;
    config.EVAL_CONFIRM_TRIES = tries;
  }
});

test('with every call already looked at, there is no second look rather than one on seen calls', async () => {
  const { workload } = await seed({ n: 200, enabled: ['vendor/steady-small'] });
  const first = await runEvaluation(workload.id);
  const one = await resultOf(first.runId, 'vendor/steady-small');
  assert.equal(one.confirm_verdict, 'cleared', 'the first second look had a hundred calls nobody had seen');
  const again = await runEvaluation(workload.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  const two = await resultOf(again.runId, 'vendor/steady-small');
  assert.equal(two.verdict, 'cleared');
  // it used to fall back on calls earlier measurements had used, answered from what they kept, and "confirm" on them
  assert.equal(two.confirm_verdict, 'insufficient', `${two.confirm_runs} calls`);
  assert.equal(two.confirm_runs, 0);
});

/* 6. A switch made during a rollout keeps the rollout's control --------------------------------- */

test('a switch made while another is still taking over keeps what served in full as the control', async () => {
  const { workload } = await seed({ n: 20 });
  await promote(await load(workload.id), 'vendor/steady-small', { recipe: null, rollout: false });
  const x = (await load(workload.id)).routed_arm_id;
  await promote(await load(workload.id), 'vendor/twin-small', { recipe: null });
  let w = await load(workload.id);
  assert.equal(w.rollout_from_arm_id, x, 'the first rollout is held against what served in full');
  const unfinished = w.routed_arm_id;
  await promote(await load(workload.id), 'vendor/worse-small', { recipe: null });
  w = await load(workload.id);
  assert.equal(w.rollout_share, config.ROLLOUT_STAGES[0]);
  assert.equal(w.rollout_from_arm_id, x, 'still what served in full, not the one on its first share');
  assert.notEqual(w.rollout_from_arm_id, unfinished);
  await rollBack(w, 'test');
  assert.equal((await load(workload.id)).routed_arm_id, x, 'a roll back serves what served in full');

  // from the customer's own model: its control stays the customer's own model
  const { workload: fresh } = await seed({ n: 20 });
  await promote(await load(fresh.id), 'vendor/steady-small', { recipe: null });
  await promote(await load(fresh.id), 'vendor/twin-small', { recipe: null });
  assert.equal((await load(fresh.id)).rollout_from_arm_id, null);

  // a switch back to the control itself has nothing to roll out
  const { workload: back } = await seed({ n: 20 });
  await promote(await load(back.id), 'vendor/steady-small', { recipe: null, rollout: false });
  const control = (await load(back.id)).routed_arm_id;
  await promote(await load(back.id), 'vendor/twin-small', { recipe: null });
  await promote(await load(back.id), 'vendor/steady-small', { recipe: null });
  const wb = await load(back.id);
  assert.equal(wb.routed_arm_id, control);
  assert.equal(wb.rollout_share, null, 'every call at once');
});

/* 7. Head splits are for good ----------------------------------------------------------------- */

test('a job split away is never folded back, and the workload\'s own job is never split away', async () => {
  const { workspace } = await createAccount({ email: `heads-${process.pid}@understudy.dev`, password: 'correct-horse', name: 'h' });
  const shared = 'You are the assistant for Acme. Follow the house style. Be accurate and brief. Never invent facts.';
  const job = (opening, i) => ({ model: REF, messages: [{ role: 'system', content: shared }, { role: 'user', content: `${opening}: item ${i} ${words(6, i)}` }] });
  const [A, B, C, D] = ['Summarise the following thread', 'Translate this into French', 'Classify the sentiment of this review', 'Extract every date mentioned'];
  // the first sixty: A the commonest, B and C a quarter each
  let parent = null;
  for (let i = 0; i < 60; i += 1) parent = await workloadFor(workspace.id, job(i % 2 ? A : i % 4 === 0 ? B : C, i));
  let p = await load(parent.id);
  assert.deepEqual(new Set(JSON.parse(p.split_heads)).size, 2, 'B and C are jobs of their own');
  // then D arrives and overtakes A, and at the 150th call of the parent the openings are looked at again
  for (let k = 0; k < 90; k += 1) await workloadFor(workspace.id, job(k % 9 < 2 ? A : D, 1000 + k));
  p = await load(parent.id);
  const split = JSON.parse(p.split_heads);
  assert.equal(split.length, 3, `B and C stay split, and D joins them: ${p.split_heads}`);
  assert.notEqual((await workloadFor(workspace.id, job(B, 5000))).id, parent.id, 'B still has a workload of its own');
  assert.notEqual((await workloadFor(workspace.id, job(C, 5001))).id, parent.id, 'and so does C');
  assert.notEqual((await workloadFor(workspace.id, job(D, 5002))).id, parent.id, 'and now D');
  assert.equal((await workloadFor(workspace.id, job(A, 5003))).id, parent.id, 'A, the workload\'s own job, stays with it');
});

/* 8. Quotes are not below what runs spend ------------------------------------------------------ */

test('a re-check is quoted what it spends: its bar, and both second looks it may take', async () => {
  const { workload } = await seed({ n: 900, enabled: ['vendor/steady-small', 'vendor/fifth-small'] });
  const first = await runEvaluation(workload.id);
  assert.equal(first.ok, true, JSON.stringify(first));
  const one = await runOf(first.runId);
  assert.ok(one.spend_usd <= one.quote_usd + 1e-9, `the first: spent $${one.spend_usd}, quoted $${one.quote_usd}`);
  // the re-check draws calls no measurement used, so nothing it needs is paid for yet
  const plan = await planFor(await load(workload.id), { canRoute: true });
  assert.ok(plan.cachedBar < 0.05, `the re-check's bar is not already paid for: ${plan.cachedBar}`);
  const again = await runEvaluation(workload.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  const two = await runOf(again.runId);
  assert.ok((await resultOf(again.runId, 'vendor/steady-small')).confirm_runs > 0, 'it took a second look');
  // it used to be quoted a nearly free bar, and then pay for all of it
  assert.ok(two.spend_usd <= two.quote_usd + 1e-9, `the re-check: spent $${two.spend_usd}, quoted $${two.quote_usd}`);
});

test('a measurement that looks at two models again is quoted both looks', async () => {
  luckyAfter = 120;
  try {
    const { workload } = await seed({ n: 400, enabled: ['vendor/lucky-a', 'vendor/lucky-b'] });
    asks.set('vendor/lucky-a', 0);
    asks.set('vendor/lucky-b', 0);
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const run = await runOf(out.runId);
    const [a, b] = await Promise.all(['vendor/lucky-a', 'vendor/lucky-b'].map((m) => resultOf(out.runId, m)));
    assert.ok(a.confirm_runs > 0 && b.confirm_runs > 0, 'both were looked at again');
    // one look used to be quoted, though a run takes two
    assert.ok(run.spend_usd <= run.quote_usd + 1e-9, `spent $${run.spend_usd}, quoted $${run.quote_usd}`);
  } finally {
    luckyAfter = 100;
  }
});

/* 9. The catalogue's nudge ---------------------------------------------------------------------- */

test('a new model nudges only workloads a measurement would try it on, keeps the backoff, and leaves "only when asked" alone', async () => {
  const later = now() + 60 * DAY;
  const book = (id) => db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = 2 WHERE id = ?').run(later, id);
  const tries = await seed({ n: 20, enabled: ['vendor/cheap-new'] });
  const off = await seed({ n: 20, enabled: [], disabled: ['vendor/cheap-new'] });
  const never = await seed({ n: 20, enabled: ['vendor/cheap-new'], cadence: 0 });
  // prompts longer than the new model can read
  const long = await seed({ n: 20, enabled: ['vendor/cheap-new'], promptTokens: 150000 });
  const measured = await seed({ n: 20, enabled: ['vendor/cheap-new'] });
  for (const s of [tries, off, never, long, measured]) await book(s.workload.id);
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, sample_size, created_at)
      VALUES ('run_nudge_measured', ?, ?, 'done', 'compared', 'json', ?, 10, ?)`).run(measured.workspace.id, measured.workload.id, REF, now() - 10 * DAY);
  const before = await db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all();
  await db.prepare(`INSERT INTO models_catalog (model_id, name, context_len, price_in, price_out, open_weights, zdr, synced_at)
      VALUES ('vendor/cheap-new', 'cheap new', 32000, 0.02e-6, 0.05e-6, 1, 1, ?)`).run(now());
  forgetFacts();
  try {
    const after = await db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all();
    await nudgeForCatalog(before, after);
    const [t, o, n, l, m] = await Promise.all([tries, off, never, long, measured].map((s) => load(s.workload.id)));
    assert.ok(t.recheck_after <= now() + config.EVAL_NUDGE_HOURS * HOUR + 1000, 'a workload it could be tried on comes forward');
    assert.equal(Number(t.recheck_streak), 2, 'and keeps its backoff: a nudge brings one check forward, it does not erase the streak');
    assert.equal(Number(o.recheck_after), later, 'not where the model is switched off');
    assert.equal(Number(n.recheck_after), later, 'not in a workspace that measures only when asked');
    assert.equal(Number(l.recheck_after), later, 'not where it cannot read the calls');
    // measured ten days ago on a thirty day rhythm: never sooner than that rhythm after it
    assert.ok(Math.abs(Number(m.recheck_after) - (now() + 20 * DAY)) < 60000, `${(m.recheck_after - now()) / DAY} days`);
  } finally {
    await db.prepare(`DELETE FROM models_catalog WHERE model_id = 'vendor/cheap-new'`).run();
    forgetFacts();
  }
});

test('a workspace that measures only when asked is never measured by itself, and a person can still ask', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'], cadence: 0 });
  for (const trigger of ['automatic', 'first']) {
    const out = await runEvaluation(workload.id, { trigger });
    assert.equal(out.ok, false);
    assert.match(out.reason, /only when somebody asks/);
  }
  assert.equal(await runsOf(workload.id), 0, 'nothing ran, and nothing was spent');
  const asked = await runEvaluation(workload.id, { trigger: 'manual' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
});

/* 10. Never two measurements of one workload, and a stopped one stays stopped -------------------- */

async function orphan(workload, workspace, { stopped = false, heartbeatAgo = 20 * 60000, jobId = null, status = 'running' } = {}) {
  const t = now();
  const id = `run_${Math.random().toString(36).slice(2)}`;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size,
              created_at, started_at, heartbeat_at, steps_total, steps_done, job_id, stop_requested_at)
              VALUES (?, ?, ?, ?, 'json', ?, 100, ?, ?, ?, 300, 40, ?, ?)`)
    .run(id, workspace.id, workload.id, status, REF, t - 30 * 60000, t - 30 * 60000, t - heartbeatAgo, jobId, stopped ? t - 25 * 60000 : null);
  return id;
}

test('a job put back in the queue after its run was stopped does not start again', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'] });
  const jobId = await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  // Stop was pressed, the process running it died, and a restart put its claimed job back and claimed it again
  const old = await orphan(workload, workspace, { stopped: true, jobId });
  await db.prepare(`UPDATE jobs SET status = 'claimed', claimed_at = ? WHERE id = ?`).run(now(), jobId);
  const out = await runEvaluation(workload.id, { jobId });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(await runsOf(workload.id), 1, 'no second run was started');
  assert.equal((await runOf(old)).status, 'stopped', 'the run nothing was running any more is closed, as stopped');
  assert.equal((await db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).status, 'cancelled');
  assert.ok((await load(workload.id)).recheck_after > now() + 29 * DAY, 'and the stop sticks');
});

test('a run stopped by a person but still finishing elsewhere is left to finish, and nothing new starts', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'] });
  const jobId = await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  await orphan(workload, workspace, { stopped: true, jobId, heartbeatAgo: 2000 });
  const out = await runEvaluation(workload.id, { jobId });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(await runsOf(workload.id), 1);
});

test('a measurement never runs beside another of the same workload', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'] });
  const other = await enqueue('eval_run', { workloadId: workload.id, trigger: 'automatic' });
  const alive = await orphan(workload, workspace, { jobId: other, heartbeatAgo: 2000 });
  const asked = await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  const out = await runEvaluation(workload.id, { jobId: asked, trigger: 'manual' });
  assert.ok(out.snoozeMs > 0, `one somebody asked for waits its turn: ${JSON.stringify(out)}`);
  const auto = await runEvaluation(workload.id, { trigger: 'automatic' });
  assert.equal(auto.ok, false, 'one nobody asked for is not needed');
  assert.equal(await runsOf(workload.id), 1);
  assert.equal((await runOf(alive)).status, 'running', 'the live one is left alone');
  await db.prepare(`UPDATE eval_runs SET status = 'failed' WHERE id = ?`).run(alive);
});

test('two measurements of one workload that start at the same moment do not both run', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'] });
  const both = await Promise.all([runEvaluation(workload.id), runEvaluation(workload.id)]);
  assert.equal(await runsOf(workload.id), 1, JSON.stringify(both));
  assert.ok(both.some((o) => o.snoozeMs > 0), 'the one that came second waits its turn');
});

test('a job whose run was interrupted runs again, and closes the dead run first', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'] });
  const jobId = await enqueue('eval_run', { workloadId: workload.id, trigger: 'manual' });
  const dead = await orphan(workload, workspace, { jobId });
  const out = await runEvaluation(workload.id, { jobId });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runOf(dead)).outcome, 'interrupted');
  assert.equal(await runsOf(workload.id), 2);
});

/* 11. An answer that says nothing of its cost is not free --------------------------------------- */

test('a replay or a judgement whose answer says nothing of its cost is charged at its price, never as free', async () => {
  const { workload } = await seed({ n: 1 });
  const body = { model: REF, messages: [{ role: 'system', content: 'Extract the totals.' }, { role: 'user', content: 'document #7' }] };
  const [pin, pout] = PRICES['vendor/fifth-small'];
  costless.set('vendor/steady-small', 'cost');
  costless.set('vendor/fifth-small', 'usage');
  costless.set('judge/small', 'cost');
  try {
    // no cost on it: its own count of tokens, at its catalogue price, where it used to be nothing
    const noCost = await replayOnce({ body, model: 'vendor/steady-small', workload, reuse: false });
    assert.ok(Math.abs(noCost.cost - perCall('vendor/steady-small')) < 1e-12, `${noCost.cost}`);
    const row = await db.prepare(`SELECT cost_usd FROM calls WHERE workload_id = ? AND source = 'replay' AND served_model = ?`)
      .get(workload.id, 'vendor/steady-small');
    assert.ok(Number(row.cost_usd) > 0, 'and the replay is recorded at it');
    // no usage at all: its text at three characters a token
    const noUsage = await replayOnce({ body, model: 'vendor/fifth-small', workload, reuse: false });
    const asked = body.messages.reduce((a, m) => a + m.content.length, 0);
    const answered = JSON.stringify(right(7)).length;
    assert.ok(Math.abs(noUsage.cost - (pin * Math.ceil(asked / 3) + pout * Math.ceil(answered / 3))) < 1e-15, `${noUsage.cost}`);
    // the language-model judges, the same way
    const pair = await judgePair('a request', 'one answer of some length', 'another answer entirely');
    assert.ok(Math.abs(pair.cost - perCall('judge/small')) < 1e-12, `${pair.cost}`);
    // "at least as good" is read both ways round: two calls, each charged at its price
    const quality = await judgeQuality('another request', 'a first answer', 'a second answer', { scope: workload.workspace_id });
    assert.ok(Math.abs(quality.cost - 2 * perCall('judge/small')) < 1e-12, `${quality.cost}`);
    // a cost the provider does give is taken as it is, even when it is nothing
    costless.set('vendor/steady-small', 'zero');
    const free = await replayOnce({ body, model: 'vendor/steady-small', workload, reuse: false });
    assert.equal(free.cost, 0);
  } finally {
    costless.clear();
  }
});

/* Lower severity ------------------------------------------------------------------------------ */

test('when the customer\'s model turns out not to think, only "thinking less" goes, not "from its cheapest provider"', async () => {
  thinkerReasoning = 0;
  const { workload } = await seed({ model: THINKER, enabled: [] });
  const plan = await planFor(workload, { canRoute: true });
  assert.deepEqual(plan.order.map((o) => o.key).sort(), [`${THINKER}#cheapest`, `${THINKER}#lighter`], 'both planned');
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const ids = (await results(out.runId)).map((r) => r.model_id);
  assert.ok(ids.includes(`${THINKER}#cheapest`), `measured from its cheapest provider: ${ids.join(', ')}`);
  assert.ok(!ids.includes(`${THINKER}#lighter`), 'thinking less means nothing for a model that does not think');
});

test('the customer\'s own model from its cheapest provider is measured as that, while thinking less serves', async () => {
  thinkerReasoning = 50;
  try {
    const { workload } = await seed({ model: THINKER, enabled: [] });
    await promote(await load(workload.id), `${THINKER}#lighter`, { spec: { kind: 'model', model: THINKER, recipe: { reasoning: { effort: 'low' } } }, rollout: false });
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const cheapest = await resultOf(out.runId, `${THINKER}#cheapest`);
    assert.ok(cheapest, 'measured');
    const recipe = JSON.parse(cheapest.recipe_json);
    assert.equal(recipe.pinned, true, `its own recipe, not the one serving: ${cheapest.recipe_json}`);
    assert.equal(recipe.reasoning, undefined);
    assert.ok(await resultOf(out.runId, `${THINKER}#lighter`), 'and what serves is re-checked under its own name');
  } finally {
    thinkerReasoning = 0;
  }
});

test('a workload set never to switch is measured, never switched and never asked about', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'], mode: 'off' });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await resultOf(out.runId, 'vendor/steady-small')).confirm_verdict, 'cleared');
  assert.equal((await load(workload.id)).routed_model, null);
  const waiting = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = 'waiting'`).get(workspace.id);
  assert.equal(Number(waiting.n), 0, 'no "waiting for your approval" email');
  const said = await db.prepare(`SELECT detail FROM activity WHERE workload_id = ? AND title LIKE '%cleared your bar%'`).get(workload.id);
  assert.match(said.detail, /set never to switch/);
  assert.doesNotMatch(said.detail, /approve it/i);
});

test('a workload that asks first still gets its email', async () => {
  const { workspace, workload } = await seed({ enabled: ['vendor/steady-small'], mode: 'ask' });
  await runEvaluation(workload.id);
  const waiting = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND kind = 'waiting'`).get(workspace.id);
  assert.equal(Number(waiting.n), 1);
  assert.equal((await load(workload.id)).routed_model, null);
});

test('our own account refused during the second look ends the run as interrupted, and switches nothing', async () => {
  const { workload } = await seed({ enabled: ['vendor/steady-small'], mode: 'auto' });
  // the bar is a hundred calls to the customer's model; the second look's first call to it is refused
  refusesFrom = countOf(REF) + 101;
  try {
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, false, JSON.stringify(out));
  } finally {
    refusesFrom = null;
  }
  const run = await db.prepare('SELECT * FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
  assert.equal(run.outcome, 'interrupted', 'not "compared", as though nothing had happened');
  assert.match(run.error, /account/);
  assert.equal((await load(workload.id)).routed_model, null);
});

test('a model finished for a strategy goes on from where it stopped, and nothing it bought counts as reused', async () => {
  const { workload } = await seed({ enabled: ['vendor/eighth-small'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const eighth = await resultOf(out.runId, 'vendor/eighth-small');
  assert.equal(eighth.stopped, 'bar', 'dropped part way, then finished for a strategy');
  const twice = await db.prepare(`SELECT call_id FROM eval_replays WHERE run_id = ? AND model_id = ? GROUP BY call_id HAVING COUNT(*) > 1`)
    .all(out.runId, 'vendor/eighth-small');
  assert.equal(twice.length, 0, `${twice.length} of its answers were kept twice`);
  const run = await runOf(out.runId);
  assert.equal(run.reused, run.recorded_refs, 'a first measurement reused nothing an earlier one bought');
});

test('how often chances came true is read only from chances worked out from evidence', async () => {
  forgetCalibration();
  const { workspace, workload } = await seed({ n: 1 });
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, created_at)
      VALUES ('run_cal_fix', ?, ?, 'done', 'json', ?, 10, ?)`).run(workspace.id, workload.id, REF, now() - DAY);
  const add = (k, model, rank, verdict) => db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, verdict, created_at, rank_json)
      VALUES (?, 'run_cal_fix', ?, 10, 1, ?, ?, ?)`).run(`res_cal_fix_${k}`, model, verdict, now(), JSON.stringify(rank));
  // real chances of 0.85 that came true one time in ten
  for (let k = 0; k < 60; k += 1) await add(k, `m/model-${k}`, { rawChance: 0.85, chance: 0.85 }, k % 10 === 0 ? 'cleared' : 'missed');
  // strategies carrying a calibrated chance and no raw one, and fixed guesses, all of which cleared
  for (let k = 0; k < 40; k += 1) await add(100 + k, `cascade:m/model-${k}`, { chance: 0.85 }, 'cleared');
  for (let k = 0; k < 40; k += 1) await add(200 + k, `m/ref-${k}#cheapest`, { rawChance: 0.8, chance: 0.8 }, 'cleared');
  const table = await calibrationFor(workspace.id);
  assert.equal(table.total, 60, 'only the sixty worked out from evidence');
  const p = calibrated(table, 0.85);
  assert.ok(p < 0.25, `a chance of 0.85 that came true one time in ten reads low: ${p}`);
  forgetCalibration();
});
