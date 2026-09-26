/* A workload's page, as its four questions (src/workloadPage.js), end to end on a real database and through the
   page's own routes.

   What is checked: whether there is enough traffic to optimize, counted the way a test counts it, by count alone
   however many arrive in a day, and how many more a test needs; every measurement in a word, whatever it ended as; the
   calls and who answered each; and once switched, what Understudy is doing: the share the cheaper setup answers,
   what a request costs before and now, saved this month and on track for, the daily checks against the customer's
   own model, and the speed. One measurement opened: the sentence of what it found and every setup it tried, placed
   by cost against how often it answered differently. The routes, for their owner only. And the workspace's one
   choice of what happens when a cheaper setup passes: Automatic unless it is changed, and every workload follows.
   The records are written the way the app writes them, so every figure can be worked out by hand. */

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const APP_PORT = 4872;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_page_${process.pid}`;
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
process.env.OPENROUTER_BASE = 'http://127.0.0.1:9/api/v1';
process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.ALERTS_ENABLED = 'false';
process.env.REQUEST_LOGS = 'false';
process.env.RESEND_API_KEY = '';
process.env.STARTER_CREDIT_USD = '0';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.CONTROL_ENABLED = 'false';
delete process.env.DEFAULT_OPTIMIZE_MODE;

const { db, now, id } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { default: config } = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { move, withFee } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { learningSettled, workloadFor } = await import('../src/traffic.js');
const { pageOf, runPageOf, callsOf } = await import('../src/workloadPage.js');
const { routedSavings } = await import('../src/eval/actual.js');
const { poolOf } = await import('../src/eval/run.js');
const { optimizingSince } = await import('../src/eval/value.js');
const { armKey, labelOf } = await import('../src/learn/arms.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const CHEAP = 'vendor/steady-small';
const OTHER = 'vendor/other-model';
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const FEE = 1 + config.ROUTING_FEE_PCT / 100;
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} against ${b}`);
let server = null;
const base = `http://127.0.0.1:${APP_PORT}`;

test.before(async () => {
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: CHEAP, name: 'steady', context_len: 128000, price_in: 0.2e-6, price_out: 0.6e-6, open_weights: 1, zdr: 1 },
    { model_id: OTHER, name: 'other', context_len: 128000, price_in: 0.1e-6, price_out: 0.4e-6, open_weights: 1, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
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
  const email = `page-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password: 'correct-horse-battery', name: `p${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 20, note: 'test' });
  return { ws: workspace, email };
}
const hex = () => `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);

async function workload(ws, slug, { shape = 'json', floor = null, mode = 'auto', waitFor = null, recheck = null } = {}) {
  const wid = id('wl');
  const t = now() - 40 * DAY;
  await db.prepare(`INSERT INTO workloads (id, workspace_id, slug, fingerprint, shape_kind, reference_model, optimize_mode, status,
      floor_pct, sample_prompt, tool_names, created_at, updated_at, calls_seen, state, named_at, name_source, recheck_after, recheck_streak,
      measure_at_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, 'Answer.', '[]', ?, ?, 0, 'live', ?, 'model', ?, 0, ?)`)
    .run(wid, ws.id, slug, hex(), shape, REF, mode, floor, t, t, t, recheck, waitFor);
  return wid;
}
async function arm(ws, wid, spec, { ratio = null, at = now() } = {}) {
  const aid = id('arm');
  await db.prepare(`INSERT INTO arms (id, workspace_id, workload_id, kind, key, spec_json, label, status, origin_run_id, offline_json,
      stats_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'serving', NULL, ?, NULL, ?, ?)`)
    .run(aid, ws.id, wid, spec.kind, armKey(spec), JSON.stringify(spec), labelOf(spec, REF), JSON.stringify({ verdict: 'cleared', ratio }), at, at);
  return aid;
}
const switchTo = (wid, { model, armId, at, runId = null, rollout = null }) => db.prepare(`UPDATE workloads SET routed_model = ?, routed_arm_id = ?,
    promoted_at = ?, promoted_run_id = ?, status = 'promoted', rollout_share = ? WHERE id = ?`).run(model, armId, at, runId, rollout, wid);

async function call(ws, wid, c) {
  const cid = id('call');
  const cost = c.cost ?? 0.004;
  const status = c.status === undefined ? 200 : c.status;
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model, status_code, prompt_tokens,
      completion_tokens, cost_usd, charged_usd, latency_ms, request_json, response_json, created_at, request_hash, arm_id, escalated, explored,
      check_json, cost_estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1200, 40, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 0)`)
    .run(cid, ws.id, wid, c.source ?? 'routed', REF, c.served ?? REF, status, cost,
      c.charged ?? (c.source === 'trace' || (status !== null && status !== 200) ? 0 : cost * FEE), c.lat ?? 1000,
      c.noText ? null : '{"messages":[{"role":"user","content":"hello"}]}', Math.round(c.at), hex(), c.arm ?? null, c.escalated ?? null,
      c.explored ?? null, c.check ? JSON.stringify(c.check) : null);
  return cid;
}

