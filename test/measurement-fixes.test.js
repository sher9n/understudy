/* The pure parts the measurement engine's fixes rest on, with inputs built by hand so every answer
   can be checked without a database, a provider or a penny spent. The end-to-end cases are in
   test/measurement-fixes.e2e.test.js. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.JEV_VIA = 'off';
process.env.TYPESAFE_API_KEY = '';
process.env.ALERTS_ENABLED = 'false';
const { confirmed, cheaperCleared } = await import('../src/eval/outcome.js');
const { worthOf } = await import('../src/eval/plan.js');
const { selectCandidates } = await import('../src/eval/select.js');
const { judgePrices } = await import('../src/eval/judge.js');
const { default: config } = await import('../src/config.js');

test('only a second look that cleared, or a strategy\'s live one, stands behind a result', () => {
  assert.equal(confirmed({ confirm_verdict: 'cleared' }), 1);
  assert.equal(confirmed({ confirm_verdict: 'live' }), 1);
  // nothing written used to read as confirmed, and so did a look never reached
  for (const v of [null, undefined, 'not_reached', 'insufficient', 'missed', 'review', 'unconfirmed']) {
    assert.equal(confirmed({ confirm_verdict: v }), 0, String(v));
  }
});

test('a result never looked at twice is never offered before one that was', () => {
  const rows = [
    { model_id: 'x/ref', verdict: 'reference', cost_month_usd: 10 },
    { model_id: 'never', verdict: 'cleared', cost_month_usd: 1, confirm_verdict: 'not_reached' },
    { model_id: 'old', verdict: 'cleared', cost_month_usd: 2, confirm_verdict: null },
    { model_id: 'twice', verdict: 'cleared', cost_month_usd: 3, confirm_verdict: 'cleared' },
    { model_id: 'cascade:live', verdict: 'cleared', cost_month_usd: 4, confirm_verdict: 'live' },
  ];
  assert.deepEqual(cheaperCleared(rows).map((r) => r.model_id), ['twice', 'cascade:live', 'never', 'old']);
});

test('the customer\'s own model thinking less, serving, counts as what is saved now, not as a saving still to find', () => {
  const ranked = [
    { model: 'x/ref', key: 'x/ref#lighter', savingShare: 0.4, chance: 0.6 },
    { model: 'y/cheap', savingShare: 0.5, chance: 0.5 },
  ];
  const w = worthOf({ ranked, refPer: 0.001, month: { calls: 1000, cost: 0 }, serving: 'x/ref', servingAs: 'x/ref#lighter', tries: 5, fee: 0 });
  assert.ok(Math.abs(w.protectedMonthlyUsd - 0.4) < 1e-9, `what it saves now: ${w.protectedMonthlyUsd}`);
  // only the tenth beyond what serves, half the time
  assert.ok(Math.abs(w.expectedMonthlyUsd - 0.05) < 1e-9, `${w.expectedMonthlyUsd}`);
  // a plain model serving is found as before
  const plain = worthOf({ ranked, refPer: 0.001, month: { calls: 1000, cost: 0 }, serving: 'y/cheap', servingAs: 'y/cheap', tries: 5, fee: 0 });
  assert.ok(Math.abs(plain.protectedMonthlyUsd - 0.5) < 1e-9);
  assert.equal(plain.expectedMonthlyUsd, 0);
});

/* The customer's model, which thinks by default and is sold by two providers, one at a quarter of the price. */
const ep = (over) => ({ tag: 'p', provider: 'P', price_in: 2e-6, price_out: 8e-6, overrides: null, status: 0, uptime_1d: 100, uptime_30m: 100, ...over });
const refModel = {
  id: 'x/ref', name: 'ref', priceIn: 2e-6, priceOut: 8e-6, overrides: null, params: null, inputs: ['text'], contextLen: 128000,
  maxOutput: 16000, reasoning: { default_enabled: true, supported_efforts: ['low', 'medium'], default_effort: 'medium' }, expiresAt: null,
  endpoints: [ep({ tag: 'cheap', provider: 'Cheap', price_in: 0.5e-6, price_out: 2e-6 }), ep({ tag: 'full', provider: 'Full' })],
};
const profile = { tools: false, toolChoice: false, json: 'none', images: false, outCap: null, promptAvg: 100, promptMax: 200,
  outAvg: 50, outP50: 50, outP95: 90, hours: null, streamed: false };
