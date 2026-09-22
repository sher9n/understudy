/* Learning from live calls, end to end: the real proxy, a provider we control, a real database.

   A switched workload tries a small share of its calls elsewhere (the customer's own model as the
   yardstick, and a cheaper runner-up), every call records the chance it had, the day's budget
   stops the experiments, and the hourly review acts on what the records show: on to a runner-up
   that works as often, back to the customer's own model when what serves works less often, and a
   runner-up that works less often is set aside. A workload that waits for approval never has an
   answer changed: its runner-up answers copies in the background, and a good match is put in
   front of whoever approves. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import pg from 'pg';

const PORT = 4798;
const PROXY_PORT = 4799;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_learn_${process.pid}`;
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
// big shares, so a handful of calls shows every path; the arithmetic is the same at 2%
process.env.EXPLORE_SHARE_NORMAL = '0.5';
process.env.SHADOW_SHARE = '1';
process.env.LEARN_SETTLE_MIN = '0';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { issueKey } = await import('../src/keys.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { move } = await import('../src/billing.js');
const { promote } = await import('../src/eval/promote.js');
const { onChoose, onServed } = await import('../src/learn/choose.js');
const {
  chooseExplore, afterServed, reviewWorkload, markTrying, learningView, forgetState, exploreOf,
} = await import('../src/learn/explore.js');
const { rngFrom } = await import('../src/learn/bandit.js');
const { default: v1 } = await import('../src/proxy.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
const STEADY = 'vendor/steady';
const CHEAPER = 'vendor/cheaper';
const COST = { [REF]: 0.002, [STEADY]: 0.0004, [CHEAPER]: 0.0001 };
const right = (i) => ({ total: 100 + i, currency: 'USD' });
// the cheaper runner-up gets one call in four wrong, which a background answer shows
const answerOf = (model, i) => (model === CHEAPER && i % 4 === 1 ? { total: 0, currency: 'EUR' } : right(i));

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const text = payload.messages.find((m) => m.role === 'user')?.content || '';
    const i = Number((text.match(/#(\d+)/) || [])[1] || 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `gen-${i}`, model: payload.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answerOf(payload.model, i)) } }],
      usage: { prompt_tokens: 500, completion_tokens: 40, cost: COST[payload.model] ?? 0.001 } }));
  });
});

const app = express();
app.use('/v1', v1);
let proxy = null;
// every draw replayable: the experiment choice and the background choice each have their own source
const choiceRng = rngFrom(2024);
const shadowRng = rngFrom(99);
onChoose((w, serving) => chooseExplore(w, serving, { rng: choiceRng }));
onServed((info) => afterServed(info, { rng: shadowRng }));

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { proxy = app.listen(PROXY_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    { model_id: STEADY, name: 'steady', context_len: 128000, price_in: 0.4e-6, price_out: 1e-6, open_weights: 1, zdr: 1 },
    { model_id: CHEAPER, name: 'cheaper', context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6, open_weights: 1, zdr: 1 },
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => proxy.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

const request = (i) => ({
  model: REF,
  messages: [{ role: 'system', content: `Extract the totals from invoice ${900000 + i}.` }, { role: 'user', content: `document #${i}` }],
  response_format: { type: 'json_object' },
});

/* A workspace with one workload that has been measured: steady cleared and serves it, cheaper came
   close and is a runner-up. What a measurement would leave behind, written directly, so each test
   starts from exactly the state it is about. */
async function shop(tag, { optimize = 'auto', explore = 'normal', switched = true } = {}) {
  const { workspace } = await createAccount({ email: `learn-${tag}-${process.pid}@understudy.dev`, password: 'correct-horse', name: tag });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  let workload = null;
  for (let i = 0; i < 3; i += 1) {
    workload = await workloadFor(workspace.id, request(i));
    await recordCall({ workspaceId: workspace.id, workloadId: workload.id, source: 'routed', requestedModel: REF, servedModel: REF,
      statusCode: 200, promptTokens: 500, completionTokens: 40, costUsd: 0.002, request: request(i),
      response: { choices: [{ message: { content: JSON.stringify(right(i)) } }] } });
  }
  await db.prepare(`UPDATE workloads SET optimize_mode = ?, explore_mode = ?, explore_budget_usd = 100, reference_model = ?,
      floor_pct = 4 WHERE id = ?`).run(optimize, explore, REF, workload.id);
  workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  if (switched) {
    await promote(workload, STEADY, { spec: { kind: 'model', model: STEADY, recipe: null }, auto: true });
    workload = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  }
  const results = [
    { model_id: STEADY, verdict: 'cleared', stopped: null, cost_month_usd: 20, cost_ratio: 0.2, gap_pct: 1.5, runs: 80, arm_json: null, recipe_json: null },
    { model_id: CHEAPER, verdict: 'review', stopped: null, cost_month_usd: 5, cost_ratio: 0.05, gap_pct: 4.6, runs: 80, arm_json: null, recipe_json: null },
    { model_id: 'vendor/wrong', verdict: 'missed', stopped: 'bar', cost_month_usd: 2, cost_ratio: 0.02, gap_pct: 40, runs: 9, arm_json: null, recipe_json: null },
  ];
  await markTrying(workload, { runId: null, results, refMonthly: 100, floor: 4 });
  const key = await issueKey(workspace.id, 'learning');
  return { workspace, workload: await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id), secret: key.secret };
}