async function run(ws, wid, { at, trigger = 'automatic', outcome = 'compared', status = 'done', sample = 120, floor = 3, noise = 1, spend = 0.1,
  yardstick = 'agreement', results = [], refCost = 0.004, refP50 = 2000 }) {
  const rid = id('run');
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, shape_kind, reference_model, sample_size, floor_pct, noise_pct,
      spend_usd, started_at, finished_at, created_at, trigger, outcome, yardstick, ref_latency_p50)
    VALUES (?, ?, ?, ?, 'json', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rid, ws.id, wid, status, REF, sample, floor, noise, spend, at - 11 * MIN, status === 'running' ? null : at, at - 11 * MIN, trigger,
      status === 'running' ? null : outcome, yardstick, refP50);
  await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, cost_month_usd, verdict, created_at)
    VALUES (?, ?, ?, ?, 0, 300, 'reference', ?)`).run(id('res'), rid, REF, sample * 2, at);
  // the customer's own model's answers in this measurement, which a request's cost is read from
  for (let i = 0; i < 4; i += 1) {
    await db.prepare(`INSERT INTO eval_replays (id, run_id, call_id, model_id, slot, reused, status, cost_usd, created_at)
      VALUES (?, ?, NULL, ?, ?, 0, 200, ?, ?)`).run(id('rep'), rid, REF, i, refCost, at);
  }
  for (const r of results) {
    await db.prepare(`INSERT INTO eval_results (id, run_id, model_id, runs, gap_pct, gap_lo, gap_hi, cost_month_usd, verdict, created_at, arm_json,
        cost_ratio, latency_p50, stopped, calls_needed, confirm_verdict, confirm_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, 30, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('res'), rid, r.key, r.runs ?? sample, r.gap ?? 0, r.lo ?? 0, r.hi ?? 2, r.verdict, at, r.spec ? JSON.stringify(r.spec) : null,
        'ratio' in r ? r.ratio : 0.1, 'p50' in r ? r.p50 : 900, r.stopped ?? null, r.needed ?? null, r.confirm ?? null, r.confirmRuns ?? null);
  }
  return rid;
}

/* 1. Enough data to optimize? ---------------------------------------------------------------------- */

test('a busy day counts whole: 180 requests on one day are enough for a test that needs 176', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'one-busy-day');
  const today = Math.floor(now() / DAY);
  for (let i = 0; i < 180; i += 1) await call(ws, wid, { at: today * DAY + i * 1000 });
  const { enough } = await pageOf(await load(wid));
  assert.equal(enough.have, 180, 'every one of the day\'s requests counts');
  assert.equal(enough.need, 176);
  assert.equal(enough.yes, true, 'so a test can run the day they arrive');
  assert.equal(enough.daily[29].counted, 180);
  assert.equal('earliest' in enough || 'steps' in enough || 'perDay' in enough, false, 'no day-by-day schedule to wait for');
});

test('the requests a test counts stop at the most it draws on, however many there are', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'capped');
  const today = Math.floor(now() / DAY);
  const was = config.EVAL_POOL_MAX;
  config.EVAL_POOL_MAX = 25;
  try {
    for (let i = 0; i < 40; i += 1) await call(ws, wid, { at: today * DAY + i * 1000 });
    assert.equal((await pageOf(await load(wid))).enough.have, 25, 'held to the pool, not to a day');
  } finally { config.EVAL_POOL_MAX = was; }
});

test('a test draws on every day in turn: a busy day fills in, and never crowds the quiet days out', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'spread');
  const today = Math.floor(now() / DAY);
  for (let i = 0; i < 100; i += 1) await call(ws, wid, { at: today * DAY + i * 1000 });
  for (let d = 1; d <= 4; d += 1) for (let i = 0; i < 5; i += 1) await call(ws, wid, { at: (today - d) * DAY + i * 1000 });
  const byDay = (rows) => rows.reduce((a, r) => { const k = Math.floor(Number(r.created_at) / DAY); a[k] = (a[k] || 0) + 1; return a; }, {});
  const some = byDay(await poolOf(wid, { max: 30 }));
  for (let d = 1; d <= 4; d += 1) assert.equal(some[today - d], 5, 'every quiet day is taken whole');
  assert.equal(some[today], 10, 'and the busy day fills the rest');
  assert.equal((await poolOf(wid, { max: 1000 })).length, 120, 'with room, every request is in');
  assert.equal((await pageOf(await load(wid))).enough.have, 120, 'and counted, the busy day whole');
});

test('enough data is counted the way a test counts it: its own requests with their text, not failed, however many a day', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'counting');
  const today = Math.floor(now() / DAY);
  // 70 today, 10 yesterday, 3 failed, 2 with no text kept, 4 tests and replays that never count
  for (let i = 0; i < 70; i += 1) await call(ws, wid, { at: today * DAY + i * 1000 });
  for (let i = 0; i < 10; i += 1) await call(ws, wid, { at: (today - 1) * DAY + i * 1000 });
  for (let i = 0; i < 3; i += 1) await call(ws, wid, { at: (today - 2) * DAY + i * 1000, status: 502 });
  for (let i = 0; i < 2; i += 1) await call(ws, wid, { at: (today - 3) * DAY + i * 1000, noText: true });
  for (let i = 0; i < 2; i += 1) await call(ws, wid, { at: (today - 1) * DAY + 5000 + i, source: 'test' });
  for (let i = 0; i < 2; i += 1) await call(ws, wid, { at: (today - 1) * DAY + 6000 + i, source: 'replay' });
  const { enough } = await pageOf(await load(wid));
  assert.equal(enough.have, 80, 'all seventy from today and ten from yesterday');
  assert.equal(enough.need, 176, 'a structured workload\'s first bar, 3%, takes 176 of them');
  assert.equal(enough.yes, false);
  assert.equal(enough.daily.length, 30);
  const last = enough.daily[29];
  assert.equal(last.d, today);
  assert.equal(last.n, 70, 'every request of the day is drawn');
  assert.equal(last.counted, 70, 'and every one of them counts');
  assert.equal(enough.daily[27].n, 3, 'the failed ones are drawn');
  assert.equal(enough.daily[27].counted, 0, 'and not counted');
  assert.equal(enough.daily[26].counted, 0, 'nor the ones whose text is not kept');
  assert.equal(enough.daily[28].n, 10, 'tests and replays are not requests');
  assert.equal(enough.total, 85);

  // left waiting for a count already: that count is what it needs, and reaching it is enough
  await db.prepare('UPDATE workloads SET measure_at_calls = 80 WHERE id = ?').run(wid);
  const again = (await pageOf(await load(wid))).enough;
  assert.equal(again.need, 80);
  assert.equal(again.yes, true, 'eighty of eighty, whichever days they came on');

  // written answers have a looser first bar, 10%, and need fewer
  const text = await workload(ws, 'counting-text', { shape: 'free_text' });
  await call(ws, text, { at: today * DAY + 1 });
  assert.equal((await pageOf(await load(text))).enough.need, 50);
});

