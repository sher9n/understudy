// How often are we wrong? Prints the false-clear, false-promote and false-revert rates of the
// product's own decision rules over made-up workloads with known truths. Seconds, no model calls.
//   node scripts/harness.mjs
import { verdictSim, learnRates } from '../src/eval/harness.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log('VERDICTS: a candidate measured on n calls against a bar, with the old point rule and the new interval rule');
for (const floorPct of [3.75, 8]) {
  for (const n of [10, 40, 80, 120]) {
    for (const gap of [0, floorPct / 200, floorPct / 100, floorPct * 2 / 100]) {
      const r = verdictSim({ gap, n, floorPct });
      const line = (v) => `cleared ${pct(v.cleared)}, review ${pct(v.review)}, missed ${pct(v.missed)}, not enough ${pct(v.insufficient)}`;
      console.log(`  bar ${floorPct}%  n ${String(n).padStart(3)}  true gap ${(gap * 100).toFixed(2)}%`);
      console.log(`      old:  ${line(r.pointEstimate)}`);
      console.log(`      new:  ${line(r.withIntervals)}`);
    }
  }
}
console.log('\nLEARNING: a switched workload reviewed every hour for 30 days (200 runs each)');
const cases = [
  ['equal, no runner', { rates: { base: 0.97, serving: 0.97, runner: null } }],
  ['equal, equal runner', { rates: { base: 0.97, serving: 0.97, runner: 0.97 } }],
  ['serving 2 points worse', { rates: { base: 0.97, serving: 0.95, runner: null } }],
  ['serving 5 points worse', { rates: { base: 0.97, serving: 0.92, runner: null } }],
  ['runner 3 points worse', { rates: { base: 0.97, serving: 0.97, runner: 0.94 } }],
  ['equal, budget pauses at 6h', { rates: { base: 0.97, serving: 0.97, runner: 0.97 }, budgetHours: 6 }],
  ['equal, only 1 in 10 outcomes seen', { rates: { base: 0.97, serving: 0.97, runner: 0.97 }, detection: 0.1 }],
  ['runner 5 points worse, 1 in 10 seen', { rates: { base: 0.97, serving: 0.97, runner: 0.92 }, detection: 0.1 }],
];
for (const volume of [100, 1000]) {
  for (const share of [0.02, 0.05]) {
    console.log(`  volume ${volume} calls a day, share ${pct(share)}`);
    for (const [name, p] of cases) {
      const r = learnRates({ volume, share, ...p });
      console.log(`    ${name.padEnd(38)} promote ${pct(r.promote)}  revert ${pct(r.revert)}  rest ${pct(r.rest)}  nothing ${pct(r.nothing)}  mean day ${r.meanDay === null ? '-' : r.meanDay.toFixed(1)}`);
    }
  }
}
