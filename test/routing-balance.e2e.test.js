/* What a workload optimizes for, end to end: balance switches to the best score and keeps what serves against one only a
   point or two higher, quality holds the second look to a stricter bound, and after the switch the control group's
   background checks catch the model that slipped. Cost is in routing-cost.e2e.test.js, and the world all the routing
   tests run in, a provider and a Jev we control, in support/routing-world.js. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, learningSettled, runEvaluation, onServed, afterServed, reviewWorkload, forgetState, controlRecord,
  optimizeSpent, runPageOf, THIN, QUICK, withRefDelay, stand, seed, load, runOf, resultOf, send } from './support/routing-world.js';

/* 1. Balance and quality (src/eval/score.js) --------------------------------------------------------------- */

let balanced = null;

test('balance switches to the best score: of two that save about the same, the much faster, and it keeps every score', async () => {
  balanced = await seed({ enabled: [THIN, QUICK] });
  const out = await withRefDelay(150, () => runEvaluation(balanced.workload.id));
  assert.equal(out.ok, true, JSON.stringify(out));
  balanced.runId = out.runId;
  const run = await runOf(out.runId);
  assert.equal(run.routing_mode, 'balance', 'nobody chose, so the default');
  const thin = await resultOf(out.runId, THIN);
  const quick = await resultOf(out.runId, QUICK);
  assert.equal(thin.verdict, 'cleared');
  assert.equal(quick.verdict, 'cleared');
  assert.ok(Number(thin.cost_ratio) < Number(quick.cost_ratio), `thin is the cheaper: ${thin.cost_ratio} against ${quick.cost_ratio}`);
  assert.ok(Number(thin.latency_p50) > Number(quick.latency_p50) + 45, `and the slower: ${thin.latency_p50} against ${quick.latency_p50} ms`);
  // how sure the measurement is, and what that makes the saving, on every setup that cleared
  for (const r of [thin, quick]) {
    assert.ok(Number(r.chance) > 0.99, `${r.model_id}: sure it keeps the bar, ${r.chance}`);
    assert.ok(Math.abs(Number(r.safe_saving) - (1 - Number(r.cost_ratio) * 1.01) * Number(r.chance)) < 1e-6, `${r.model_id}: safe saving ${r.safe_saving}`);
  }
  assert.equal(quick.choice_rank, 1, 'the faster one comes first');
  assert.equal(thin.choice_rank, 2);
  const choice = JSON.parse(run.choice_json);
  assert.equal(choice.mode, 'balance');
  assert.deepEqual(choice.weights, { quality: 40, cost: 30, speed: 30 });
  assert.deepEqual(choice.order.map((x) => x.model), [QUICK, THIN]);
  // every score kept with the run, each part out of 100 and the score built from the rounded parts
  for (const x of choice.order) {
    const { quality, cost, speed } = x.parts;
    assert.ok([quality, cost, speed].every((v) => Number.isInteger(v) && v >= 0 && v <= 100), JSON.stringify(x.parts));
    assert.equal(x.score, Math.round((40 * quality + 30 * cost + 30 * speed) / 100));
  }
  const [q, t] = choice.order;
  assert.equal(q.parts.cost, t.parts.cost, `they save about the same: ${q.parts.cost} and ${t.parts.cost}`);
  assert.ok(q.parts.speed > t.parts.speed + 20, `the quick one is much sooner: ${q.parts.speed} against ${t.parts.speed}`);
  assert.ok(q.score > t.score, `${q.score} against ${t.score}`);
  assert.equal(choice.chosen, QUICK, 'what the test chose is written down as it was decided');
  assert.equal(choice.chosenKept, false, 'a switch, not a setup kept');
  assert.equal(quick.confirm_verdict, 'cleared', 'it passed its second look');
  assert.equal(thin.confirm_verdict, 'not_reached', 'and the one after it never needed one');
  const w = await load(balanced.workload.id);
  assert.equal(w.routed_model, QUICK, 'switched to the faster one');
  // and the test's page names it the pick, as the best balance, first in its order
  const page = await runPageOf(w, run);
  assert.equal(page.bestBy.balance, QUICK);
  assert.equal(page.keptBy.balance, false);
  assert.equal(page.orderBy.balance[0], QUICK);
});

