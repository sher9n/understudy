import test from 'node:test';
import assert from 'node:assert/strict';
import { perCall, withFeeOn, callsPerMonth, projectSavings, cheaperPct } from '../src/eval/savings.js';

/* The switched card's arithmetic, checked by hand. Prices are per token, as the catalogue
   keeps them: $2.50 and $15 per million for the original, $0.02 and $0.04 for the new one. */
const ORIGINAL = { price_in: 2.5e-6, price_out: 15e-6 };
const CHEAPER = { price_in: 0.02e-6, price_out: 0.04e-6 };
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('a call is priced from its own tokens at each model\'s prices', () => {
  // 800 tokens in and 60 out: 800 x 2.5e-6 + 60 x 15e-6
  close(perCall(ORIGINAL, { prompt: 800, completion: 60 }), 0.0029);
  close(perCall(CHEAPER, { prompt: 800, completion: 60 }), 0.0000184);
  assert.equal(perCall(null, { prompt: 800, completion: 60 }), null, 'a model with no price is not priced at zero');
});

test('our fee lands on the model we route to, and only there', () => {
  close(withFeeOn(0.0000184, 1), 0.000018584);
  assert.equal(withFeeOn(null, 1), null);
});

test('a young workload is projected from the days it has been seen, not from thirty', () => {
  assert.equal(callsPerMonth(40, 2), 600, 'forty calls in two days is six hundred a month');
  assert.equal(callsPerMonth(300, 30), 300);
  assert.equal(callsPerMonth(300, 90), 300, 'the window never runs longer than thirty days');
  assert.equal(callsPerMonth(5, 0.1), 150, 'less than a day counts as a day');
  assert.equal(callsPerMonth(0, 12), 0);
});

test('the saving over time is the difference, month by month, at a steady volume', () => {
  const rows = projectSavings({ fromPerCall: 0.0029, toPerCall: 0.000018584, monthly: 1000 });
  assert.deepEqual(rows.map((r) => r.months), [1, 3, 6, 12]);
  close(rows[0].from, 2.9, 1e-8);
  close(rows[0].to, 0.018584, 1e-8);
  close(rows[0].saved, 2.881416, 1e-8);
  close(rows[3].saved, rows[0].saved * 12, 1e-6);
  assert.deepEqual(projectSavings({ fromPerCall: null, toPerCall: 0.1, monthly: 10 }), [],
    'nothing is projected for a model that cannot be priced');
});

test('a switch that costs more says so, rather than showing a negative saving as a saving', () => {
  const [month] = projectSavings({ fromPerCall: 0.001, toPerCall: 0.0012, monthly: 100 });
  assert.ok(month.saved < 0);
  assert.ok(cheaperPct(0.001, 0.0012) < 0);
  close(cheaperPct(0.0029, 0.000018584), 99.35917241379311, 1e-9);
  assert.equal(cheaperPct(0, 0.1), null);
});