const send = async (secret, body) => {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  await res.json();
  await learningSettled();
  return res.headers.get('x-understudy-call-id');
};

const armOf = async (workloadId, model) => db.prepare(
  `SELECT * FROM arms WHERE workload_id = ? AND spec_json LIKE ?`).get(workloadId, `%"model":"${model}"%`);

/* Calls a strategy served, written directly and dated an hour ago, with how each turned out. */
async function history(s, model, { n, failed = 0, armId = undefined }) {
  const arm = armId === undefined ? await armOf(s.workload.id, model) : { id: armId };
  for (let i = 0; i < n; i += 1) {
    const callId = await recordCall({
      workspaceId: s.workspace.id, workloadId: s.workload.id, source: 'routed', requestedModel: REF, servedModel: model,
      statusCode: 200, promptTokens: 500, completionTokens: 40, costUsd: COST[model], request: request(1000 + i),
      response: { choices: [{ message: { content: JSON.stringify(right(1000 + i)) } }] },
      armId: arm?.id ?? null, propensity: 1, explored: 0,
    });
    // a failure the traffic showed: say the answer was not what the request asked for
    if (i < failed) await db.prepare('UPDATE calls SET reward = 0 WHERE id = ?').run(callId);
  }
  await learningSettled();
  await db.prepare('UPDATE calls SET created_at = ? WHERE workload_id = ? AND created_at > ?')
    .run(now() - 3600000, s.workload.id, now() - 3600000);
  forgetState(s.workload.id);
}

test('a measurement leaves its runners-up behind: close and cheaper ones are tried, the rest are not', async () => {
  const s = await shop('marks');
  const cheaper = await armOf(s.workload.id, CHEAPER);
  assert.equal(cheaper.status, 'trying', 'close and cheaper: worth trying');
  assert.equal(JSON.parse(cheaper.offline_json).ratio, 0.05);
  assert.equal(await armOf(s.workload.id, 'vendor/wrong'), undefined, 'a model that missed is not a runner-up');
  const steady = await armOf(s.workload.id, STEADY);
  assert.equal(steady.status, 'serving', 'what serves stays serving');
  // a later measurement that no longer vouches for it sets it aside
  await markTrying(s.workload, { runId: null, results: [], refMonthly: 100, floor: 4 });
  assert.equal((await armOf(s.workload.id, CHEAPER)).status, 'resting');
});

test('a switched workload tries a small share of its calls elsewhere, and every call says what chance it had', async () => {
  const s = await shop('explore');
  forgetState(s.workload.id);
  // nothing is known yet: the first call is served as usual, and never waits while that is read
  const first = await send(s.secret, request(999));
  const row0 = await db.prepare('SELECT served_model, propensity, explored FROM calls WHERE id = ?').get(first);
  assert.equal(row0.served_model, STEADY);
  assert.equal(Number(row0.propensity), 1);
  assert.equal(Number(row0.explored), 0);
  const ids = [];
  for (let i = 0; i < 40; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT c.*, a.status AS arm_status FROM calls c LEFT JOIN arms a ON a.id = c.arm_id
      WHERE c.id = ANY(?::text[])`).all(ids);
  assert.equal(rows.length, 40);
  const by = (m) => rows.filter((r) => r.served_model === m);
  assert.ok(by(STEADY).length >= 12, `most go to what serves: ${by(STEADY).length}`);
  assert.ok(by(REF).length >= 3, `some go to the yardstick: ${by(REF).length}`);
  assert.ok(by(CHEAPER).length >= 3, `some to the runner-up: ${by(CHEAPER).length}`);
  for (const r of rows) assert.ok(r.arm_id, 'every call names the strategy that answered it');
  // share 0.5: what serves keeps half, the yardstick and the one runner-up a quarter each
  for (const r of by(STEADY)) { assert.equal(Number(r.propensity), 0.5); assert.equal(Number(r.explored), 0); }
  for (const r of by(REF)) { assert.equal(Number(r.propensity), 0.25); assert.equal(Number(r.explored), 1); assert.equal(r.arm_status, 'baseline'); }
  for (const r of by(CHEAPER)) { assert.equal(Number(r.propensity), 0.25); assert.equal(Number(r.explored), 1); }
  // the customer paid for what answered each call, as ever
  const paid = await db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM calls WHERE id = ANY(?::text[])`).get(ids);
  const due = by(STEADY).length * COST[STEADY] + by(REF).length * COST[REF] + by(CHEAPER).length * COST[CHEAPER];
  assert.ok(Math.abs(Number(paid.c) - due) < 1e-9);
});

