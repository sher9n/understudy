/* Routing performance first, end to end, against a provider and a Jev we control (support/routing-world.js).

   A router that sends each kind of request to the setup that does it well enough, written answers judged three ways by
   Jev, the control group that switches back a setup whose answers slip, and a serving router re-checked exactly as it
   serves. Each runs a real measurement, and where it matters real calls through the proxy, ordinary and streamed. Which
   of the setups that clear a workload it switches to, by what the workload optimizes for, is in
   routing-balance.e2e.test.js and routing-cost.e2e.test.js. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, now, runEvaluation, controlRecord, maybeControl, scoreServed, barOf, forgetBar, optimizeSpent,
  judgeBetter, judgeCandidate, judgeBarPair, keyOfSpec, armKey, planFor, buildUpstream, routeFor, cheaperCleared,
  zdrFor, config, REF, THIN, QUICK, CHEAP, STEADY, BETTER, WORSE, right, stand, failing, refusing, refText,
  writerText, seed, load, runOf, resultsOf, resultOf, armOf, send, callRow } from './support/routing-world.js';

/* 1. A router by kind of request ------------------------------------------------------------------ */

let kinds = null;

test('a measurement finds the kinds of request a cheap model gets right, and switches to routing by them', async () => {
  kinds = await seed({ enabled: [CHEAP, STEADY] });
  const out = await runEvaluation(kinds.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const rows = await resultsOf(out.runId);
  const cheap = rows.find((r) => r.model_id === CHEAP);
  assert.notEqual(cheap.verdict, 'cleared', `on its own the cheap one misses: ${cheap.gap_pct}%`);
  const key = `router:${CHEAP}+${STEADY}~kinds`;
  const router = rows.find((r) => r.model_id === key);
  assert.ok(router, `a router was worked out: ${rows.map((r) => `${r.model_id} ${r.verdict}`).join(', ')}`);
  assert.equal(router.verdict, 'cleared', `${router.gap_pct}%`);
  const steady = rows.find((r) => r.model_id === STEADY);
  assert.ok(Number(router.cost_ratio) <= Number(steady.cost_ratio) * 0.95, `it saves more than the steady one alone: ${router.cost_ratio} against ${steady.cost_ratio}`);
  const spec = JSON.parse(router.arm_json);
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.options.map((o) => o.model), [CHEAP, STEADY], 'only the setups its table uses');
  const rank = JSON.parse(router.rank_json);
  assert.ok(rank.kindsZ >= 1.645, `its kinds mattered: ${rank.kindsZ}`);
  assert.equal(router.choice_rank, 1, 'the best score');
  assert.equal(router.confirm_verdict, 'cleared', 'it passed a second look of its own');
  const arm = await armOf(kinds.workload.id);
  assert.equal(arm.kind, 'router', 'switched to it');
  assert.match(arm.label, /picked by kind of request/);
});

test('the router serves live calls by their kind, plain and streamed, and anything unfamiliar goes to the customer\'s model', async () => {
  const { secret, request } = kinds;
  const order = await send(secret, request(601));
  assert.deepEqual(JSON.parse(order.content), right(601));
  const orderRow = await callRow(order.callId);
  assert.equal(orderRow.served_model, CHEAP, 'an order question goes to the cheap model');
  assert.equal(Number(orderRow.escalated), 0);
  const orderCheck = JSON.parse(orderRow.check_json);
  assert.equal(orderCheck.by, 'router');
  assert.equal(orderCheck.why, 'kind');

  const refund = await send(secret, request(603));
  assert.deepEqual(JSON.parse(refund.content), right(603), 'the steady model gets refunds right');
  assert.equal((await callRow(refund.callId)).served_model, STEADY, 'a refund complaint goes to the steady model');

  const streamed = await send(secret, { ...request(606), stream: true });
  assert.deepEqual(JSON.parse(streamed.content), right(606));
  assert.equal((await callRow(streamed.callId)).served_model, STEADY, 'picked before the stream is sent');

  const odd = await send(secret, { ...request(1), messages: [request(1).messages[0], { role: 'user', content: 'Compose a sonnet about lighthouses in winter storms.' }] });
  assert.equal(odd.status, 200);
  const oddRow = await callRow(odd.callId);
  assert.equal(oddRow.served_model, REF, 'a request like none it learned from');
  assert.equal(Number(oddRow.escalated), 1);
  assert.equal(JSON.parse(oddRow.check_json).why, 'unfamiliar');
});

