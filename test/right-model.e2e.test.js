/* Picking the right model (the owner's go-ahead of 26 Sep 2026), end to end on a real database, through real
   measurements against a provider we control, and the real app for what a person can do.

   What is checked:
   - a model serving a small workload that its own re-check shows clearly worse is switched back, however few the calls
     (it used to read "too few to be sure" and keep serving); one that shows nothing either way keeps serving;
   - a model that passed once and did not hold up on calls it had never seen is never offered, never approved, and never
     asked about: its workload says so plainly;
   - a model that passed once and had too few new calls for its second look waits for them, is looked at again the moment
     they arrive (a second-look run, which races it alone and draws its first look again from what it already answered),
     and is switched to when it passes; and it can never take every request at once before that. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PROVIDER_PORT = 4921;
const APP_PORT = 4922;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_rightmodel_${process.pid}`;
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
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;
process.env.SECURE_COOKIES = 'false';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const auth = await import('../src/auth.js');
const { move } = await import('../src/billing.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { runEvaluation, restingStatus } = await import('../src/eval/run.js');
const { promote } = await import('../src/eval/promote.js');
const { cheaperCleared } = await import('../src/eval/outcome.js');
const { pendingSecondLook } = await import('../src/eval/schedule.js');
const { unseenCalls } = await import('../src/eval/plan.js');
const { startWaiting } = await import('../src/proxy.js');
const { HANDED_OVER_DEPLOY } = await import('../src/jobs.js');
const { runPageOf } = await import('../src/workloadPage.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const REF = 'openai/gpt-5.4';
// answers every request the way the customer's model does
const STEADY = 'vendor/steady-small';
// three more that do too, a little dearer each: four that pass, more than the second looks one measurement takes
const STEADY_B = 'vendor/steady-b';
const STEADY_C = 'vendor/steady-c';
const STEADY_D = 'vendor/steady-d';
// answers every request wrongly
const DRIFTY = 'vendor/drifty-small';
// right on every request of its first look, wrong on every one after
const LUCKY = 'vendor/lucky-small';
// wrong on every other request: what a small workload was switched to, and should not keep
const SLIPPING = 'vendor/slipping-small';
// wrong on request #0 alone: nothing a small sample can show either way
const ODD = 'vendor/odd-small';
const JUDGE = 'judge/small';
const MODELS = [STEADY, STEADY_B, STEADY_C, STEADY_D, DRIFTY, LUCKY, SLIPPING, ODD];
// a little dearer each, so which is looked at first is settled by price
const PRICE_IN = { [STEADY_B]: 0.12e-6, [STEADY_C]: 0.14e-6, [STEADY_D]: 0.16e-6 };
const DAY = 86400000;

const right = (i) => ({ total: 100 + i, currency: 'EUR', lines: (i % 5) + 1 });
const wrong = (i) => ({ total: 999 + i, currency: 'USD', lines: 0 });
const indexOf = (text) => Number((String(text).match(/#(\d+)/) || [])[1] || 0);
const answered = new Map();
const got = (m) => answered.get(m) || 0;
let luckyOn = null;
const firstLookSize = async (wid) => Number((await db.prepare(`SELECT sample_size FROM eval_runs WHERE workload_id = ? AND status = 'running'
    ORDER BY created_at DESC LIMIT 1`).get(wid))?.sample_size ?? Infinity);
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const p = JSON.parse(body || '{}');
    const m = p.model;
    const user = String(p.messages?.find((x) => x.role === 'user')?.content ?? '');
    const send = (content, cost) => {
      answered.set(m, got(m) + 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `gen-${Math.random().toString(36).slice(2)}`, model: m,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 800, completion_tokens: 60, cost } }));
    };
    if (m === JUDGE) return send('SAME', 0.00001);
    const i = indexOf(user);
    const cost = m === REF ? 0.002 : 0.0002;
    if (m === DRIFTY) return send(JSON.stringify(wrong(i)), cost);
    if (m === SLIPPING) return send(JSON.stringify(i % 2 === 0 ? wrong(i) : right(i)), cost);
    if (m === ODD) return send(JSON.stringify(i === 0 ? wrong(i) : right(i)), cost);
    if (m === LUCKY && luckyOn && got(m) >= await firstLookSize(luckyOn)) return send(JSON.stringify(wrong(i)), cost);
    return send(JSON.stringify(right(i)), cost);
  });
});

let server;
const base = `http://127.0.0.1:${APP_PORT}`;
test.before(async () => {
  await new Promise((r) => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
  await new Promise((r) => { server = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    ...MODELS.map((m) => ({ model_id: m, name: m.split('/')[1], context_len: 128000, price_in: PRICE_IN[m] ?? 0.1e-6, price_out: 0.3e-6, open_weights: 0, zdr: 1 })),
    { model_id: JUDGE, name: 'judge', context_len: 128000, price_in: 0.05e-6, price_out: 0.1e-6, open_weights: 0, zdr: 1 },
  ]);
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

const load = (wid) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(wid);
const resultOf = (runId, model) => db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(runId, model);
const lastActivity = (wid) => db.prepare('SELECT title, detail FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(wid);

const record = async (workspaceId, workloadId, i, seq) => {
  const request = { model: REF, messages: [{ role: 'system', content: `Read the invoice and give its total, currency and line count as JSON, set ${seq}.` },
    { role: 'user', content: `Invoice #${String(i).padStart(4, '0')}` }], response_format: { type: 'json_object' } };
  await recordCall({
    workspaceId, workloadId, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
    promptTokens: 800, completionTokens: 60, costUsd: 0.002, chargedUsd: 0, request,
    response: { choices: [{ message: { content: JSON.stringify(right(i)) } }], usage: { cost: 0.002 } },
  });
  return request;
};

/* A workspace with one workload of `n` recorded calls, trying only `models` (every other one switched off), which switches
   by itself ('auto') or asks first ('ask'). Signed in through the app, so what a person can do is checked as they do it. */