test('a workload with enough says so, with what a test uses, and when it is next tested by itself', async () => {
  const { ws } = await account();
  const next = now() + 12 * DAY;
  const wid = await workload(ws, 'plenty', { recheck: next });
  const today = Math.floor(now() / DAY);
  for (let d = 0; d < 5; d += 1) for (let i = 0; i < 60; i += 1) await call(ws, wid, { at: (today - d) * DAY + i * 1000 });
  const { enough } = await pageOf(await load(wid));
  assert.equal(enough.yes, true);
  assert.equal(enough.have, 300);
  assert.equal(enough.sample, config.EVAL_SAMPLE_MAX, 'a test uses 120 of them');
  assert.equal(enough.everyDays, config.MEASURE_EVERY_DAYS);
  assert.equal(enough.nextAt, next);
  // a workspace that tests only when asked has nothing booked
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(ws.id);
  const asked = (await pageOf(await load(wid))).enough;
  assert.equal(asked.everyDays, 0);
  assert.equal(asked.nextAt, null);
});

/* 2. Every measurement ----------------------------------------------------------------------------- */

test('every measurement is a line: when, what started it, how many requests, how long, what it cost, and what it found', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'history');
  const t = now();
  const first = await run(ws, wid, { at: t - 20 * DAY, trigger: 'first', results: [{ key: CHEAP, verdict: 'cleared' }] });
  const mine = await run(ws, wid, { at: t - 10 * DAY, trigger: 'manual', sample: 27, spend: 0.13, results: [{ key: CHEAP, verdict: 'review', needed: 90, runs: 27 }] });
  const unsure = await run(ws, wid, { at: t - 9 * DAY, outcome: 'unmeasurable', noise: 63.6, results: [] });
  const refused = await run(ws, wid, { at: t - 8 * DAY, outcome: 'refused', results: [] });
  const broke = await run(ws, wid, { at: t - 7 * DAY, outcome: 'no_balance', results: [] });
  const cut = await run(ws, wid, { at: t - 6 * DAY, status: 'stopped', outcome: 'stopped', results: [] });
  const lost = await run(ws, wid, { at: t - 5 * DAY, status: 'failed', outcome: null, results: [] });
  const twice = await run(ws, wid, { at: t - 4 * DAY, results: [{ key: CHEAP, verdict: 'cleared', confirm: 'cleared', confirmRuns: 100 }] });
  const nothing = await run(ws, wid, { at: t - 3 * DAY, results: [{ key: CHEAP, verdict: 'missed', gap: 9 }] });
  const going = await run(ws, wid, { at: t - MIN, status: 'running', results: [] });
  const { measurements: m } = await pageOf(await load(wid));
  const by = Object.fromEntries(m.map((x) => [x.id, { ...x, tag: { tone: x.tag.tone, text: x.tag.text } }]));
  // every tag says what it means, for its hover
  for (const x of m) assert.ok(x.tag.why && x.tag.why.length > 20, `${x.tag.text} says what it means`);
  assert.equal(m[0].id, going, 'newest first');
  assert.deepEqual(by[going].tag, { tone: 'brand', text: 'Testing now' });
  assert.equal(by[going].live, true);
  assert.equal(by[going].mins, null);
  assert.equal(by[first].what, 'First test');
  assert.deepEqual(by[first].tag, { tone: 'ok', text: '1 model passed' });
  assert.equal(by[mine].what, 'Started manually');
  assert.equal(by[mine].n, 27);
  assert.equal(by[mine].mins, 11);
  near(by[mine].usd, withFee(0.13), 'what it cost the customer, our fee included');
  assert.deepEqual(by[mine].tag, { tone: 'warn', text: 'Close match' });
  assert.equal(by[twice].what, 'Regular re-test');
  assert.deepEqual(by[twice].tag, { tone: 'ok', text: 'Passed twice' });
  // a test that compared nothing says which way it ended, rather than "could not measure"
  assert.deepEqual(by[unsure].tag, { tone: 'bad', text: "Couldn't compare models" });
  assert.deepEqual(by[refused].tag, { tone: 'bad', text: 'Not enough valid results' });
  assert.deepEqual(by[broke].tag, { tone: 'warn', text: 'Balance ran out' });
  assert.deepEqual(by[cut].tag, { tone: 'mut', text: 'Stopped' });
  assert.deepEqual(by[lost].tag, { tone: 'mut', text: 'Test incomplete' });
  assert.deepEqual(by[nothing].tag, { tone: 'mut', text: 'No match yet' });
});