const base = { facts: { models: new Map([['x/ref', refModel]]), zdrKnown: true }, profile, reference: 'x/ref', enabled: new Set(),
  want: 3, config, at: Date.now(), zdrOnly: false, refThinks: true };

test('what serves goes first by its own name, and the fixed guesses carry no raw chance', () => {
  const sel = selectCandidates({ ...base, serving: 'x/ref', servingAs: 'x/ref#cheapest', servingRecipe: { providers: ['cheap'], pinned: true } });
  // both are the customer's model by name, and both used to be put first as the one serving, the other one ahead
  assert.equal(sel.order[0].key, 'x/ref#cheapest');
  assert.equal(sel.order[1].key, 'x/ref#lighter');
  const cheapest = sel.order[0];
  assert.equal(cheapest.rawChance, null, 'eight in ten is a guess, not a reading of any evidence');
  assert.deepEqual(cheapest.recipe, { providers: ['cheap'], pinned: true });
});

test('what serves is always checked again, even when the customer\'s model no longer reads as thinking', () => {
  const sel = selectCandidates({ ...base, refThinks: false, serving: 'x/ref', servingAs: 'x/ref#lighter', servingRecipe: { reasoning: { effort: 'low' } } });
  const lighter = sel.order.find((r) => r.key === 'x/ref#lighter');
  assert.ok(lighter, 'what serves is measured again');
  assert.deepEqual(lighter.recipe, { reasoning: { effort: 'low' } }, 'as it is served');
  // and nobody else thinking less is offered for a model that does not think
  assert.equal(selectCandidates({ ...base, refThinks: false }).order.some((r) => r.key === 'x/ref#lighter'), false);
  // the provider serving it now is re-checked there, even once another has become cheaper
  const pinned = selectCandidates({ ...base, serving: 'x/ref', servingAs: 'x/ref#cheapest', servingRecipe: { providers: ['full'], pinned: true } });
  assert.deepEqual(pinned.order[0].recipe, { providers: ['full'], pinned: true });
});

test('a judgement is priced at what it costs: two calls for a candidate without Jev, the language model for "at least as good"', () => {
  const llm = { priceIn: 1e-6, priceOut: 2e-6 };
  const p = judgePrices(800, 60, llm);
  // instructions, the request, and both answers, and a word back
  const pair = 1e-6 * (200 + 800 + 2 * 60) + 2e-6 * 6;
  assert.ok(Math.abs(p.bar - pair) < 1e-12, `${p.bar}`);
  assert.ok(Math.abs(p.candidate - 2 * pair) < 1e-12, `${p.candidate}`);
  // "at least as good" is read both ways round, so a judgement is two calls
  assert.ok(Math.abs(p.quality - 2 * pair) < 1e-12, `${p.quality}`);
  assert.ok(Math.abs(p.llmQuality - 2 * pair) < 1e-12, `${p.llmQuality}`);
  // an answer put into another language for a planted check, and the instruction read once as a checklist
  assert.ok(Math.abs(p.translate - (1e-6 * (80 + 60) + 2e-6 * (60 + 50))) < 1e-12, `${p.translate}`);
  assert.ok(Math.abs(p.checklist - (1e-6 * (500 + 800) + 2e-6 * 300)) < 1e-12, `${p.checklist}`);
  // long requests and answers are cut the way the judges cut them
  const long = judgePrices(50000, 9000, llm);
  assert.ok(Math.abs(long.bar - (1e-6 * (200 + 1000 + 2000) + 2e-6 * 6)) < 1e-12);
});
