/* A model whose provider cannot keep up (EVAL_KEEP_UP_REFUSALS, the owner's rule of 26 Sep 2026), end to end on a real
   database, through real measurements against a provider we control.

   What is checked: a model turned away for coming too fast even while it is given the longest wait fails its test as
   "couldn't keep up", whether it is never answered or answered in the end after the refusals (the way Cydonia 24B was,
   which held a test at the longest wait for an hour); a model turned away only while its wait was still growing does
   not; a model that answers as it should is untouched; the next test of that workload leaves the failed ones out for
   good, saying why, while another workload still tries them; the page says what happened; the model serving the
   workload is never held to it; and a model that cannot keep up on its second look fails there, and the next in line
   gets its look. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PROVIDER_PORT = 4911;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_keepup_${process.pid}`;
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
// the longest wait reached within two refusals, and every wait kept short, so a test of this runs in seconds
process.env.MODEL_BACKOFF_START_MS = '5';
process.env.MODEL_BACKOFF_MAX_MS = '10';
process.env.MODEL_BACKOFF_EASE_AFTER = '20';
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

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const auth = await import('../src/auth.js');
const { move } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { runPageOf } = await import('../src/workloadPage.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { planFor } = await import('../src/eval/plan.js');
const { forgetFleet } = await import('../src/eval/history.js');
const { default: config } = await import('../src/config.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
// answers every request the way the customer's model does
const STEADY = 'vendor/steady-small';
// turns every request away for coming too fast
const CROWDED = 'vendor/crowded-small';
// turns two tries in three away and answers the third: never "fails", only slows everything down
const SLOWPOKE = 'vendor/slowpoke-small';
// turned away only its first two tries ever, while its wait was still growing
const JITTERY = 'vendor/jittery-small';
// answers every request of its first look, then cannot keep up on its second
const FADING = 'vendor/fading-small';
// turned away twice at the longest wait on its first look, and once more on its second: three in the test
const TWICE = 'vendor/twice-small';
// right on every request, and cannot keep up once its first look is done
const ABLE = 'vendor/able-small';
// right on the short requests only, so a router sends it those and ABLE the long ones
const TINY = 'vendor/tiny-small';
const JUDGE = 'judge/small';
const MODELS = [STEADY, CROWDED, SLOWPOKE, JITTERY, FADING, TWICE, ABLE, TINY];
const DAY = 86400000;
// the long requests, one in eight: told apart before they are sent, which is what a router needs
const hard = (i) => i % 8 === 3;

/* The provider. The customer's model and every model that answers give the same JSON for a request, so every model that
   answers matches; what differs is only whether and when each is turned away for coming too fast. */
const right = (i) => ({ total: 100 + i, currency: 'USD', lines: (i % 5) + 1 });
const indexOf = (text) => Number((String(text).match(/#(\d+)/) || [])[1] || 0);
const asked = new Map();
const answered = new Map();
const tries = (m) => asked.get(m) || 0;
const got = (m) => answered.get(m) || 0;
// the workload each of these is tested on, whose running test says how many requests its first look has
let fadingOn = null;
let twiceOn = null;
let ableOn = null;
// TWICE's tries once its first look is done
let twiceLater = 0;
const firstLookSize = async (wid) => Number((await db.prepare(`SELECT sample_size FROM eval_runs WHERE workload_id = ? AND status = 'running'
    ORDER BY created_at DESC LIMIT 1`).get(wid))?.sample_size ?? Infinity);
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = JSON.parse(body || '{}');
    const m = p.model;
    asked.set(m, tries(m) + 1);
    const user = String(p.messages?.find((x) => x.role === 'user')?.content ?? '');
    const refuse = () => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0.001' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded, slow down' } }));
    };
    const send = (content, cost) => {
      answered.set(m, got(m) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model: m,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost } }));
    };
    if (m === JUDGE) return send('SAME', 0.00001);
    if (m === CROWDED) return refuse();
    if (m === SLOWPOKE && tries(m) % 3 !== 0) return refuse();
    if (m === JITTERY && tries(m) <= 2) return refuse();
    if (m === FADING && fadingOn && got(m) >= await firstLookSize(fadingOn)) return refuse();
    if (m === ABLE && ableOn && got(m) >= await firstLookSize(ableOn)) return refuse();
    if (m === TWICE && twiceOn) {
      if (got(m) >= await firstLookSize(twiceOn)) {
        // its second look: three refusals in a row, of which only the last is sent at the longest wait
        twiceLater += 1;
        if (twiceLater <= 3) return refuse();
      } else if ([1, 2, 4, 5].includes(tries(m))) {
        // its first look, asked one request at a time: the first two raise its wait to the longest, the next two are refused at it
        return refuse();
      }
    }
    const i = indexOf(user);
    if (m === TINY) return send(JSON.stringify(hard(i) ? { total: 0, currency: 'EUR', lines: 0 } : right(i)), 0.00005);
    const cost = m === REF ? 0.002 : m === ABLE ? 0.0006 : [FADING, TWICE].includes(m) ? 0.0001 : 0.0002;
    return send(JSON.stringify(right(i)), cost);
  });
});