let seq = 0;
async function seeded({ n, models, mode = 'ask', password = 'correct-horse-battery' }) {
  seq += 1;
  const email = `right-${seq}-${process.pid}@example.test`;
  const { workspace } = await auth.createAccount({ email, password, name: `r${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ?, onboarded_at = ? WHERE id = ?').run(mode, now(), workspace.id);
  let wl = null;
  for (let i = 0; i < n; i += 1) {
    const request = { model: REF, messages: [{ role: 'system', content: `Read the invoice and give its total, currency and line count as JSON, set ${seq}.` },
      { role: 'user', content: `Invoice #${String(i).padStart(4, '0')}` }], response_format: { type: 'json_object' } };
    wl = wl || await workloadFor(workspace.id, request);
    await record(workspace.id, wl.id, i, seq);
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?').run(now() - DAY, wl.id);
  await enable(workspace.id, models);
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${100 + seq}` },
    body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200, `signed in: ${await r.clone().text()}`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const api = {
    get: async (path) => (await fetch(`${base}/api${path}`, { headers: { cookie } })).json(),
    post: async (path, body) => {
      const x = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      return { status: x.status, body: await x.json().catch(() => null) };
    },
  };
  return { workspace, workload: await load(wl.id), api, seq };
}
async function enable(workspaceId, models) {
  for (const m of [...MODELS, JUDGE]) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspaceId, m, models.includes(m) ? 1 : 0, now());
  }
}

test('a model serving a small workload that its re-check shows clearly worse is switched back, however few the calls', async () => {
  // 22 calls, as the short-poem workload had: a sample of 11, too few for any model to clear a 3% bar
  const { workload: w } = await seeded({ n: 22, models: [SLIPPING] });
  await promote(w, SLIPPING, { reason: 'cleared your bar', rollout: false });
  assert.equal((await load(w.id)).routed_model, SLIPPING, 'serving it, as a switch before this test left it');
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = await resultOf(out.runId, SLIPPING);
  assert.equal(row.runs, 11, `re-checked on the 11 calls a sample of 22 draws: ${row.runs}`);
  assert.equal(row.verdict, 'missed', `wrong on about half of them, at least ${row.gap_lo}%: clearly worse, not "too few" (${row.verdict})`);
  const after = await load(w.id);
  assert.equal(after.routed_model, null, 'and switched back to the customer\'s own model');
  const back = await db.prepare(`SELECT action, reason FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(w.id);
  assert.equal(back.action, 'auto_revert');
  assert.match(back.reason, /no longer clears your bar/);
});

test('negative: one that the same few calls show nothing about keeps serving', async () => {
  const { workload: w } = await seeded({ n: 22, models: [ODD] });
  await promote(w, ODD, { reason: 'cleared your bar', rollout: false });
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = await resultOf(out.runId, ODD);
  assert.equal(row.verdict, 'insufficient', `at most one wrong in 11: nothing either way (${row.verdict}, ${row.gap_pct}%)`);
  assert.equal((await load(w.id)).routed_model, ODD, 'still serving');
});

test('a model that passed once and did not hold up on new calls is never offered, approved or asked about', async () => {
  const { workload: w, api } = await seeded({ n: 300, models: [LUCKY], mode: 'ask' });
  luckyOn = w.id;
  let out;
  try {
    out = await runEvaluation(w.id);
  } finally {
    luckyOn = null;
  }
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = await resultOf(out.runId, LUCKY);
  assert.equal(row.verdict, 'cleared', `it passed its first look: ${row.verdict}, ${row.gap_pct}%`);
  assert.equal(row.confirm_verdict, 'missed', `and failed its second: ${row.confirm_verdict}, ${row.confirm_gap}%`);

  const results = await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(out.runId);
  assert.deepEqual(cheaperCleared(results).map((r) => r.model_id), [], 'not offered');
  const after = await load(w.id);
  assert.equal(after.status, 'no_match');
  assert.equal(after.status_note, 'A candidate passed once, but not on new requests');
  assert.equal((await restingStatus(w.id)).note, 'A candidate passed once, but not on new requests', 'read again the same way');
  const said = await lastActivity(w.id);
  assert.match(said.title, /passed once on .*, but not on new requests/);
  assert.match(said.detail, /is not switched to or offered/);
  assert.doesNotMatch(said.detail, /[Aa]pprove/, 'and nobody is asked for a yes');

  // the app: nothing offered on the page, and an approval by name refused
  const page = await api.get(`/workloads/${w.id}`);
  assert.equal(page.id, w.id, 'the page itself answered');
  assert.ok(!page.candidate, `the page offers nothing: ${JSON.stringify(page.candidate)}`);
  const yes = await api.post(`/workloads/${w.id}/promote`, { model: LUCKY });
  assert.equal(yes.status, 409, JSON.stringify(yes.body));
  assert.match(JSON.stringify(yes.body), /did not hold up when it was tested again/);
  const none = await api.post(`/workloads/${w.id}/promote`, {});
  assert.equal(none.status, 400, 'and an approval naming nothing finds nothing to switch to');
  assert.equal((await load(w.id)).routed_model, null, 'nothing switched');

  // and the test's own page says what happened, never "passed" in green over a model the second test turned down
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(out.runId);
  const part = await runPageOf(await load(w.id), run);
  const c = part.cands.find((x) => x.key === LUCKY);
  assert.equal(c.verdict, 'Passed once, not again');
  assert.equal(c.tone, 'bad');
  assert.match(c.why, /but on \d+ new requests it had never seen it answered differently from the original model on 100% of them, where 3% is allowed/);
  assert.match(part.take, /passed once, but not again on \d+ new requests it had never seen, so it isn't switched to/);
  const tests = (await api.get(`/workloads/${w.id}/page`)).measurements || [];
  const pill = tests.find((m) => m.id === out.runId)?.tag;
  assert.equal(pill?.text, 'Passed once, not again', JSON.stringify(pill));
});

test('what passed once and had too few new calls is looked at again the moment they arrive, and switched to when it passes', async () => {
  const { workspace, workload: w, api, seq: set } = await seeded({ n: 200, models: [DRIFTY], mode: 'auto' });
  // a measurement that tries only a model that fails: every call it draws has now been seen
  const first = await runEvaluation(w.id);
  assert.equal(first.ok, true, JSON.stringify(first));
  /* then one that tries four that answer as the customer's model does: their first look takes the other calls and leaves
     their second looks none, three of them are looked at and found short of calls, and the fourth is never reached */
  const steady = [STEADY, STEADY_B, STEADY_C, STEADY_D];
  await enable(workspace.id, steady);
  const second = await runEvaluation(w.id);
  assert.equal(second.ok, true, JSON.stringify(second));
  const rows = await Promise.all(steady.map((m) => resultOf(second.runId, m)));
  for (const r of rows) assert.equal(r.verdict, 'cleared', `${r.model_id}: ${r.verdict}, ${r.gap_pct}% on ${r.runs}`);
  const looks = rows.map((r) => r.confirm_verdict).sort();
  assert.deepEqual(looks, ['insufficient', 'insufficient', 'insufficient', 'not_reached'], JSON.stringify(looks));
  const now1 = await load(w.id);
  assert.equal(now1.routed_model, null, 'nothing switched on one look, even switching by itself');
  assert.equal(now1.status_note, 'A candidate cleared once and needs a second look');
  const said = await lastActivity(w.id);
  assert.match(said.detail, /It is tested again on new requests as soon as enough of them arrive, and it switches by itself if it passes/);

  /* booked for the calls it needs that no measurement has drawn (88 at a 3% bar), counted as those, and every one it still
     offers waits for that look, the one the looks never reached included */
  const pending = await pendingSecondLook(w.id);
  assert.deepEqual([...(pending?.keys || [])].sort(), [...steady].sort());
  assert.equal(Number(now1.measure_at_calls), 88, `waits for ${now1.measure_at_calls} calls no measurement has drawn`);
  const unseen0 = await unseenCalls(now1);
  // the first in the run's own order is offered while it waits (within a point of saving, the faster ranks first)
  const top = rows.find((r) => Number(r.choice_rank) === 1)?.model_id;
  const page = await api.get(`/workloads/${w.id}`);
  assert.equal(page.candidate?.model, top, 'the first in line offered while it waits');
  assert.equal(page.candidate.confirm.verdict, 'insufficient');
  assert.deepEqual(page.measure?.waitingFor, { calls: 88, have: unseen0, secondLook: true }, 'the page can say how many more it waits for');
  // every request at once only for a model that passed twice
  const allAtOnce = await api.post(`/workloads/${w.id}/promote`, { model: top, rollout: false });
  assert.equal(allAtOnce.status, 409, JSON.stringify(allAtOnce.body));
  assert.match(JSON.stringify(allAtOnce.body), /Only a model that passed twice can take every request at once/);

  /* a steady workload: old calls leave the thirty days as new ones come, so a count of every usable call stays about level;
     booked against that it was never reached. Sixty of the first measurement's calls leave now. */
  await db.prepare(`UPDATE calls SET created_at = ? WHERE id IN (SELECT call_id FROM eval_samples WHERE run_id = ? LIMIT 60)`)
    .run(now() - 40 * DAY, first.runId);
  // one call short of what it waits for starts nothing; the call that brings it starts a second look (more arrive before it runs)
  let i = 200;
  while ((await unseenCalls(await load(w.id))) < 87) await record(workspace.id, w.id, i++, set);
  assert.equal(await startWaiting(), 0, 'one call short: nothing starts');
  await record(workspace.id, w.id, i++, set);
  assert.equal(await startWaiting(), 1, 'the call that brings it starts one, however many older calls have left');
  const jobs = await db.prepare(`SELECT payload, status, created_at FROM jobs WHERE kind = 'eval_run' AND (payload::jsonb ->> 'workloadId') = ?
      ORDER BY created_at`).all(w.id);
  const queued = jobs.filter((j) => j.status === 'queued').map((j) => JSON.parse(j.payload));
  assert.deepEqual(queued.map((p) => p.trigger), ['second_look'], `a second look, not a whole measurement: ${JSON.stringify(jobs)}`);
  for (let k = 0; k < 12; k += 1) await record(workspace.id, w.id, i++, set);

  /* a second look whose models were switched off in the meantime cannot run: looked at again in the workspace's rhythm, and
     never booked for a count of usable calls, which is not what it waits for */
  await enable(workspace.id, []);
  const off = await runEvaluation(w.id, { trigger: 'second_look' });
  assert.equal(off.ok, false, JSON.stringify(off));
  const deferred = await load(w.id);
  assert.equal(deferred.measure_at_calls, null, 'not booked for a count of usable calls');
  assert.ok(Number(deferred.recheck_after) > now() + 2 * DAY, `looked at again in its rhythm, not in hours: ${deferred.recheck_after}`);
  assert.ok(await pendingSecondLook(w.id), 'and still waiting for its second look');

  /* the second look: those four alone, even with another switched on that a whole measurement would race, their first look
     answered from what they already bought, and the second on the new calls */
  await enable(workspace.id, [...steady, DRIFTY]);
  const drifted = got(DRIFTY);
  const asked = new Map(steady.map((m) => [m, got(m)]));
  const unseen = await unseenCalls(await load(w.id));
  const look = await runEvaluation(w.id, { trigger: 'second_look' });
  assert.equal(look.ok, true, JSON.stringify(look));
  const run = await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(look.runId);
  assert.equal(run.trigger, 'second_look');
  assert.equal(JSON.parse(run.plan_json).secondLookOf?.runId, second.runId);
  const tried = (await db.prepare(`SELECT model_id FROM eval_results WHERE run_id = ? AND verdict <> 'reference'`).all(look.runId)).map((r) => r.model_id);
  assert.deepEqual([...tried].sort(), [...steady].sort(), `the four that waited, none dropped: ${tried.join(', ')}`);
  assert.equal(got(DRIFTY), drifted, 'and nothing asked of a model switched on that was not waiting');
  // switched to the first in line whose second look passed, since this workload switches by itself
  const after = await load(w.id);
  const chosen = after.routed_model;
  assert.ok(steady.includes(chosen), `switched to one of the four: ${chosen}`);
  const again = await resultOf(look.runId, chosen);
  assert.ok(Number(again.reused) >= 90, `its first look answered from what it already bought: ${again.reused} of ${again.runs}`);
  assert.equal(again.confirm_verdict, 'cleared', `and it passed on the new calls: ${again.confirm_verdict} on ${again.confirm_runs}`);
  assert.equal(Number(again.confirm_runs), unseen, `every one of the ${unseen} calls no measurement had drawn`);
  // its second look's calls, and at most the part of its first look the measurement it passed never drew
  const spent = got(chosen) - asked.get(chosen);
  assert.ok(spent <= unseen + 30, `it was asked only what it had not answered before: ${spent}`);
  assert.equal(await pendingSecondLook(w.id), null, 'and nothing waits any more');
  const story = await runPageOf(after, run);
  assert.ok(story, 'the test has a page');
  // a second look queued before that starts nothing now: nothing waits for it
  const late = await runEvaluation(w.id, { trigger: 'second_look' });
  assert.equal(late.ok, false, JSON.stringify(late));
  assert.match(late.reason, /Nothing waits for a second look any more/);
  assert.equal((await load(w.id)).routed_model, chosen, 'and what serves is left serving');
});

test('negative: a person switching while a second look waits answers it, and no measurement follows the switch', async () => {
  const { workspace, workload: w, seq: set } = await seeded({ n: 200, models: [DRIFTY], mode: 'auto' });
  assert.equal((await runEvaluation(w.id)).ok, true);
  await enable(workspace.id, [STEADY]);
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await resultOf(out.runId, STEADY)).confirm_verdict, 'insufficient');
  assert.equal(Number((await load(w.id)).measure_at_calls), 88, 'a second look is booked');
  await promote(await load(w.id), STEADY, { runId: out.runId, reason: 'approved by a person' });
  const switched = await load(w.id);
  assert.equal(switched.routed_model, STEADY);
  assert.equal(switched.measure_at_calls, null, 'the switch answers what it waited for');
  // however many calls come after, none starts a measurement on a count
  for (let i = 200; i < 300; i += 1) await record(workspace.id, w.id, i, set);
  await startWaiting();
  const jobs = await db.prepare(`SELECT payload FROM jobs WHERE kind = 'eval_run' AND status = 'queued' AND (payload::jsonb ->> 'workloadId') = ?`)
    .all(w.id);
  assert.deepEqual(jobs, [], `nothing queued after the switch: ${JSON.stringify(jobs)}`);
});

