// Which test files each of the GitHub check's machines runs (.github/workflows/test.yml), so the suite takes as long as
// its slowest machine rather than as long as all its files one after another. Every file in test/ goes to exactly one
// machine: the slowest first, each to the machine with the least to do so far, by how long it took the last time it was
// measured on its own (test/times.json, seconds). A file not measured yet counts as long as the slowest that was, so a new
// file is never assumed quick, and the check says which ones to measure.
//   node scripts/test-shard.mjs <machine, from 1> <machines>   the files that machine runs, one a line
//   node scripts/test-shard.mjs --measure                      runs each file on its own and writes test/times.json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMES = path.join(ROOT, 'test', 'times.json');
const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();

if (process.argv[2] === '--measure') {
  const times = {};
  let failed = 0;
  for (const f of files) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `test/${f}`], { cwd: ROOT, stdio: 'ignore' });
    times[f] = Math.round((Date.now() - t0) / 100) / 10;
    if (r.status !== 0) failed += 1;
    console.log(`${times[f].toFixed(1).padStart(7)}s ${r.status === 0 ? '' : 'FAILED '}${f}`);
  }
  fs.writeFileSync(TIMES, `${JSON.stringify(times, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, TIMES)}${failed ? `; ${failed} failed, so their times may be short` : ''}`);
  process.exit(failed ? 1 : 0);
}

const machine = Number(process.argv[2]);
const machines = Number(process.argv[3]);
if (!Number.isInteger(machines) || machines < 1 || !Number.isInteger(machine) || machine < 1 || machine > machines) {
  console.error('usage: node scripts/test-shard.mjs <machine, from 1> <machines>, or --measure');
  process.exit(2);
}
let times = {};
try { times = JSON.parse(fs.readFileSync(TIMES, 'utf8')); } catch { times = {}; }
const measured = Object.values(times).filter((s) => Number.isFinite(s));
const longest = measured.length ? Math.max(...measured) : 1;
const unmeasured = files.filter((f) => !Number.isFinite(times[f]));
const weight = (f) => (Number.isFinite(times[f]) ? times[f] : longest);

const load = Array(machines).fill(0);
const share = Array.from({ length: machines }, () => []);
for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
  const m = load.indexOf(Math.min(...load));
  share[m].push(f);
  load[m] += weight(f);
}
const dealt = share.flat();
if (dealt.length !== files.length || new Set(dealt).size !== files.length) {
  console.error(`dealt ${dealt.length} files for ${files.length}`);
  process.exit(1);
}
if (unmeasured.length && process.env.GITHUB_ACTIONS) {
  console.error(`::notice::Not measured yet, so counted as the slowest: ${unmeasured.join(', ')}. `
    + 'Run node scripts/test-shard.mjs --measure and commit test/times.json.');
}
console.error(`machine ${machine} of ${machines}: ${share[machine - 1].length} files, about ${Math.round(load[machine - 1])}s `
  + `(the machines: ${load.map((s) => Math.round(s)).join(', ')}s)`);
for (const f of share[machine - 1].sort()) console.log(`test/${f}`);