test.before(async () => {
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: STEADY, name: 'Vendor: Steady Small', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 0, zdr: 1 },
    { model_id: CROWDED, name: 'Vendor: Crowded Small', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 0, zdr: 1 },
    { model_id: SLOWPOKE, name: 'Vendor: Slowpoke Small', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 0, zdr: 1 },
    { model_id: JITTERY, name: 'Vendor: Jittery Small', context_len: 128000, price_in: 0.15e-6, price_out: 0.4e-6, open_weights: 0, zdr: 1 },
    { model_id: FADING, name: 'Vendor: Fading Small', context_len: 128000, price_in: 0.05e-6, price_out: 0.15e-6, open_weights: 0, zdr: 1 },
    { model_id: TWICE, name: 'Vendor: Twice Small', context_len: 128000, price_in: 0.05e-6, price_out: 0.15e-6, open_weights: 0, zdr: 1 },
    { model_id: ABLE, name: 'Vendor: Able Small', context_len: 128000, price_in: 0.6e-6, price_out: 1.8e-6, open_weights: 0, zdr: 1 },
    { model_id: TINY, name: 'Vendor: Tiny Small', context_len: 128000, price_in: 0.02e-6, price_out: 0.06e-6, open_weights: 0, zdr: 1 },
    { model_id: JUDGE, name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => provider.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);
const rowsOf = async (runId) => new Map((await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId)).map((r) => [r.model_id, r]));

/* A workspace with one workload of `n` requests, recorded the way the customer's own model answered them, trying only
   `models`: every other model in the catalogue is switched off for it. `long` makes the hard requests look different
   before they are sent, which a router needs; `mode` is what happens when a model passes ('ask' unless said). */