test('a measurement re-checks a healthy router and keeps it, beside a router learned again over the same setups', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  /* The quote counts every setup of the router serving now among the models measured to the end, as the run
     measures them: with a workspace that measures one model to the end, a router of two was quoted for one. */
  await db.prepare('UPDATE workspaces SET eval_models = 1 WHERE id = ?').run(workload.workspace_id);
  try {
    const plan = await planFor(await load(workload.id), { canRoute: true });
    assert.equal(plan.models, 2, `both of its setups quoted to the end: ${plan.models}`);
    assert.deepEqual(plan.order.slice(0, 2).map((o) => o.model), [CHEAP, STEADY], 'and first, as the run takes them');
  } finally {
    await db.prepare('UPDATE workspaces SET eval_models = NULL WHERE id = ?').run(workload.workspace_id);
  }
  const out = await runEvaluation(workload.id, { trigger: 'automatic' });
  assert.equal(out.ok, true, `the run finishes: ${JSON.stringify(out)}`);
  const key = `router:${CHEAP}+${STEADY}~kinds`;
  const choice = JSON.parse((await runOf(out.runId)).choice_json);
  assert.equal(choice.chosen, key, 'the router serving is what this test chose');
  assert.equal(choice.chosenKept, true, 'kept, not switched to');
  const rows = (await resultsOf(out.runId)).filter((r) => r.model_id === key);
  assert.equal(rows.length, 1, 'one result for the router serving, never a second under the same name');
  assert.equal(rows[0].verdict, 'cleared', `${rows[0].gap_pct}%`);
  assert.deepEqual(JSON.parse(rows[0].arm_json).table, JSON.parse(arm.spec_json).table, 'the one serving, as it serves');
  const w = await load(workload.id);
  assert.equal(w.routed_arm_id, arm.id, 'still serving');
  const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
  assert.match(said.title, /still clears your bar/);
});