test('a second look a deploy cut short starts again on the new calls it had drawn, rather than short of them', async () => {
  const { workspace, workload: w, seq: set } = await seeded({ n: 200, models: [DRIFTY], mode: 'auto' });
  assert.equal((await runEvaluation(w.id)).ok, true);
  await enable(workspace.id, [STEADY]);
  const second = await runEvaluation(w.id);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await resultOf(second.runId, STEADY)).confirm_verdict, 'insufficient');
  // the calls it waits for arrive, and the one that brings them queues its second look
  let i = 200;
  while ((await unseenCalls(await load(w.id))) < 88) await record(workspace.id, w.id, i++, set);
  assert.equal(await startWaiting(), 1);
  const job = await db.prepare(`SELECT id FROM jobs WHERE kind = 'eval_run' AND status = 'queued' AND (payload::jsonb ->> 'workloadId') = ?`)
    .get(w.id);
  assert.ok(job, 'a second look is queued');
  /* its first attempt drew sixty of the new calls before a deploy handed it over (HANDED_OVER in src/jobs.js), and the
     same job starts it again */
  const unseen = await unseenCalls(await load(w.id));
  const drew = await db.prepare(`SELECT c.id FROM calls c WHERE c.workload_id = ? AND NOT EXISTS (SELECT 1 FROM eval_samples s
      JOIN eval_runs r ON r.id = s.run_id WHERE s.call_id = c.id AND r.workload_id = ?) ORDER BY c.created_at DESC LIMIT 60`).all(w.id, w.id);
  const dead = `run_handed_${process.pid}`;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, created_at, started_at,
      finished_at, trigger, job_id, error) VALUES (?, ?, ?, 'failed', 'interrupted', ?, ?, ?, ?, ?, 'second_look', ?, ?)`)
    .run(dead, workspace.id, w.id, w.shape_kind, w.reference_model, now() - 120000, now() - 120000, now() - 60000, job.id, HANDED_OVER_DEPLOY);
  for (const c of drew) await db.prepare('INSERT INTO eval_samples (id, run_id, call_id) VALUES (?, ?, ?)').run(`smp_${c.id}`, dead, c.id);
  assert.equal(await unseenCalls(await load(w.id)), unseen - 60, 'drawn by its first attempt');
  const look = await runEvaluation(w.id, { trigger: 'second_look', jobId: job.id });
  assert.equal(look.ok, true, JSON.stringify(look));
  const again = await resultOf(look.runId, STEADY);
  assert.equal(Number(again.confirm_runs), unseen, `the new calls its first attempt drew are its own: ${again.confirm_runs} of ${unseen}`);
  assert.equal(again.confirm_verdict, 'cleared', `${again.confirm_verdict} on ${again.confirm_runs}`);
  assert.equal((await load(w.id)).routed_model, STEADY, 'and it switches, as it would have before the deploy');
});

test('negative: a workspace that measures only when asked books no second look by itself', async () => {
  const { workspace, workload: w } = await seeded({ n: 200, models: [DRIFTY], mode: 'auto' });
  await db.prepare('UPDATE workspaces SET measure_every_days = 0 WHERE id = ?').run(workspace.id);
  assert.equal((await runEvaluation(w.id)).ok, true);
  await enable(workspace.id, [STEADY]);
  const out = await runEvaluation(w.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await resultOf(out.runId, STEADY)).confirm_verdict, 'insufficient');
  const after = await load(w.id);
  assert.equal(after.measure_at_calls, null, 'nothing booked');
  assert.match((await lastActivity(w.id)).detail, /The next measurement looks again/);
});
