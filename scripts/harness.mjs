// How often are we wrong? Prints the false-clear, false-promote and false-revert rates of the
// product's own decision rules over made-up workloads with known truths, which setup each routing
// priority switches to, and how routing by kind of request does. A minute or two, no model calls.
//   node scripts/harness.mjs
import { verdictSim, learnRates, choiceSim, routerSim, REQUEST_KINDS as K } from '../src/eval/harness.js';

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

const u = (rng, a, b) => a + (b - a) * rng();
console.log('\nCHOOSING: which of the setups that cleared is switched to, by routing priority (3000 workloads each)');
const MODES = [
  ['cheapest first, one second look less (the old rule)', { mode: 'savings', tries: 2 }],
  ['most savings', { mode: 'savings', tries: 3 }],
  ['balanced', { mode: 'balanced', tries: 3 }],
  ['cautious', { mode: 'cautious', tries: 3 }],
];
const CHOICES = [
  ['eight setups, pass mark 3%', { floorPct: 3, setups: (rng) => Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, rate: u(rng, 0, 0.06), ratio: u(rng, 0.03, 0.6), p50: u(rng, 0.3, 2) })) }],
  ['eight setups, pass mark 8%', { floorPct: 8, setups: (rng) => Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, rate: u(rng, 0, 0.16), ratio: u(rng, 0.03, 0.6), p50: u(rng, 0.3, 2) })) }],
  ['a near tie, one much faster', { floorPct: 3, best: () => 'fast', setups: () => [
    { id: 'slow', rate: 0.001, ratio: 0.2, p50: 1.8 }, { id: 'fast', rate: 0.001, ratio: 0.206, p50: 0.5 },
    { id: 'bad', rate: 0.06, ratio: 0.05, p50: 0.6 }, { id: 'dear', rate: 0.005, ratio: 0.4, p50: 0.9 }] }],
  ['ten a quarter past the mark, one good', { floorPct: 3, best: () => 'good', setups: (rng) => [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `edge${i}`, rate: 0.0375, ratio: u(rng, 0.03, 0.15), p50: 1 })),
    { id: 'good', rate: 0.002, ratio: 0.3, p50: 1 }] }],
];
for (const [name, s] of CHOICES) {
  console.log(`  ${name}`);
  const rows = [...MODES, ...(s.best && s.best() === 'good' ? [['tested once, no second look', { mode: 'savings', secondLook: false }]] : [])];
  for (const [label, m] of rows) {
    const r = choiceSim({ ...s, ...m, trials: 3000, seed: 11 });
    console.log(`    ${label.padEnd(52)} switched ${pct(r.switched)}  past the mark ${pct(r.broken)}  saving ${pct(r.saving)}  speed ${r.speed === null ? '-' : r.speed.toFixed(2)}${r.right === null ? '' : `  the right one ${pct(r.right)}`}`);
  }
}

console.log('\nROUTING BY KIND OF REQUEST: learned, cross-fitted, looked at twice, judged on the truth (40 workloads each)');
const ROUTERS = [
  ['cheap model wrong on refunds only', { kinds: [{ make: K.order, share: 0.6 }, { make: K.refund, share: 0.4 }], options: [{ ratio: 0.05, rates: [0, 0.35] }, { ratio: 0.3, rates: [0, 0.01] }] }],
  ['three kinds, two cheaper models', { kinds: [{ make: K.order, share: 0.5 }, { make: K.address, share: 0.2 }, { make: K.refund, share: 0.3 }], options: [{ ratio: 0.04, rates: [0, 0.2, 0.4] }, { ratio: 0.25, rates: [0, 0, 0.15] }] }],
  ['mistakes on every kind alike, mark 5%', { floorPct: 5, refNoise: 0.03, kinds: [{ make: K.order, share: 0.5 }, { make: K.refund, share: 0.5 }], options: [{ ratio: 0.05, rates: [0.07, 0.07] }] }],
  ['every request reads alike', { kinds: [{ make: K.document, share: 1 }], options: [{ ratio: 0.05, rates: [0.02] }] }],
];
for (const [name, s] of ROUTERS) {
  const r = routerSim({ ...s, trials: 40, seed: 31 });
  const line = (x) => `switched ${pct(x.switched)}  past the mark ${pct(x.broken)}  hiding a worse model ${pct(x.diluted)}  saving ${x.saving === null ? '-' : pct(x.saving)}`;
  console.log(`  ${name}: formed ${pct(r.formed)}`);
  console.log(`    with the kinds check:  ${line(r.withCheck)}`);
  console.log(`    without it:            ${line(r.without)}`);
}