let seq = 0;
async function seeded({ n = 300, models, long = false, mode = 'ask' }) {
  seq += 1;
  const { workspace } = await auth.createAccount({ email: `keepup-${seq}-${process.pid}@example.test`, password: 'correct-horse', name: `k${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(mode, workspace.id);
  let wl = null;
  for (let i = 0; i < n; i += 1) {
    const request = { model: REF, messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}, set ${seq}.` },
      { role: 'user', content: `document #${String(i).padStart(4, '0')}${long && hard(i) ? ` ${'with a long table of line items, '.repeat(24)}` : ''}` }],
      response_format: { type: 'json_object' } };
    wl = wl || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: wl.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0, request,
      response: { choices: [{ message: { content: JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?').run(now() - DAY, wl.id);
  for (const m of [...MODELS, JUDGE]) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, models.includes(m) ? 1 : 0, now());
  }
  return { workspace, workload: await load(wl.id) };
}

let first = null;

test("a model its provider cannot keep up with fails as unable to keep up, answered in the end or not; one refused only while its wait grew does not", async () => {
  const { workload: w } = await seeded({ models: [STEADY, CROWDED, SLOWPOKE, JITTERY] });
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  first = { w, runId: out.runId };
  const rows = await rowsOf(out.runId);
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);

  const crowded = rows.get(CROWDED);
  assert.equal(crowded.verdict, 'failed', 'never answered: failed');
  assert.equal(crowded.stopped, 'busy', `and failed as unable to keep up, not only for errors: ${crowded.stopped}`);
  assert.ok(tries(CROWDED) <= 16, `stopped at once, not held at the longest wait for every request: ${tries(CROWDED)} tries`);

  const slow = rows.get(SLOWPOKE);
  assert.equal(slow.verdict, 'failed', 'answered in the end, but only after being turned away at the longest wait: failed too');
  assert.equal(slow.stopped, 'busy');
  assert.ok(got(SLOWPOKE) > 0, 'its provider did answer some of its requests');
  assert.ok(Number(slow.runs) < Number(run.sample_size) / 4, `stopped after a few of its ${run.sample_size} requests: ${slow.runs}`);

  const jittery = rows.get(JITTERY);
  assert.notEqual(jittery.stopped, 'busy', 'turned away only while its wait was still growing: not held against it');
  assert.equal(jittery.verdict, 'cleared', `it answered everything as the customer's model does: ${jittery.verdict}`);
  assert.equal(Number(jittery.runs), Number(run.sample_size));

  const steady = rows.get(STEADY);
  assert.equal(steady.verdict, 'cleared');
  assert.equal(steady.stopped, null);
});