test('once switched, the measurement that switched says so, and one that finds what serves still keeps the bar says that', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'switched-history');
  const t = now();
  const spec = { kind: 'model', model: CHEAP, recipe: null };
  const armId = await arm(ws, wid, spec, { ratio: 0.1, at: t - 10 * DAY });
  const made = await run(ws, wid, { at: t - 10 * DAY, trigger: 'first', results: [
    { key: CHEAP, verdict: 'cleared', confirm: 'cleared', confirmRuns: 100, gap: 1, ratio: 0.1 },
    { key: OTHER, verdict: 'cleared', gap: 2, ratio: 0.05 }] });
  await switchTo(wid, { model: CHEAP, armId, at: t - 10 * DAY + MIN, runId: made });
  const kept = await run(ws, wid, { at: t - 2 * DAY, results: [{ key: CHEAP, verdict: 'cleared', gap: 1 }, { key: OTHER, verdict: 'missed', gap: 8 }] });
  const w = await load(wid);
  const by = Object.fromEntries((await pageOf(w)).measurements.map((x) => [x.id, x]));
  assert.equal(by[made].tag.text, 'Passed, switched');
  assert.equal(by[made].tag.tone, 'brand');
  assert.equal(by[kept].tag.text, 'Still passing');
  assert.equal(by[kept].tag.tone, 'ok');

  // opened: the one it switched to is the one serving, named as such, and in the run that switched to it, it is a candidate like the rest
  const madePage = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(made));
  // a model named the way people know it, from the catalogue
  assert.equal(madePage.take, 'steady passed, then passed again on 100 new requests it had never seen, so Understudy switched to it.');
  assert.equal(madePage.cands.find((c) => c.key === CHEAP).verdict, 'Passed twice');
  const keptPage = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(kept));
  assert.equal(keptPage.cands.find((c) => c.key === CHEAP).verdict, 'Still passing');
  assert.equal(keptPage.take, 'The model in use is still within the allowed difference of the original model, gpt-5.4. No cheaper model passed, so nothing changes.');
});

test('an opened measurement places every setup by what a request costs on it, and says in a sentence what it found', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'opened', { waitFor: 176 });
  const t = now();
  const small = await run(ws, wid, { at: t - DAY, trigger: 'manual', sample: 27, floor: 3, refCost: 0.0036, results: [
    { key: CHEAP, verdict: 'review', needed: 90, runs: 27, gap: 0, lo: 0, hi: 9.1, ratio: 0.1, p50: 1400 },
    { key: OTHER, verdict: 'missed', runs: 27, gap: 11.1, lo: 5, hi: 25, ratio: 0.05, p50: 1200 },
    { key: 'vendor/dropped', verdict: 'missed', runs: 10, gap: 30, lo: 14, hi: 56, stopped: 'bar', ratio: 0.03, p50: 700 },
    { key: 'vendor/refuses', verdict: 'failed', runs: 0, gap: null, stopped: 'refused', ratio: null, p50: null },
  ] });
  const w = await load(wid);
  const rp = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(small));
  assert.match(rp.take, new RegExp('^This test used 27 requests, too few to switch anything\\. Showing that a model answers differently from the '
    + 'original model on under 3% of requests takes at least 88\\. The full test needs 176 recent requests, so the result can be checked again '
    + "on new ones, and starts by itself when they're in: you have \\d+ so far\\.$"), rp.take);
  near(rp.noise, 0.01, 'how often the original model differed from itself, which the allowed difference is set from');
  near(rp.bar, 0.03, 'the bar');
  assert.equal(rp.yardstick, 'agreement');
  near(rp.yours.perCall, 0.0036, 'a request on the customer\'s own model, from its answers in this measurement');
  assert.equal(rp.yours.p50, 2000);
  assert.deepEqual(rp.cands.map((c) => [c.key, c.tone, c.verdict]), [
    [CHEAP, 'warn', 'Too few to be sure'],
    [OTHER, 'bad', 'Not a match'],
    // stopped early because it could no longer win: clearly not a match, which is the reason, not a system error
    ['vendor/dropped', 'bad', 'Clearly not a match'],
    ['vendor/refuses', 'bad', 'Failed requests'],
  ], 'passed first, then close, then not a match, closest first');
  for (const c of rp.cands) assert.ok(c.why && c.why.length > 20, `${c.verdict} says why`);
  assert.match(rp.cands.find((c) => c.key === 'vendor/dropped').why, /^Testing stopped early because the model was already different enough/);
  const cheap = rp.cands[0];
  near(cheap.perCall, 0.1 * 0.0036, 'what a request costs on it: its measured share of the customer\'s own');
  near(cheap.hi, 0.091, 'the range its count allows');
  assert.equal(cheap.p50, 1400);
  const refuses = rp.cands.find((c) => c.key === 'vendor/refuses');
  assert.equal(refuses.gap, null, 'a setup that never answered was not judged');
  assert.equal(refuses.perCall, null);

  // one the customer's own model could not steady is said as that
  const unsure = await run(ws, wid, { at: t - 2 * DAY, outcome: 'unmeasurable', noise: 63.6, sample: 11, results: [] });
  const up = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(unsure));
  assert.match(up.take, /^The original model, gpt-5\.4, gave a different answer to the same request 64% of the time when each of 11 requests was run twice/);
  assert.deepEqual(up.cands, []);
  // one big enough to show it, where the closest was only close
  const close = await run(ws, wid, { at: t - 3 * DAY, sample: 120, floor: 3, results: [{ key: CHEAP, verdict: 'review', gap: 2.5, hi: 4.1, needed: 100 }] });
  const cp = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(close));
  assert.equal(cp.cands[0].verdict, 'Close match');
  assert.equal(cp.take, 'steady was the closest match. It answered differently from the original model on 2.5% of the requests tested. '
    + "The original model answers differently from itself on 1% of requests, so at most 3% is allowed, but the test isn't yet sure it "
    + 'stays within that. It will be tested again next time.');
  // and one that differed more than allowed says it was not close enough
  const far = await run(ws, wid, { at: t - 5 * DAY, sample: 120, floor: 33.33333333, noise: 26.66666667,
    results: [{ key: CHEAP, verdict: 'review', gap: 45, hi: 61, needed: 100 }] });
  const fp = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(far));
  assert.equal(fp.take, 'steady was the closest match. It answered differently from the original model on 45% of the requests tested. '
    + "The original model answers differently from itself on 26.7% of requests, so at most 33.3% is allowed, and this model wasn't close "
    + 'enough to replace it yet. It will be tested again next time.');
  // written answers held to answers at least as good
  const judged = await run(ws, wid, { at: t - 4 * DAY, yardstick: 'quality', results: [{ key: CHEAP, verdict: 'cleared' }] });
  assert.equal((await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(judged))).yardstick, 'quality');
});