test('experiments stop once the day\'s budget is used, and the call is served as usual', async () => {
  const s = await shop('budget');
  // one call on the yardstick adds 0.002 x (1 - 0.2) = $0.0016, more than this whole budget
  await db.prepare('UPDATE workloads SET explore_budget_usd = 0.001 WHERE id = ?').run(s.workload.id);
  forgetState(s.workload.id);
  const ids = [];
  for (let i = 0; i < 30; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT id, served_model, explored, propensity FROM calls WHERE id = ANY(?::text[]) ORDER BY created_at`).all(ids);
  const onRef = rows.filter((r) => r.served_model === REF);
  assert.ok(onRef.length <= 1, `at most the one yardstick call that used the budget: ${onRef.length}`);
  const after = rows.slice(rows.findIndex((r) => r.served_model === REF) + 1);
  assert.ok(after.every((r) => r.served_model !== REF), 'no yardstick call once the budget is gone');
  // once experiments pause, what serves answers with certainty
  assert.ok(rows.slice(-5).every((r) => r.served_model !== REF && (r.served_model === CHEAPER || Number(r.propensity) === 1 || Number(r.propensity) === 0.5)));
  const view = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  if (onRef.length) assert.match(view.explore.reason || '', /budget/, 'the page says why experiments paused');
});

test('the hourly review moves to a cheaper runner-up once its live calls work as often', async () => {
  const s = await shop('promote');
  /* Sixty clean calls are not enough: after n calls without a failure, the failure rate can still
     plausibly be about 3/n, 5% at sixty, and the runner-up has to be shown within two points. */
  await history(s, STEADY, { n: 300 });
  await history(s, CHEAPER, { n: 60 });
  assert.deepEqual(await reviewWorkload(s.workload), [], 'sixty clean calls: not yet');
  await history(s, CHEAPER, { n: 190 });
  const decisions = await reviewWorkload(s.workload);
  assert.deepEqual(decisions.map((d) => d.kind), ['promote']);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, CHEAPER, 'switched on to the cheaper runner-up');
  const promo = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.equal(promo.to_model, CHEAPER);
  assert.match(promo.reason, /live results/);
  const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.match(act.detail, /Switched on its own by live results: its calls worked 100\.0% of the time over 250 calls/);
  assert.match(act.detail, /costs 75% less/, 'a quarter of the price: 0.05 against 0.2');
  // the readings are kept on each strategy for the page
  const arm = await armOf(s.workload.id, CHEAPER);
  assert.equal(JSON.parse(arm.stats_json).live.calls, 250);
});

test('the hourly review switches back when what serves works less often than the customer\'s own model', async () => {
  const s = await shop('rollback');
  await history(s, STEADY, { n: 100, failed: 15 });
  // the yardstick: the customer's own model on the same weeks, from before the switch and since
  await history(s, REF, { n: 60, armId: null });
  const decisions = await reviewWorkload(s.workload);
  assert.deepEqual(decisions.map((d) => d.kind), ['revert']);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, null, 'back on the customer\'s own model');
  const r = await db.prepare(`SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.equal(r.action, 'soft_revert', 'for a while, not for good: live results can change');
  assert.match(r.reason, /worked 85\.0% of the time, against 100\.0% on gpt-5\.4 \(100 and 6\d calls\)/);
});

test('a runner-up that clearly works less often is set aside', async () => {
  const s = await shop('rest');
  await history(s, STEADY, { n: 120 });
  await history(s, CHEAPER, { n: 40, failed: 14 });
  const decisions = await reviewWorkload(s.workload);
  assert.ok(decisions.some((d) => d.kind === 'rest'), JSON.stringify(decisions));
  assert.equal((await armOf(s.workload.id, CHEAPER)).status, 'resting');
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id);
  assert.equal(w.routed_model, STEADY, 'what serves stays');
});