test('the next test of that workload leaves the models that could not keep up out for good, saying why; another workload still tries them', async () => {
  assert.ok(first, 'needs the test before');
  forgetFleet();
  const plan = await planFor(await load(first.w.id), { canRoute: true });
  const out = new Map(plan.excluded.map((e) => [e.model, e]));
  for (const m of [CROWDED, SLOWPOKE]) {
    assert.equal(out.get(m)?.step, 'busy', `${m} is left out as unable to keep up: ${JSON.stringify(out.get(m))}`);
    assert.match(out.get(m).reason, /couldn't keep up/);
  }
  const tried = plan.order.map((o) => o.model);
  assert.ok(tried.includes(STEADY) && tried.includes(JITTERY), `the others are tried as before: ${tried.join(', ')}`);
  assert.ok(!tried.includes(CROWDED) && !tried.includes(SLOWPOKE));

  // the ban is this workload's: another workload, even in another workspace, still tries them
  const { workload: other } = await seeded({ n: 300, models: [STEADY, CROWDED, SLOWPOKE] });
  const theirs = await planFor(other, { canRoute: true });
  const theirsTried = theirs.order.map((o) => o.model);
  assert.ok(theirsTried.includes(CROWDED) && theirsTried.includes(SLOWPOKE), `another workload still tries them: ${theirsTried.join(', ')}`);
  assert.equal(theirs.excluded.some((e) => e.step === 'busy'), false);
});

test("the test's page says a model could not keep up, and why", async () => {
  assert.ok(first, 'needs the first test');
  const w = await load(first.w.id);
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(first.runId);
  const page = await runPageOf(w, run);
  for (const m of [CROWDED, SLOWPOKE]) {
    const c = page.cands.find((x) => x.key === m);
    assert.ok(c, `${m} is on the page`);
    assert.equal(c.verdict, "Couldn't keep up");
    assert.equal(c.tone, 'bad');
    assert.match(c.why, /kept turning this test's requests away for coming too fast/);
    assert.match(c.why, /won't be tested on this workload again/);
  }
  const jittery = page.cands.find((x) => x.key === JITTERY);
  assert.notEqual(jittery.verdict, "Couldn't keep up");
});

// an earlier test of the workload, finished, that found `model` could not keep up, as the app writes one down
async function busyOnRecord(w, model) {
  const rid = id('run');
  const at = now() - DAY;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, floor_pct, noise_pct,
      spend_usd, started_at, finished_at, created_at, trigger, outcome, yardstick)
    VALUES (?, ?, ?, 'done', ?, ?, 100, 3, 1, 0.1, ?, ?, ?, 'manual', 'compared', 'agreement')`)
    .run(rid, w.workspace_id, w.id, w.shape_kind, REF, at - 600000, at, at - 600000);
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, stopped, created_at)
    VALUES (?, ?, ?, 3, 0, 30, 'failed', 'busy', ?)`).run(id('res'), rid, model, at);
}

test('the model serving a workload is never held to keeping up: it is carrying the workload now', async () => {
  const { workload: w0 } = await seeded({ models: [STEADY, CROWDED] });
  await db.prepare('UPDATE workloads SET routed_model = ? WHERE id = ?').run(CROWDED, w0.id);
  const out = await runEvaluation(w0.id);
  assert.ok(out.runId, JSON.stringify(out));
  const row = (await rowsOf(out.runId)).get(CROWDED);
  assert.ok(row, 'what serves is checked again');
  assert.notEqual(row.stopped, 'busy', `it may fail for its errors, never as unable to keep up: ${row.stopped}`);
  // even with a test of this workload on record that found it could not keep up, what serves is re-checked, never left out
  await db.prepare('UPDATE workloads SET routed_model = ? WHERE id = ?').run(CROWDED, w0.id);
  await busyOnRecord(await load(w0.id), CROWDED);
  forgetFleet();
  const plan = await planFor(await load(w0.id), { canRoute: true });
  assert.equal(plan.excluded.some((e) => e.model === CROWDED && e.step === 'busy'), false, 'what serves is never left out for it');
  assert.ok(plan.order.some((o) => o.model === CROWDED), `it is checked again as ever: ${plan.order.map((o) => o.model).join(', ')}`);
  // and once it no longer serves, the same record keeps it out
  await db.prepare('UPDATE workloads SET routed_model = NULL WHERE id = ?').run(w0.id);
  const later = await planFor(await load(w0.id), { canRoute: true });
  assert.equal(later.excluded.find((e) => e.model === CROWDED)?.step, 'busy');
});

test('a limit of none switches the rule off: a model its provider cannot keep up with is only slowed, as before', async () => {
  const was = config.EVAL_KEEP_UP_REFUSALS;
  config.EVAL_KEEP_UP_REFUSALS = 0;
  try {
    const { workload: w } = await seeded({ models: [STEADY, CROWDED] });
    const out = await runEvaluation(w.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await rowsOf(out.runId);
    assert.notEqual(rows.get(CROWDED).stopped, 'busy', `never failed as unable to keep up: ${rows.get(CROWDED).stopped}`);
    // read as "none needed", a limit of zero failed every model after its first request, this one included
    assert.equal(rows.get(STEADY).stopped, null, 'and a model that answers is never failed for it');
    assert.equal(rows.get(STEADY).verdict, 'cleared');
    forgetFleet();
    const plan = await planFor(await load(w.id), { canRoute: true });
    assert.equal(plan.excluded.some((e) => e.step === 'busy'), false);
  } finally {
    config.EVAL_KEEP_UP_REFUSALS = was;
  }
});

test('the refusals are counted over the whole test: two at the longest wait on its first look and one on its second fail it', async () => {
  const width = config.EVAL_CALLS_PER_MODEL;
  // one request at a time, so which of its tries are sent at the longest wait is fixed
  config.EVAL_CALLS_PER_MODEL = 1;
  const { workload: w } = await seeded({ models: [STEADY, TWICE] });
  twiceOn = w.id;
  try {
    const out = await runEvaluation(w.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await rowsOf(out.runId);
    const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
    const twice = rows.get(TWICE);
    assert.equal(Number(twice.runs), Number(run.sample_size), `its first look finished, two not being three: ${twice.runs}`);
    assert.equal(twice.confirm_verdict, 'busy', `the one on its second look made three, and failed it: ${twice.confirm_verdict}`);
    assert.equal(twice.stopped, 'busy');
    assert.equal(twice.verdict, 'failed');
    assert.equal(rows.get(STEADY).confirm_verdict, 'cleared', 'and the next in line got its look');
  } finally {
    twiceOn = null;
    config.EVAL_CALLS_PER_MODEL = width;
  }
});

test('a router whose look finds one of its models cannot keep up fails with it, and that model is never looked at or switched to', async () => {
  const { workload: w } = await seeded({ models: [ABLE, TINY], long: true, mode: 'auto' });
  ableOn = w.id;
  try {
    const out = await runEvaluation(w.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await rowsOf(out.runId);
    const said = [...rows.values()].map((r) => `${r.model_id} ${r.verdict} ${r.stopped ?? ''} ${r.confirm_verdict ?? ''}`).join('; ');
    const router = [...rows.values()].find((r) => String(r.model_id).startsWith('router:'));
    assert.ok(router, `a router was worked out: ${said}`);
    assert.ok(JSON.parse(router.arm_json).options.some((o) => o.model === ABLE), `it sends ABLE the long requests: ${router.arm_json}`);
    const able = rows.get(ABLE);
    assert.equal(able.stopped, 'busy', said);
    assert.equal(able.verdict, 'failed');
    assert.equal(router.stopped, 'busy', `the router fails with the model it sends calls to: ${said}`);
    assert.equal(router.verdict, 'failed');
    // whichever was looked at first found ABLE out, and the other was never looked at: before, it was, and could be switched to
    const looked = [router, able].filter((r) => r.confirm_verdict !== null);
    assert.equal(looked.length, 1, `one look, not two: ${said}`);
    assert.equal(looked[0].confirm_verdict, 'busy');
    const after = await load(w.id);
    assert.equal(after.routed_model, null, 'nothing was switched to');
    // nor is either said to have cleared once and to be waiting for a look, with a way to approve it that could not work
    assert.notEqual(after.status_note, 'A candidate cleared once and needs a second look', `${after.status}: ${after.status_note}`);
    const said2 = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(w.id);
    assert.doesNotMatch(String(said2?.title ?? ''), /cleared your bar .* once/, `what the run said: ${said2?.title}`);
    const trying = await db.prepare(`SELECT key FROM arms WHERE workload_id = ? AND status = 'trying'`).all(w.id);
    assert.deepEqual(trying, [], 'and live experiments try neither');
  } finally {
    ableOn = null;
  }
});

test('a model that cannot keep up on its second look fails there, and the next in line gets its look', async () => {
  const { workload: w } = await seeded({ models: [STEADY, FADING] });
  fadingOn = w.id;
  try {
    const out = await runEvaluation(w.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await rowsOf(out.runId);
    const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
    const fading = rows.get(FADING);
    assert.equal(fading.confirm_verdict, 'busy', `its second look ended as unable to keep up: ${fading.confirm_verdict}`);
    assert.equal(fading.verdict, 'failed', 'and its row says it failed');
    assert.equal(fading.stopped, 'busy');
    assert.match(fading.confirm_note, /cannot keep up/);
    assert.ok(Number(fading.runs) === Number(run.sample_size), `it answered every request of its first look: ${fading.runs}`);
    const steady = rows.get(STEADY);
    assert.equal(steady.confirm_verdict, 'cleared', `the next in line got its look, and passed it: ${steady.confirm_verdict}`);
    forgetFleet();
    const plan = await planFor(await load(w.id), { canRoute: true });
    assert.equal(plan.excluded.find((e) => e.model === FADING)?.step, 'busy', 'and the next test leaves it out');
  } finally {
    fadingOn = null;
  }
});