test('a model too slow says by how much: its time, the original model\'s, and the most the workload allows', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'speed-words');
  const t = now();
  const rid = await run(ws, wid, { at: t - DAY, refP50: 2000, results: [
    { key: 'vendor/slow-typical', verdict: 'slower', stopped: 'speed', runs: 3, gap: 0, p50: 5400 },
    { key: 'vendor/slow-tail', verdict: 'slower', stopped: 'speed', runs: 18, gap: 0, p50: 2400 },
    { key: 'cascade:vendor/checked', verdict: 'slower', gap: 0, p50: 2600, spec: { kind: 'cascade', first: { model: 'vendor/checked' }, fallback: { model: REF } } },
  ] });
  // held to 1.5 times the original model's typical time, and twice its slowest tenth on the slowest answers, each plus 0.3 s
  await db.prepare(`UPDATE eval_runs SET ref_latency_p90 = 3000, plan_json = ? WHERE id = ?`)
    .run(JSON.stringify({ speed: { pref: 'slower_ok', factor: 1.5, slowEnd: 2, metric: 'latency' } }), rid);
  await db.prepare(`UPDATE eval_results SET latency_p90 = 7200 WHERE run_id = ? AND model_id = 'cascade:vendor/checked'`).run(rid);
  // the model slow only at its end: 12 answers at 2 s, 6 past the 6.3 s its slowest may take
  for (let i = 0; i < 18; i += 1) {
    await db.prepare(`INSERT INTO eval_replays (id, run_id, call_id, model_id, slot, reused, status, cost_usd, latency_ms, created_at)
      VALUES (?, ?, NULL, 'vendor/slow-tail', 0, 0, 200, 0.0001, ?, ?)`).run(id('rep'), rid, i < 12 ? 2000 : 7000, t - DAY);
  }
  const w = await load(wid);
  const rp = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(rid));
  const why = (key) => rp.cands.find((c) => c.key === key).why;
  assert.equal(rp.cands.find((c) => c.key === 'vendor/slow-typical').verdict, 'Slower than original');
  assert.equal(why('vendor/slow-typical'), 'On a typical request this model took 5.4 s, and the original model 2.0 s. That\'s 3.4 s slower, '
    + '2.7 times as long, and this workload allows up to 3.3 s.');
  assert.equal(why('vendor/slow-tail'), 'On a typical request this model took 2.4 s, and the original model 2.0 s. That\'s 0.4 s slower, which this '
    + 'workload allows (up to 3.3 s). But 6 of its 18 answers took longer than 6.3 s. This workload lets about 1 in 10 answers take that long, '
    + 'and 6 in 18 is too many.');
  assert.equal(why('cascade:vendor/checked'), 'On a typical request this model took 2.6 s, and the original model 2.0 s. That\'s 0.6 s slower, '
    + 'which this workload allows (up to 3.3 s). But its slowest answers were too slow: its slowest 1 in 10 took over 7.2 s, and this workload '
    + 'allows them up to 6.3 s.');

  // the difference said is the one between the two times as written: 5.4 s less 2.0 s is 3.4 s, never 3.5 s
  const rounded = await run(ws, wid, { at: t - 3 * DAY, refP50: 1982, results: [
    { key: 'vendor/rounding', verdict: 'slower', stopped: 'speed', runs: 3, p50: 5449 },
    { key: 'vendor/just-past', verdict: 'slower', stopped: 'speed', runs: 9, p50: 3301 },
  ] });
  await db.prepare(`UPDATE eval_runs SET ref_latency_p90 = 3000, plan_json = ? WHERE id = ?`)
    .run(JSON.stringify({ speed: { pref: 'slower_ok', factor: 1.5, slowEnd: 2, metric: 'latency' } }), rounded);
  const rr = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(rounded));
  assert.equal(rr.cands.find((c) => c.key === 'vendor/rounding').why, 'On a typical request this model took 5.4 s, and the original model 2.0 s. '
    + 'That\'s 3.4 s slower, 2.7 times as long, and this workload allows up to 3.3 s.');
  // just past a limit that rounds to the same tenth: both to a hundredth, so the words never say 3.3 s where 3.3 s is allowed
  assert.equal(rr.cands.find((c) => c.key === 'vendor/just-past').why, 'On a typical request this model took 3.30 s, and the original model '
    + '2.0 s. That\'s 1.3 s slower, 1.7 times as long, and this workload allows up to 3.27 s.');

  // a test that kept no speed rule says it without figures, as before
  const old = await run(ws, wid, { at: t - 2 * DAY, results: [{ key: 'vendor/slow-typical', verdict: 'slower', p50: 5400 }] });
  const op = await runPageOf(w, await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(old));
  assert.equal(op.cands[0].why, 'It answered more slowly than the original model, by more than this workload allows.');
});