test('a score only a point or two higher never takes the place of what serves', async () => {
  const { workload } = balanced;
  // quick serves; thin saves the same and, with the customer's model as quick as they are, scores the same: nothing moves
  const out = await runEvaluation(workload.id, { trigger: 'automatic' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const choice = JSON.parse((await runOf(out.runId)).choice_json);
  assert.equal(choice.servingKept, QUICK);
  const thin = choice.order.find((x) => x.model === THIN);
  assert.ok(!thin || thin.score < choice.servingScore + choice.margin, JSON.stringify(choice.order));
  assert.equal(choice.chosen, QUICK, 'kept');
  assert.equal(choice.chosenKept, true);
  assert.equal((await load(workload.id)).routed_model, QUICK);
});

test('optimizing for quality, read from the Cautious the workspace chose before, holds the second look to a stricter bound', async () => {
  const shop = await seed({ enabled: [THIN, QUICK], workspaceRouting: 'cautious' });
  const out = await withRefDelay(150, () => runEvaluation(shop.workload.id));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runOf(out.runId)).routing_mode, 'quality', 'the workspace\'s choice, the workload having none, under its new name');
  const quick = await resultOf(out.runId, QUICK);
  assert.equal(quick.choice_rank, 1, 'both are sure enough, so the better score comes first');
  assert.equal(quick.confirm_verdict, 'cleared');
  const easy = await resultOf(balanced.runId, QUICK);
  assert.equal(quick.confirm_runs, easy.confirm_runs, `the same number of calls as a balanced look: ${quick.confirm_runs} and ${easy.confirm_runs}`);
  assert.ok(Number(quick.confirm_hi) > Number(easy.confirm_hi),
    `the same clean record reads as less certain under the stricter bound: at most ${quick.confirm_hi}% against ${easy.confirm_hi}%`);
  assert.equal((await load(shop.workload.id)).routed_model, QUICK);
});

/* 2. The control group, after the first test's switch (the rest of it is in routing.e2e.test.js) ------------ */

test('after a switch, answers checked against the customer\'s model in the background switch back one that slipped', async () => {
  const { secret, request, workload } = balanced;
  assert.equal((await load(workload.id)).routed_model, QUICK, 'serving the quick one from the first test');
  // every answer the switch serves is also asked of the customer's model, in the background
  onServed((info) => afterServed(info, { control: { rng: () => 0 } }));
  stand.quickBroken = true;
  try {
    for (let i = 0; i < 32; i += 1) {
      const r = await send(secret, request(700 + i));
      assert.equal(r.status, 200);
    }
    await learningSettled();
    const rec = await controlRecord(await load(workload.id));
    assert.ok(rec.n >= 30, `the checks: ${rec.n}`);
    assert.ok(rec.worse >= 30, `every one of them worse: ${rec.worse}`);
    assert.ok(rec.lo * 100 > rec.floorPct, `the whole range past the bar: at least ${(rec.lo * 100).toFixed(1)}% against ${rec.floorPct}%`);
    const cost = await db.prepare(`SELECT COUNT(*) AS n FROM control_checks WHERE workload_id = ? AND cost_usd > 0`).get(workload.id);
    assert.ok(Number(cost.n) >= 30, 'each background answer is paid for');
    forgetState(workload.id);
    const d = await reviewWorkload(await load(workload.id));
    assert.equal(d[0]?.kind, 'revert', JSON.stringify(d));
    assert.equal(d[0]?.by, 'control');
    const w = await load(workload.id);
    assert.equal(w.routed_model, null, 'back on the customer\'s own model');
    const back = await db.prepare('SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
    assert.match(back.reason || '', /in the background/, `said why: ${back.reason}`);
  } finally {
    stand.quickBroken = false;
    onServed(null);
  }
});

test('what the background checks cost is optimizing spend, and counts against the budget', async () => {
  const { workspace } = balanced;
  const sum = async (sql) => Number((await db.prepare(sql).get(workspace.id)).s);
  const checks = await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM control_checks WHERE workspace_id = ?');
  assert.ok(checks > 0, 'the checks above were paid for');
  const others = await sum('SELECT COALESCE(SUM(spend_usd), 0) AS s FROM eval_runs WHERE workspace_id = ?')
    + await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM shadow_runs WHERE workspace_id = ?')
    + await sum('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM graded_calls WHERE workspace_id = ?');
  const spent = await optimizeSpent(workspace.id);
  assert.ok(Math.abs(spent - (others + checks) * 1.01) < 1e-6, `optimizing spend ${spent} counts the checks' ${checks} beside ${others}`);
});
