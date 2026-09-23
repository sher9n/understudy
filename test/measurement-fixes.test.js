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