/* 3. The calls ------------------------------------------------------------------------------------- */

test('the calls, newest first ten at a time, each with who answered it; a failed try that was answered another way is left out', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'calls');
  const t = now();
  for (let i = 0; i < 12; i += 1) await call(ws, wid, { at: t - (i + 1) * MIN, cost: 0.004, lat: 1500 + i });
  await call(ws, wid, { at: t - 30 * MIN, status: 502, cost: 0, check: { by: 'fell back', status: 502 } });
  await call(ws, wid, { at: t - 40 * MIN, source: 'trace', cost: 0.005 });
  const w = await load(wid);
  const c = await callsOf(w);
  assert.equal(c.total, 13, 'twelve through us and a copy; the failed try is not one of the customer\'s requests');
  near(c.cost, 12 * 0.004 * FEE + 0.005, 'what they cost: what was charged, or for a copy what the provider charged');
  assert.equal(c.ownOnly, true);
  assert.equal(c.rows.length, 10);
  assert.equal(c.more, true);
  assert.equal(c.rows[0].ms, 1500);
  assert.equal(c.rows[0].who, 'yours');
  assert.ok(c.rows.every((r, i) => i === 0 || r.at <= c.rows[i - 1].at), 'newest first');
  const older = await callsOf(w, { page: 2 });
  assert.equal(older.rows.length, 3);
  assert.equal(older.more, false);
  assert.equal(older.rows[2].copy, true);
  assert.ok(older.rows.every((r) => !c.rows.some((x) => x.id === r.id)), 'the next page is other calls');
  // an experiment on another model: no longer all on the customer's own
  await call(ws, wid, { at: t - 5000, served: OTHER, explored: 1, cost: 0.0004 });
  const mixed = await callsOf(w);
  assert.equal(mixed.ownOnly, false);
  assert.equal(mixed.rows[0].who, 'other');
  assert.equal(mixed.rows[0].experiment, true);
});

/* Once switched: what Understudy is doing ---------------------------------------------------------- */

