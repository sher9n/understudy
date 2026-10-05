/* What a workload optimizes for, end to end: cost switches to the cheaper of two that pass, and once the workload
   optimizes for balance a clearly better score takes the place of the cheaper model serving. Balance and quality are in
   routing-balance.e2e.test.js, and the world all the routing tests run in, a provider and a Jev we control, in
   support/routing-world.js. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, runEvaluation, forgetState, runPageOf, THIN, STEADY, withRefDelay, seed, load, runOf, resultOf } from './support/routing-world.js';

/* Cost, and balance after it (src/eval/score.js) ------------------------------------------------------------- */

let costly = null;

test('optimizing for cost switches to the cheaper of two that pass, where balance would take the much faster', async () => {
  // enough requests for two tests and two second looks on requests no test has drawn
  costly = await seed({ enabled: [THIN, STEADY], routing: 'cost', n: 700 });
  const out = await withRefDelay(150, () => runEvaluation(costly.workload.id));
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.routing_mode, 'cost', 'the workload\'s own choice');
  const choice = JSON.parse(run.choice_json);
  assert.deepEqual(choice.order.map((x) => x.model), [THIN, STEADY], JSON.stringify(choice.order));
  assert.equal((await resultOf(out.runId, THIN)).choice_rank, 1);
  assert.equal((await load(costly.workload.id)).routed_model, THIN);
  // the same two, read for balance: the steady one is dearer, and so much sooner that it scores higher
  const [t, st] = choice.order;
  const balance = (x) => Math.round((40 * x.parts.quality + 30 * x.parts.cost + 30 * x.parts.speed) / 100);
  assert.ok(balance(st) >= balance(t) + 3, `balance would switch to the steady one: ${balance(st)} against ${balance(t)}`);
  costly.firstRun = out.runId;
});

test('a clearly better score takes the place of a cheaper model that serves, once the workload optimizes for balance', async () => {
  const { workload } = costly;
  // the workload lets go of its own choice and follows the workspace, which has none: balance
  await db.prepare('UPDATE workloads SET routing_mode = NULL WHERE id = ?').run(workload.id);
  forgetState(workload.id);
  const out = await withRefDelay(150, () => runEvaluation(workload.id, { trigger: 'automatic' }));
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.routing_mode, 'balance');
  const choice = JSON.parse(run.choice_json);
  assert.equal(choice.servingKept, THIN, 'what serves still passed');
  assert.ok(Number.isInteger(choice.servingScore), `and has a score: ${choice.servingScore}`);
  const steady = choice.order.find((x) => x.model === STEADY);
  assert.ok(steady.score >= choice.servingScore + choice.margin, `the steady one scores clearly higher: ${steady.score} against ${choice.servingScore}`);
  const look = await resultOf(out.runId, STEADY);
  assert.equal(choice.chosen, STEADY, `looked at again (${look.confirm_verdict}, ${look.confirm_runs} new requests), and switched to`);
  const w = await load(workload.id);
  assert.equal(w.routed_model, STEADY, 'dearer than what served, and better on balance');
  // its page names the one it switched to; the test before it still names what it chose, whatever serves since
  assert.equal((await runPageOf(w, run)).bestBy.balance, STEADY);
  const before = await runPageOf(w, await runOf(costly.firstRun));
  assert.equal(before.bestBy.cost, THIN, 'what that test chose, optimizing for cost');
  assert.equal(before.bestBy.balance, STEADY, 'and what it would have, for balance, with nothing serving then');
});