test('a setup too busy to answer during a re-check never switches a router back', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
  failing.set(STEADY, 503);
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const steady = await resultOf(out.runId, STEADY);
    assert.equal(steady.stopped, 'errors', 'the busy setup stopped');
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.equal(row.verdict, 'insufficient', `the calls it could not answer are left out, not counted wrong: ${row.verdict}, ${row.gap_pct}%`);
    assert.ok(row.runs < 120, `judged on the calls that were answered: ${row.runs}`);
    assert.match(row.error_text || '', /could not be answered/);
    assert.equal((await load(workload.id)).routed_arm_id, arm.id, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
    assert.equal(after, before, 'nothing switched back');
    const said = await db.prepare(`SELECT title FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(workload.id);
    assert.match(said.title, /could not be checked in full/);
  } finally {
    failing.delete(STEADY);
  }
});

test('a setup refused on a request the router never sends it does not fail the router', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
  // the steady setup is refused a question about where an order is, which the router sends to the cheap one
  refusing.set(STEADY, (user) => (/refund/i.test(user) ? null : 400));
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal((await resultOf(out.runId, STEADY)).stopped, 'refused', 'on its own, the steady setup was refused');
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.notEqual(row.verdict, 'failed', `a refusal on a request it never sends there says nothing about the router: ${row.verdict}`);
    assert.notEqual(row.stopped, 'refused');
    // it answered every request the router sends it before it met the one it was refused, so the router is judged in full
    assert.equal(row.verdict, 'cleared', `${row.verdict}, on ${row.runs} calls`);
    assert.equal(row.runs, 120, 'on every call');
    assert.equal((await load(workload.id)).routed_arm_id, arm.id, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(workload.id)).n);
    assert.equal(after, before, 'nothing switched back');
  } finally {
    refusing.delete(STEADY);
  }
});

/* 2. Written answers, judged three ways ----------------------------------------------------------- */

let writer = null;

test('a written answer that adds what helps is counted better, and one that leaves out a fact is worse', async () => {
  const shop = await seed({ enabled: [BETTER, WORSE], text: true });
  writer = shop;
  const before = stand.jevAsked;
  const out = await runEvaluation(shop.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(stand.jevAsked > before, 'Jev judged the answers');
  const run = await runOf(out.runId);
  assert.equal(Number(run.noise_pct), 0, 'the customer\'s model says the same both times');
  const better = await resultOf(out.runId, BETTER);
  const worse = await resultOf(out.runId, WORSE);
  assert.equal(better.verdict, 'cleared', `a different answer that serves the person better is not a worse one: ${better.gap_pct}%`);
  assert.ok(Number(better.better_pct) > 90, `where it differed, it was the better one: ${better.better_pct}%`);
  assert.ok(['missed', 'review'].includes(worse.verdict), `leaving out when it arrives is never forgiven: ${worse.verdict}, ${worse.gap_pct}%`);
  assert.notEqual(worse.verdict, 'cleared');
  assert.equal((await load(shop.workload.id)).routed_model, BETTER);
});

/* 3. The control group ------------------------------------------------------------------------------ */

test('a burst of calls never runs more than two background checks at once for one workload', async () => {
  const { workload, request } = writer;
  const w = await load(workload.id);
  assert.ok(w.routed_arm_id, 'the better writer serves');
  const seen = [];
  let at = 0;
  let most = 0;
  // the customer's own model answering in the background, slowly, so the checks overlap
  const serve = async (spec, body, opts) => {
    seen.push(opts);
    at += 1;
    most = Math.max(most, at);
    await new Promise((r) => setTimeout(r, 150));
    at -= 1;
    return { json: { choices: [{ message: { content: refText(900) } }] }, cost: 0.002, latencyMs: 150 };
  };
  const decision = { armId: w.routed_arm_id, explored: false, escalated: false };
  const response = { choices: [{ message: { content: writerText(BETTER, 900) } }] };
  const outs = await Promise.all(Array.from({ length: 8 }, () => maybeControl({ workload: w, body: request(900), response, decision },
    { rng: () => 0, serve })));
  assert.equal(outs.filter(Boolean).length, 2, 'two ran, the rest were passed over rather than queued');
  assert.equal(most, 2);
  // asked with the workspace's own rule on providers that keep nothing
  assert.equal(seen[0].zdr, await zdrFor(workload.workspace_id));
  // a call a router or check sent on to the customer's own model is checked too
  const sentOn = await maybeControl({ workload: w, body: request(901), response, decision: { ...decision, escalated: true } },
    { rng: () => 0, serve });
  assert.ok(sentOn, 'checked');
  assert.equal(JSON.parse(sentOn.detail_json).escalated, true);
});

test('background checks never spend the last quarter of the optimization budget, which is kept for measurements', async () => {
  const { workload, request } = writer;
  const w = await load(workload.id);
  const spent = await optimizeSpent(w.workspace_id);
  assert.ok(spent > 0, 'the measurement above was optimizing spend');
  const serve = async () => ({ json: { choices: [{ message: { content: refText(950) } }] }, cost: 0.002, latencyMs: 5 });
  const decision = { armId: w.routed_arm_id, explored: false, escalated: false };
  const response = { choices: [{ message: { content: writerText(BETTER, 950) } }] };
  const check = (i) => maybeControl({ workload: w, body: request(i), response, decision }, { rng: () => 0, serve });
  try {
    // a fifth of the budget left: that is for measurements
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(spent * 1.25, w.workspace_id);
    assert.equal(await check(950), null, 'not checked');
    // half of it left: checked
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = ? WHERE id = ?').run(spent * 2, w.workspace_id);
    assert.ok(await check(951), 'checked');
  } finally {
    await db.prepare('UPDATE workspaces SET optimize_budget_usd = NULL WHERE id = ?').run(w.workspace_id);
  }
});

test('the control group counts only the checks judged by the yardstick of the pass mark they are held to', async () => {
  const w = await load(writer.workload.id);
  const bar = await barOf(w);
  const other = bar.yardstick === 'quality' ? 'agreement' : 'quality';
  const before = await controlRecord(w);
  let k = 0;
  const add = async (yardstick, score, n) => {
    for (let j = 0; j < n; j += 1) {
      k += 1;
      await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, judged_by, yardstick, cost_usd, status, created_at)
          VALUES (?, ?, ?, ?, ?, 0, 'test', ?, 0.001, 200, ?)`).run(`ctl_yard_${process.pid}_${k}`, w.workspace_id, w.id, w.routed_arm_id, score, yardstick, now());
    }
  };
  try {
    // forty worse answers, judged by the other yardstick: a mark set for this one says nothing of them
    await add(other, 1, 40);
    const mixed = await controlRecord(w);
    assert.equal(mixed.n, before.n, 'not counted');
    assert.equal(mixed.worse, before.worse);
    assert.ok(mixed.costUsd > before.costUsd, 'though what they cost is');
    await add(bar.yardstick, 0, 5);
    assert.equal((await controlRecord(w)).n, before.n + 5, 'the ones judged by this yardstick are');
  } finally {
    await db.prepare(`DELETE FROM control_checks WHERE id LIKE 'ctl_yard_%'`).run();
  }
});