test('once switched: the share the cheaper setup answers, a request before and now, saved this month, the daily checks and the speed', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'doing', { floor: 8 });
  const t = now();
  const at = t - 6 * DAY;
  const spec = { kind: 'cascade', first: { model: CHEAP, recipe: null }, fallback: { model: REF, recipe: null }, threshold: 0.7 };
  const armId = await arm(ws, wid, spec, { ratio: 0.25, at });
  const made = await run(ws, wid, { at, floor: 8, yardstick: 'quality', results: [{ key: `cascade:${CHEAP}`, verdict: 'cleared', spec, confirm: 'cleared' }] });
  await switchTo(wid, { model: CHEAP, armId, at: at + MIN, runId: made });
  // before the switch: the customer's own model
  for (let i = 0; i < 10; i += 1) await call(ws, wid, { at: at - DAY + i * HOUR, cost: 0.004, lat: 2000 });
  // since: 18 answered by the cheaper model, 2 sent on to the customer's own
  for (let i = 0; i < 18; i += 1) await call(ws, wid, { at: at + HOUR + i * HOUR, served: CHEAP, arm: armId, cost: 0.001, lat: 900 });
  for (let i = 0; i < 2; i += 1) await call(ws, wid, { at: at + 30 * HOUR + i * HOUR, served: REF, arm: armId, escalated: 1, cost: 0.005, lat: 2600 });
  // the daily checks: 20 judged, 1 worse, one not judged; and one by the other yardstick that does not count
  for (let i = 0; i < 20; i += 1) {
    await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, yardstick, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 'quality', 0.0001, ?)`).run(id('chk'), ws.id, wid, armId, i === 0 ? 1 : 0, at + (i % 4) * DAY + HOUR);
  }
  await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, yardstick, cost_usd, created_at)
    VALUES (?, ?, ?, ?, NULL, 0, 'quality', 0.0001, ?)`).run(id('chk'), ws.id, wid, armId, at + 2 * HOUR);
  await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, yardstick, cost_usd, created_at)
    VALUES (?, ?, ?, ?, 1, 0, 'agreement', 0.0001, ?)`).run(id('chk'), ws.id, wid, armId, at + 3 * HOUR);

  const w = await load(wid);
  const g = await pageOf(w);
  const d = g.doing;
  assert.equal(d.kind, 'cascade');
  assert.equal(d.cheap, 'steady-small');
  assert.equal(d.reference, REF);
  assert.equal(d.switchedAt, at + MIN);
  assert.equal(d.waiting, false);
  assert.equal(d.served, 20);
  near(d.share, 18 / 20, 'eighteen of the twenty answered by the cheaper setup');
  // a request before: what the same requests would have cost on the customer's own model; now: what they paid
  near(d.after, (18 * 0.001 + 2 * 0.005) * FEE / 20, 'a request now, our fee included');
  assert.ok(d.before > d.after, 'cheaper now');
  near(d.less, 1 - d.after / d.before, 'how much less');
  // the daily checks: 1 worse of 20, by the bar's own yardstick, a day at a time
  assert.equal(d.checks.yardstick, 'quality');
  near(d.checks.bar, 0.08, 'the bar');
  assert.equal(d.checks.n, 20);
  near(d.checks.rate, 1 / 20, 'one worse of twenty');
  assert.equal(d.checks.daily.length, 4, 'a point a day it was checked');
  assert.equal(d.speed.metric, 'latency');
  assert.equal(d.speed.now, 900);
  assert.equal(d.speed.before, 2000);
  // saved this month, testing taken off, worked out the way the rest of the app does
  const IST = 5.5 * HOUR;
  const ist = new Date(t + IST);
  const monthStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST;
  const mdays = Math.max(1, Math.ceil((t - monthStart) / DAY));
  const month = await routedSavings({ workspaceId: ws.id, workloadId: wid, days: mdays, at: monthStart + mdays * DAY });
  near(d.savedMonth, month.would - month.paid - await optimizingSince(wid, monthStart), 'saved this month', 1e-5);
  // on track for: the pace of the whole days since the switch (five: it was a minute short of six), less what testing
  // cost over thirty days
  const pace = await routedSavings({ workspaceId: ws.id, workloadId: wid, days: 5, at: t });
  near(d.onTrack, ((pace.would - pace.paid) / 5) * 30 - await optimizingSince(wid, t - 30 * DAY), 'on track for', 1e-4);
  // the calls say who answered each, and the share since the switch
  const cheapRow = g.calls.rows.find((r) => r.model === CHEAP);
  assert.equal(cheapRow.who, 'cheap');
  const sentOn = g.calls.rows.find((r) => r.sentOn);
  assert.equal(sentOn.who, 'yours');
  near(g.calls.cheapShare, 18 / 20, 'the calls\' share, read since the switch');
  assert.equal(g.calls.cheapSince, at + MIN);
  // a workload nothing is switched on has nothing doing
  const plain = await workload(ws, 'doing-plain');
  assert.equal((await pageOf(await load(plain))).doing, null);
});

test('a switch still taking over, and one waiting for its first request through Understudy, say so', async () => {
  const { ws } = await account();
  const wid = await workload(ws, 'taking-over');
  const t = now();
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at: t - 2 * DAY });
  await switchTo(wid, { model: CHEAP, armId, at: t - 2 * DAY, rollout: 0.25 });
  for (let i = 0; i < 3; i += 1) await call(ws, wid, { at: t - DAY + i * HOUR, served: CHEAP, arm: armId, cost: 0.0004 });
  for (let i = 0; i < 9; i += 1) await call(ws, wid, { at: t - DAY + i * HOUR + 1000, cost: 0.004 });
  const d = (await pageOf(await load(wid))).doing;
  assert.equal(d.rollout, 0.25);
  near(d.share, 3 / 12, 'the share it answers now');
  assert.equal(d.waiting, false);

  // requests that reach us only as copies: set up, and waiting
  const copies = await workload(ws, 'copies-only');
  const cArm = await arm(ws, copies, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at: t - DAY });
  await switchTo(copies, { model: CHEAP, armId: cArm, at: t - DAY });
  for (let i = 0; i < 5; i += 1) await call(ws, copies, { at: t - HOUR + i * 1000, source: 'trace', cost: 0.004 });
  const c = (await pageOf(await load(copies))).doing;
  assert.equal(c.waiting, true);
  assert.equal(c.share, null, 'nothing answered here yet');
});

test('the drawing at the top of every page: requests a day, when the last one came, and so whether they are arriving now', async () => {
  const { ws } = await account();
  const t = now();
  // nothing switched on it: thirty requests over a day and a half, the last seven hours ago
  const wid = await workload(ws, 'flow-plain');
  for (let i = 0; i < 30; i += 1) await call(ws, wid, { at: t - 36 * HOUR + i * HOUR });
  // a failed try answered another way is not one of the customer's requests, so it is never the last one
  await call(ws, wid, { at: t - MIN, check: { by: 'fell back' } });
  const f = (await pageOf(await load(wid))).flow;
  near(f.perDay, 30 / 1.5, 'thirty over a day and a half, the way what a switch is worth counts them', 0.01);
  assert.equal(f.copiesPerDay, 0);
  assert.equal(f.lastAt, t - 7 * HOUR, 'the last request, seven hours ago');
  assert.equal(f.liveMs, 15 * MIN, 'the drawing moves while the last request is under a quarter of an hour old');
  assert.ok(t - f.lastAt > f.liveMs, 'so this one stands still');
  // one just now: arriving
  await call(ws, wid, { at: t - 2 * MIN });
  const g = (await pageOf(await load(wid))).flow;
  assert.equal(g.lastAt, t - 2 * MIN);
  assert.ok(t - g.lastAt <= g.liveMs, 'and moves');
  // copies count as requests that came, and are counted apart
  const copies = await workload(ws, 'flow-copies');
  for (let i = 0; i < 7; i += 1) await call(ws, copies, { at: t - 7 * DAY + HOUR + i * DAY, source: 'trace' });
  const c = (await pageOf(await load(copies))).flow;
  assert.equal(c.perDay, 0, 'none routed');
  near(c.copiesPerDay, 1, 'a copy a day', 0.01);
  // a workload nothing has reached has no last request, and never moves
  const quiet = (await pageOf(await load(await workload(ws, 'flow-none')))).flow;
  assert.deepEqual([quiet.perDay, quiet.lastAt], [0, null]);
});

test('money on the page: what testing cost this month, and what the test that switched a workload expected it to save', async () => {
  const { ws } = await account();
  const t = now();
  const IST = 5.5 * HOUR;
  const ist = new Date(t + IST);
  const monthStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST;
  const wid = await workload(ws, 'money');
  // a test this month and one last month: only this month's is counted, our fee included
  await run(ws, wid, { at: Math.max(monthStart + 20 * MIN, t - HOUR), spend: 0.2, results: [] });
  await run(ws, wid, { at: monthStart - DAY, spend: 5, results: [] });
  const g = await pageOf(await load(wid));
  near(g.spentMonth, 0.2 * FEE, 'this month\'s test, with the fee');
  // switched by a test that found a month on the original model costs 300 and on the cheaper model 30 (run() writes them),
  // with no request through it since: what a request costs on it is read from that test
  const at = t - 2 * DAY;
  const armId = await arm(ws, wid, { kind: 'model', model: CHEAP, recipe: null }, { ratio: 0.1, at });
  const made = await run(ws, wid, { at: at - HOUR, spend: 0, results: [{ key: CHEAP, verdict: 'cleared', confirm: 'cleared' }] });
  for (let i = 0; i < 10; i += 1) await call(ws, wid, { at: at - DAY + i * HOUR, cost: 0.004 });
  await switchTo(wid, { model: CHEAP, armId, at, runId: made, rollout: 0.05 });
  const d = (await pageOf(await load(wid))).doing;
  near(d.expectedMonth, 270, 'the test expected 300 a month on the original model and 30 on the cheaper one');
  assert.equal(d.afterFrom, 'test', 'nothing has come through since the switch, so the test says what a request costs');
  near(d.after, d.before * 0.1, 'a tenth of what one costs on the original model, as the test found');
  near(d.less, 0.9, 'ninety percent less');
  // once requests come through it, what they paid is what a request costs
  for (let i = 0; i < 5; i += 1) await call(ws, wid, { at: at + HOUR + i * HOUR, served: CHEAP, arm: armId, cost: 0.0008 });
  const e = (await pageOf(await load(wid))).doing;
  assert.equal(e.afterFrom, 'requests');
  near(e.after, 0.0008 * FEE, 'what they paid, our fee included');
  assert.equal(e.expectedMonth, d.expectedMonth, 'the saving the test expected stays what it expected');
});

/* The routes, and the workspace's one choice ------------------------------------------------------- */

test('the page\'s routes answer only the workspace that owns the workload', async () => {
  const mine = await account();
  const theirs = await account();
  const wid = await workload(mine.ws, 'route');
  for (let i = 0; i < 12; i += 1) await call(mine.ws, wid, { at: now() - (i + 1) * MIN });
  const rid = await run(mine.ws, wid, { at: now() - DAY, results: [{ key: CHEAP, verdict: 'cleared' }] });
  const other = await workload(theirs.ws, 'route-theirs');
  const otherRun = await run(theirs.ws, other, { at: now() - DAY, results: [] });
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.81' },
    body: JSON.stringify({ email: mine.email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const get = (path, headers = { cookie }) => fetch(`${base}/api${path}`, { headers });
  const page = await get(`/workloads/${wid}/page`);
  assert.equal(page.status, 200);
  const g = await page.json();
  for (const k of ['kind', 'enough', 'flow', 'spentMonth', 'doing', 'measurements', 'calls', 'feePct']) assert.ok(k in g, `the page carries ${k}`);
  assert.equal(g.measurements[0].id, rid);
  // the workload says how many cheaper models its newest comparison passed, for the page's "9 cheaper models passed"
  const wl = await (await get(`/workloads/${wid}`)).json();
  assert.equal(wl.certificate.passedCheaper, 1);
  const more = await (await get(`/workloads/${wid}/page/calls?page=2`)).json();
  assert.equal(more.page, 2);
  assert.equal(more.rows.length, 2);
  const opened = await get(`/workloads/${wid}/runs/${rid}/page`);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).cands[0].key, CHEAP);
  assert.equal((await get(`/workloads/${other}/page`)).status, 404, 'another workspace\'s workload is not found');
  assert.equal((await get(`/workloads/${other}/page/calls`)).status, 404);
  assert.equal((await get(`/workloads/${wid}/runs/${otherRun}/page`)).status, 404, 'nor another workload\'s measurement');
  assert.equal((await get(`/workloads/${wid}/page`, {})).status, 401, 'nobody signed in is told to sign in');
});

test('what happens when a cheaper setup passes is one choice for the workspace: Automatic unless changed, and every workload follows', async () => {
  const s = await account();
  assert.equal(config.DEFAULT_OPTIMIZE_MODE, 'auto');
  const w1 = await workloadFor(s.ws.id, { model: REF, messages: [{ role: 'system', content: 'Sort the ticket.' }, { role: 'user', content: 'hi' }] });
  assert.equal(w1.optimize_mode, 'auto', 'a new workload in a workspace that has not chosen switches by itself');
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.82' },
    body: JSON.stringify({ email: s.email, password: 'correct-horse-battery' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const post = (path, body) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const other = await workload(s.ws, 'follows', { mode: 'off' });
  assert.equal((await post('/settings/default-mode', { mode: 'ask', applyToExisting: true })).status, 200);
  assert.equal((await load(w1.id)).optimize_mode, 'ask');
  assert.equal((await load(other)).optimize_mode, 'ask', 'every workload follows, whatever it had');
  const said = await db.prepare(`SELECT title, detail FROM activity WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.ws.id);
  assert.equal(said.title, 'Every workload will ask you before switching to a cheaper setup that passes');
  assert.equal(said.detail, 'All 2 of your workloads, and every new one.');
  const w2 = await workloadFor(s.ws.id, { model: REF, messages: [{ role: 'system', content: 'Write a haiku.' }, { role: 'user', content: 'hi' }] });
  assert.equal(w2.optimize_mode, 'ask', 'and so does a new one');
  const settings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
  assert.equal(settings.defaultOptimizeMode, 'ask');
});
