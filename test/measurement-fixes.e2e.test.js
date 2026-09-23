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
const { nudgeForCatalog } = await import('../src/eval/schedule.js');
const { calibrationFor, calibrated, forgetCalibration } = await import('../src/eval/calibrate.js');
const { planFor } = await import('../src/eval/plan.js');
const { forgetFacts } = await import('../src/models/facts.js');
const { upsertArm, referenceSpec } = await import('../src/learn/arms.js');
const { enqueue } = await import('../src/jobs.js');
const { cheaperCleared, confirmed } = await import('../src/eval/outcome.js');

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost: perCall(model), ...extra } }));
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
/* The hourly pass's own rule for what is due (src/server.js), for one workload. */
const dueNow = async (workloadId) => !!(await db.prepare(
  `SELECT w.id FROM workloads w
    WHERE w.id = ? AND w.state = 'live' AND w.merged_into IS NULL
      AND ((w.recheck_after IS NOT NULL AND w.recheck_after <= ?)
        OR (w.recheck_after IS NULL
            AND COALESCE((SELECT MAX(r.created_at) FROM eval_runs r WHERE r.workload_id = w.id), 0) < ?))`)
  .get(workloadId, now(), now() - 30 * DAY));

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