test('too little evidence changes nothing', async () => {
  const s = await shop('patience');
  await history(s, STEADY, { n: 50 });
  await history(s, CHEAPER, { n: 8 });
  assert.deepEqual(await reviewWorkload(s.workload), []);
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(s.workload.id)).routed_model, STEADY);
});

test('a workload that waits for approval never has an answer changed; its runner-up answers in the background', async () => {
  const s = await shop('shadow', { optimize: 'ask', explore: null, switched: false });
  assert.equal(exploreOf(s.workload).mode, 'shadow', 'asking first means background answers by default');
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await send(s.secret, request(i)));
  const rows = await db.prepare(`SELECT served_model, arm_id, explored FROM calls WHERE id = ANY(?::text[])`).all(ids);
  assert.ok(rows.every((r) => r.served_model === REF), 'every answer came from the customer\'s own model');
  const shadows = await db.prepare('SELECT * FROM shadow_runs WHERE workload_id = ? ORDER BY created_at').all(s.workload.id);
  assert.equal(shadows.length, 8, 'each call answered again in the background (the share is 1 here)');
  // nothing is switched yet, so both measured models are runners-up, and each answers some calls
  const cheaperArm = await armOf(s.workload.id, CHEAPER);
  const steadyArm = await armOf(s.workload.id, STEADY);
  assert.equal(steadyArm.status, 'trying');
  assert.ok(shadows.every((x) => [cheaperArm.id, steadyArm.id].includes(x.arm_id)), 'by the runners-up');
  // the cheaper one gets calls 1 and 5 wrong in both fields; the steady one matches every time
  for (const [k, x] of shadows.entries()) {
    const want = x.arm_id === cheaperArm.id && k % 4 === 1 ? 0 : 1;
    assert.equal(Number(x.agreement), want, `call ${k} on ${x.arm_id === cheaperArm.id ? 'cheaper' : 'steady'}`);
  }
  // paid like a measurement, out of the balance, within the budget
  const spent = await db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM ledger WHERE workspace_id = ? AND kind = 'eval'`).get(s.workspace.id);
  assert.ok(Number(spent.s) < 0, 'background answers are charged like a measurement');

  /* Background answers in bulk with known results, so what the review sees does not depend on how
     the few live ones happened to be shared between the two runners-up. */
  const bulk = async (tag, n, agreement) => {
    await db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, agreement, cost_usd, status, created_at)
        SELECT ? || g, ?, ?, ?, ?, 0, 200, ? FROM generate_series(1, ?) g`)
      .run(`shd_${tag}_`, s.workspace.id, s.workload.id, cheaperArm.id, agreement, now() - 60000, n);
    forgetState(s.workload.id);
  };
  // forty that only half matched: far outside the 4% bar, so nothing is put forward
  await bulk('half', 40, 0.5);
  assert.ok(!(await reviewWorkload(s.workload)).some((d) => d.armId === cheaperArm.id), 'half matching is not put forward');
  // eight hundred that matched: about 2.6% different in all, inside the bar
  await bulk('same', 800, 1);
  const later = await reviewWorkload(s.workload);
  assert.ok(later.some((d) => d.kind === 'suggest' && d.armId === cheaperArm.id), JSON.stringify(later));
  const act = await db.prepare(`SELECT * FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(s.workload.id);
  assert.match(act.title, /matched your live answers/);
  assert.match(act.detail, /Nothing was changed/);
  assert.deepEqual(await reviewWorkload(s.workload), [], 'said once, not every hour');
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(s.workload.id)).routed_model, null, 'and nothing switched');
});

test('the page gets every strategy with its record, its share of the week, and the experiment setting', async () => {
  const s = await shop('view');
  await history(s, STEADY, { n: 50, failed: 1 });
  await history(s, CHEAPER, { n: 10 });
  const v = await learningView(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(s.workload.id));
  assert.equal(v.explore.mode, 'normal');
  assert.equal(v.serving.role, 'serving');
  assert.equal(v.serving.live.calls, 50);
  assert.ok(v.serving.live.lo < v.serving.live.mean && v.serving.live.mean < v.serving.live.hi);
  assert.equal(v.serving.week.calls, 50);
  assert.equal(v.baseline.role, 'yardstick');
  assert.equal(v.baseline.ratio, 1);
  const runner = v.others.find((o) => o.spec.model === CHEAPER);
  assert.equal(runner.role, 'runner-up');
  assert.equal(runner.live.calls, 10);
  assert.equal(runner.ratio, 0.05);
});