test('a measurement that found the customer\'s model too unsteady to measure never sets the bar a switch is held to', async () => {
  const w = await load(writer.workload.id);
  forgetBar(w.id);
  const before = await barOf(w);
  const runId = `run_unsteady_${process.pid}`;
  // such a measurement writes the mark it worked out before it gives up: here 60%, which nothing could ever pass
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, floor_pct, noise_pct,
      yardstick, created_at, finished_at) VALUES (?, ?, ?, 'done', 'unmeasurable', ?, ?, 60, 48, 'agreement', ?, ?)`)
    .run(runId, w.workspace_id, w.id, w.shape_kind, w.reference_model, now(), now());
  try {
    forgetBar(w.id);
    assert.deepEqual(await barOf(w), before, 'the bar stays the one the last measurement that could set it set');
  } finally {
    await db.prepare('DELETE FROM eval_runs WHERE id = ?').run(runId);
    forgetBar(w.id);
  }
});

test('the control group judges by the yardstick the switch was measured by, and leaves out calls nobody finished', async () => {
  const body = writer.request(902);
  const served = { choices: [{ message: { content: writerText(WORSE, 902) } }] };
  const ref = { choices: [{ message: { content: refText(902) } }] };
  const same = await scoreServed(body, served, ref, 'free_text', { yardstick: 'agreement' });
  assert.equal(same.score, 1, 'held to the same answer, leaving out when it arrives is a different answer');
  // held to "at least as good" by the judge its measurement chose (here the language model), the quality judge reads it
  const good = await scoreServed(body, served, ref, 'free_text', { yardstick: 'quality', prefer: 'llm' });
  assert.equal(good.judgedBy, 'llm-quality', 'held to "at least as good", the quality judge reads it');
  assert.equal(good.score, 0, 'and the stand-in judge calls it a tie');
  // with no judge chosen, Jev reads it first, both ways round, and sees what the writer left out
  const jev = await scoreServed(body, served, ref, 'free_text', { yardstick: 'quality' });
  assert.equal(jev.judgedBy, 'jev-quality');
  assert.equal(jev.score, 1);
  // an answer cut short counts against what served only when the customer's model finished the same call
  const cut = { choices: [{ message: { content: 'Order 902 ship' }, finish_reason: 'length' }] };
  assert.equal((await scoreServed(body, cut, ref, 'free_text')).score, 1);
  assert.equal((await scoreServed(body, cut, cut, 'free_text')).score, null, 'both cut short: the call says nothing');
});

test('a reading of which answer serves better that did not come back never counts against what already serves', async () => {
  const w = await load(writer.workload.id);
  assert.equal(w.routed_model, BETTER, 'the better writer serves');
  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(w.id)).n);
  stand.betterRefused = true;
  try {
    // the control group says nothing on such a check
    const body = writer.request(7202);
    const s = await scoreServed(body, { choices: [{ message: { content: writerText(BETTER, 7202) } }] },
      { choices: [{ message: { content: refText(7202) } }] }, 'free_text', { yardstick: 'agreement', scope: 'unsettled-control' });
    assert.equal(s.score, null, 'no reading');
    // and a re-check does not find what serves wanting on readings that never came back
    const out = await runEvaluation(w.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const better = await resultOf(out.runId, BETTER);
    /* Its row counts every difference, as every row does, so it ranks against the rest on the same terms: read
       as it serves instead, it came first where it should not have, and a cheaper setup was never looked at again.
       Whether it keeps serving is decided on the reading as it serves, which leaves those differences out. */
    assert.ok(Number(better.gap_pct) > 0, `the row counts the differences a reading left unsettled: ${better.verdict}, ${better.gap_pct}%`);
    // while a setup that would be switched to still has every such difference counted against it
    const worse = await resultOf(out.runId, WORSE);
    assert.ok(['missed', 'review'].includes(worse.verdict), `${worse.verdict}, ${worse.gap_pct}%`);
    assert.equal((await load(w.id)).routed_model, BETTER, 'still serving');
    const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE workload_id = ?').get(w.id)).n);
    assert.equal(after, before, 'nothing switched back');
  } finally {
    stand.betterRefused = false;
  }
});

/* 4. A serving router, re-checked as it serves --------------------------------------------------------- */

test('a measurement re-checks the serving router exactly as it serves, and switches it back when its cheap model slips', async () => {
  const { workload } = kinds;
  const arm = await armOf(workload.id);
  assert.equal(arm.kind, 'router');
  stand.cheapBroken = true;
  try {
    const out = await runEvaluation(workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.ok(row, 'the serving router was worked out again');
    assert.deepEqual(JSON.parse(row.arm_json).centroids, JSON.parse(arm.spec_json).centroids, 'with the kinds it serves by, never learned again');
    assert.deepEqual(JSON.parse(row.arm_json).table, JSON.parse(arm.spec_json).table, 'and the table it serves by');
    assert.equal(row.verdict, 'missed', `${row.gap_pct}%`);
    const w = await load(workload.id);
    assert.equal(w.routed_model, null, 'switched back to the customer\'s own model');
    const r = await db.prepare('SELECT * FROM promotions WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
    // for a while, not for good: what a router may have lost is its table, and a later measurement can learn it afresh
    assert.equal(r.action, 'soft_revert');
    assert.equal((await db.prepare('SELECT status FROM arms WHERE id = ?').get(arm.id)).status, 'resting');
  } finally {
    stand.cheapBroken = false;
  }
});

/* 5. The edges: three-way readings, and routers with specs that make no sense ----------------------------- */

test('a difference is forgiven only when both readings leave the customer\'s answer little chance of being better', async () => {
  let n = 0;
  // Jev as asked twice, with the candidate first in the first reading and second in the second
  const reading = (pCand, pRef, fail = false) => async (state) => {
    n += 1;
    if (fail && n % 2 === 0) throw new Error('Jev is busy');
    const candFirst = String(state.answers.first).startsWith('cand');
    const probabilities = { first: candFirst ? pCand : pRef, second: candFirst ? pRef : pCand, equal: Math.max(0, 1 - pCand - pRef) };
    return { answers: { better: { type: 'choice', probabilities } }, costUsd: 0.001 };
  };
  const ask3 = (tag, pCand, pRef, fail) => judgeBetter(`request ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: reading(pCand, pRef, fail) });
  assert.equal((await ask3('a', 0.7, 0.2)).verdict, 'better');
  assert.equal((await ask3('b', 0.5, 0.2)).verdict, 'equal');
  assert.equal((await ask3('c', 0.65, 0.35)).verdict, 'kept', 'better by a head, but the customer\'s answer kept a third of a chance');
  const busy = await ask3('d', 0.9, 0.05, true);
  assert.equal(busy.transient, true, 'one reading did not come back');
  assert.equal(busy.verdict, null);
  assert.ok(Math.abs(busy.cost - 0.001) < 1e-12, `the reading that did come back is paid for: ${busy.cost}`);
});

test('a reading that sends only its pick and how sure it was is read on the safe side', async () => {
  // Jev's pick in each order, with no chances beside it
  const picked = (candFirstPick, refFirstPick, confidence) => async (state) => {
    const candFirst = String(state.answers.first).startsWith('cand');
    return { answers: { better: { type: 'choice', choice: candFirst ? candFirstPick : refFirstPick, confidence } }, costUsd: 0.001 };
  };
  const ask3 = (tag, a, b, c) => judgeBetter(`request pick ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: picked(a, b, c) });
  assert.equal((await ask3('a', 'first', 'second', 0.9)).verdict, 'better', 'the candidate\'s answer picked, surely, both times');
  assert.equal((await ask3('b', 'equal', 'equal', 0.9)).verdict, 'equal', 'about equal, surely: forgiven, and no better');
  assert.equal((await ask3('c', 'equal', 'equal', 0.55)).verdict, 'kept', 'about equal only just: the customer\'s answer could have had nearly half');
  assert.equal((await ask3('d', 'first', 'first', 0.9)).verdict, 'kept', 'the customer\'s answer picked once');
  const none = await judgeBetter('request pick e', 'cand e', 'ref e', { askFn: async () => ({ answers: { better: { type: 'choice' } }, costUsd: 0.001 }) });
  assert.equal(none.transient, true, 'no pick and no chances is no reading');
  const odd = (tag, better) => judgeBetter(`request odd ${tag}`, `cand ${tag}`, `ref ${tag}`, { askFn: async () => ({ answers: { better }, costUsd: 0.001 }) });
  assert.equal((await odd('f', { choice: 'neither', confidence: 0.9 })).transient, true, 'a pick that is none of the three is no reading');
  assert.equal((await odd('g', { choice: 'first', confidence: 1.4 })).transient, true, 'nor is a confidence that is not a chance');
  assert.equal((await odd('h', { probabilities: { first: 2, second: 0, equal: 0 } })).transient, true, 'nor a chance above one');
  assert.equal((await odd('i', { choice: 'second', confidence: 0.25 })).transient, true, 'nor a pick of three at under a third, which no pick can be');
});

test('a cascade\'s cheap model is served by the providers it was measured on first, and by others when they cannot', () => {
  const body = { messages: [{ role: 'user', content: 'Where is my order #5?' }] };
  const pinned = buildUpstream(body, CHEAP, { providers: ['deepinfra/fp8'] });
  assert.deepEqual(pinned.provider.only, ['deepinfra/fp8'], 'a model switched to on its own is held to them');
  assert.equal(pinned.provider.order, undefined);
  const preferred = buildUpstream(body, CHEAP, { providers: ['deepinfra/fp8'], preferred: true });
  assert.deepEqual(preferred.provider.order, ['deepinfra/fp8'], 'a cascade\'s cheap model asks them first');
  assert.equal(preferred.provider.allow_fallbacks, true, 'and others when they cannot answer');
  assert.equal(preferred.provider.only, undefined);
  const cascade = (recipe) => ({ kind: 'cascade', first: { model: CHEAP, recipe }, fallback: { model: REF, recipe: null } });
  assert.equal(armKey(cascade({ providers: ['deepinfra/fp8'], preferred: true })), armKey(cascade(null)), 'the same cascade, however its providers are held');
});

test('a reading of which answer serves better that did not come back counts the difference against what is served, never loosens the pass mark, and is asked again', async () => {
  const request = 'Where is my order #7101?';
  const ref = refText(7101);
  const cand = writerText(BETTER, 7101);
  stand.betterRefused = true;
  try {
    const c = await judgeCandidate(request, cand, ref, null, { scope: 'unsettled' });
    assert.equal(c.score, 1, 'the difference stands');
    assert.ok(!c.transient, 'and the call is counted, not dropped, which flattered the candidate');
    assert.equal(c.unsettled, true);
    const served = await judgeBarPair(request, ref, cand, { scope: 'unsettled' });
    assert.equal(served.score, 1, 'the same for an answer held against the customer\'s');
    assert.equal(served.unsettled, true);
    const bar = await judgeBarPair(request, ref, cand, { scope: 'unsettled', bar: true });
    assert.equal(bar.transient, true, 'setting the pass mark, the pair is left out: counted, it would loosen the mark');
  } finally {
    stand.betterRefused = false;
  }
  const again = await judgeCandidate(request, cand, ref, null, { scope: 'unsettled' });
  assert.equal(again.score, 0, 'never kept, so asked again once Jev reads it: forgiven');
  assert.equal(again.detail.better, 1, 'and the better one');
});

test('what serves is read without only the differences a reading left unsettled, never without a settled one beside them', async () => {
  const request = 'Where is my order #7301?';
  const cand = writerText(BETTER, 7301);
  stand.betterRefused = true;
  try {
    // against one of the customer\'s answers the difference is in wording and unsettled; against the other, in the order number
    const figures = await judgeCandidate(request, cand, refText(7301), refText(7302), { scope: 'settled-a' });
    assert.equal(figures.score, 1, 'held against both, as anything that could be switched to is');
    assert.equal(figures.unsettled, true);
    assert.equal(figures.settled, 1, 'and for what serves, the difference in figures still stands');
    // against the other, the same answer with a word changed: for what serves, it agrees
    const alike = await judgeCandidate(request, cand, refText(7301), cand.replace('email.', 'email!'), { scope: 'settled-b' });
    assert.equal(alike.score, 0.5);
    assert.equal(alike.settled, 0, 'the unsettled one is left out, the settled one kept');
  } finally {
    stand.betterRefused = false;
  }
});

test('different figures make a different answer against each of the customer\'s answers on its own', async () => {
  const request = 'Where is my order #7401?';
  // leaves out when it arrives, which one of the customer's answers says; and reads like the other, but with a different figure
  const cand = 'Order 7401 (3 boxes) shipped today.';
  const says = refText(7401);
  const figures = 'Order 7401 (4 boxes) shipped today.';
  const both = await judgeCandidate(request, cand, says, figures, { scope: 'figures-each' });
  assert.equal(both.score, 1, 'different from each of them, so different: floored over their average, it read as half');
  stand.betterRefused = true;
  try {
    const open = await judgeCandidate(request, cand, says, figures, { scope: 'figures-open' });
    assert.equal(open.unsettled, true);
    assert.equal(open.score, 1);
    assert.equal(open.settled, 1, 'and the reading of what serves is never stricter than the one of what could be switched to');
  } finally {
    stand.betterRefused = false;
  }
});

test('a router is known by the setups it chooses between, in whatever order they are listed', () => {
  const spec = (options) => ({ kind: 'router', version: 2, options, strong: { model: REF } });
  const two = [{ model: STEADY }, { model: CHEAP }];
  assert.equal(keyOfSpec(spec(two), REF), keyOfSpec(spec([...two].reverse()), REF));
  assert.equal(keyOfSpec(spec(two), REF), `router:${CHEAP}+${STEADY}~kinds`);
  assert.equal(armKey(spec(two)), armKey(spec([...two].reverse())));
});

test('a router whose spec names a setup it does not have, or none at all, sends the call to the customer\'s own model', () => {
  const body = { messages: [{ role: 'user', content: 'Where is my order #5?' }] };
  const kindsSpec = (extra) => ({ kind: 'router', version: 2, options: [{ model: CHEAP }], strong: { model: REF },
    centroids: [new Array(256).fill(0)], minSim: [0], idf: new Array(256).fill(1), table: [3], sizes: [10], ...extra });
  const missing = routeFor(kindsSpec(), body);
  assert.equal(missing.use.model, REF, 'the table names setup 3 of 1');
  assert.equal(missing.escalated, true);
  assert.equal(missing.check.why, 'no such setup');
  const noStrong = routeFor(kindsSpec({ strong: null }), body, { fallback: { model: 'fallback/model' } });
  assert.equal(noStrong.use.model, 'fallback/model');
  assert.equal(routeFor(kindsSpec({ strong: null }), body).use, null, 'with nothing at all, nothing, for the caller to answer the usual way');
  const unreadable = routeFor({ ...kindsSpec(), centroids: null }, { messages: [{ role: 'user', content: { odd: true } }] });
  assert.equal(unreadable.use.model, REF);
  // the older kind, with its weights gone
  const old = routeFor({ kind: 'router', cheap: { model: CHEAP }, strong: { model: REF }, threshold: 0.5, weights: null }, body);
  assert.equal(old.use.model, REF);
});

test('a test re-checks an older router whose weights are gone as it serves, every request to the customer\'s own model, and finishes', async () => {
  const shop = await seed({ enabled: [CHEAP, STEADY] });
  const spec = { kind: 'router', cheap: { model: CHEAP, recipe: null }, strong: { model: REF, recipe: null }, threshold: 0.5 };
  const armId = `arm_${Math.random().toString(36).slice(2, 14)}`;
  await db.prepare(`INSERT INTO arms (id, workspace_id, workload_id, kind, key, spec_json, label, status, origin_run_id, offline_json,
      stats_json, created_at, updated_at) VALUES (?, ?, ?, 'router', ?, ?, 'an older router', 'serving', NULL, NULL, NULL, ?, ?)`)
    .run(armId, shop.workspace.id, shop.workload.id, armKey(spec), JSON.stringify(spec), now(), now());
  await db.prepare(`UPDATE workloads SET routed_model = ?, routed_arm_id = ?, promoted_at = ?, status = 'promoted' WHERE id = ?`)
    .run(CHEAP, armId, now(), shop.workload.id);
  // it threw while the strategies were worked out, and the whole test with it (a test nobody asked for, since 5 Oct 2026)
  const out = await runEvaluation(shop.workload.id, { trigger: 'automatic' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const row = (await resultsOf(out.runId)).find((r) => {
    try { const a = JSON.parse(r.arm_json || 'null'); return a?.kind === 'router' && !a.version; } catch { return false; }
  });
  assert.ok(row, 'the router serving was worked out again, as it serves');
  assert.ok(Number(row.cost_ratio) > 0.95, `every request to the customer's own model: it costs ${row.cost_ratio} of it`);
});

/* 6. A workload optimizing for quality with nothing it is sure enough of --------------------------------- */

test('what a workload optimizing for quality is not sure enough of is never looked at again, offered or tried, and it says so', async () => {
  const sure = config.CAUTIOUS_MIN_CHANCE;
  // surer than 120 clean calls can ever make anything, so both setups that clear are left out
  config.CAUTIOUS_MIN_CHANCE = 0.9999;
  try {
    const shop = await seed({ enabled: [THIN, QUICK], workspaceRouting: 'quality' });
    const out = await runEvaluation(shop.workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const rows = await resultsOf(out.runId);
    for (const m of [THIN, QUICK]) {
      const r = rows.find((x) => x.model_id === m);
      assert.equal(r.verdict, 'cleared');
      assert.equal(r.confirm_verdict, 'left_out', `${m} was left out, not "not reached"`);
      assert.equal(r.confirm_runs, null, 'and never looked at again');
    }
    assert.deepEqual(cheaperCleared(rows), [], 'nothing is offered to approve');
    const w = await load(shop.workload.id);
    assert.equal(w.routed_model, null, 'nothing switched');
    assert.equal(w.status_note, 'A candidate cleared, but not surely enough for a workload optimized for quality');
    const said = await db.prepare(`SELECT title, detail FROM activity WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1`).get(shop.workload.id);
    assert.match(said.title, /not surely enough for a workload optimized for quality/);
    assert.match(said.detail, /choosing Balance under Optimize for, on the workload page/);
    assert.doesNotMatch(said.detail, /most one measurement may spend/, 'never put down to money');
    const trying = await db.prepare(`SELECT COUNT(*) AS n FROM arms WHERE workload_id = ? AND status = 'trying'`).get(shop.workload.id);
    assert.equal(Number(trying.n), 0, 'and not tried on live calls, where an experiment could switch to it');
  } finally {
    config.CAUTIOUS_MIN_CHANCE = sure;
  }
});

/* 7. A router whose setup is refused outright ------------------------------------------------------------- */

test('a setup refused on every request fails the router it is part of, whatever kind of request comes first', async () => {
  const shop = await seed({ enabled: [CHEAP, STEADY] });
  const first = await runEvaluation(shop.workload.id);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await armOf(shop.workload.id))?.kind, 'router', 'switched to a router by kind of request');
  // no provider will take the steady setup any more, whatever it is asked
  refusing.set(STEADY, () => 404);
  try {
    const out = await runEvaluation(shop.workload.id, { trigger: 'automatic' });
    assert.equal(out.ok, true, JSON.stringify(out));
    /* It answers the requests the router sends it first, so the refusal lands on one of them. Asked in the order
       the calls were drawn, it met a question about an order first two times in three and stopped there; the
       router then read as judged on too few calls, and went on serving with a setup that could answer nothing. */
    const row = await resultOf(out.runId, `router:${CHEAP}+${STEADY}~kinds`);
    assert.equal(row.verdict, 'failed', `${row.verdict} on ${row.runs} calls`);
    assert.equal(row.stopped, 'refused');
    const asked = await db.prepare(`SELECT c.request_json FROM eval_replays r JOIN calls c ON c.id = r.call_id
        WHERE r.run_id = ? AND r.model_id = ?`).all(out.runId, STEADY);
    assert.equal(asked.length, 1, 'refused once, and stopped there');
    assert.match(asked[0].request_json, /refund/i, 'on a refund complaint, a request the router sends it');
    assert.equal((await load(shop.workload.id)).routed_model, null, 'switched back to the customer\'s own model');
  } finally {
    refusing.delete(STEADY);
  }
});
