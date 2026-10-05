// Which test files each of the GitHub check's machines runs (.github/workflows/test.yml), so the suite takes as long as
// its slowest machine rather than as long as all its files one after another. Every file in test/ goes to exactly one
// machine: the slowest first, each to the machine with the least to do so far, by how long it took on GitHub's machines
// (test/times.json, seconds), which are slower than a laptop and not by the same factor for every file. A file with no
// time yet counts as long as the slowest, so a new file is never assumed quick, and the check says which ones they are.
//   node scripts/test-shard.mjs <machine, from 1> <machines>         the files that machine runs, one a line
//   node scripts/test-shard.mjs --run <machine, from 1> <machines>   runs them one at a time and says how long each took
//   node scripts/test-shard.mjs --from-run <GitHub run id>           rewrites test/times.json from what that run took
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMES = path.join(ROOT, 'test', 'times.json');
const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
const readTimes = () => {
  try { return JSON.parse(fs.readFileSync(TIMES, 'utf8')); } catch { return {}; }
};
// how --run says what a file took, which --from-run reads back out of the run's logs
const TOOK = /took ([\d.]+)s (passed|FAILED) test\/(\S+\.test\.js)/;

if (process.argv[2] === '--from-run') {
  const run = process.argv[3];
  if (!/^\d+$/.test(run || '')) {
    console.error('usage: node scripts/test-shard.mjs --from-run <GitHub run id>');
    process.exit(2);
  }
  const gh = (route) => execFileSync('gh', ['api', route], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const jobs = JSON.parse(gh(`repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`)).jobs
    .filter((j) => j.name.startsWith('suite'));
  const times = readTimes();
  const took = {};
  for (const job of jobs) {
    for (const line of gh(`repos/{owner}/{repo}/actions/jobs/${job.id}/logs`).split('\n')) {
      const m = TOOK.exec(line);
      // a file that failed may have stopped early, so its time says nothing
      if (m && m[2] === 'passed') took[m[3]] = Number(m[1]);
    }
  }
  const next = {};
  for (const f of files) if (Number.isFinite(took[f] ?? times[f])) next[f] = took[f] ?? times[f];
  fs.writeFileSync(TIMES, `${JSON.stringify(next, null, 1)}\n`);
  const kept = files.filter((f) => !(f in took) && f in next);
  console.log(`wrote ${path.relative(ROOT, TIMES)}: ${Object.keys(took).length} files from run ${run} (${jobs.length} machines)`
    + (kept.length ? `; kept the old time of ${kept.join(', ')}` : ''));
  process.exit(0);
}

const running = process.argv[2] === '--run';
const [machine, machines] = process.argv.slice(running ? 3 : 2).map(Number);
if (!Number.isInteger(machines) || machines < 1 || !Number.isInteger(machine) || machine < 1 || machine > machines) {
  console.error('usage: node scripts/test-shard.mjs [--run] <machine, from 1> <machines>, or --from-run <GitHub run id>');
  process.exit(2);
}
const times = readTimes();
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
  console.error(`::notice::No time yet for ${unmeasured.join(', ')}, so counted as the slowest. Once this run is green, `
    + `node scripts/test-shard.mjs --from-run ${process.env.GITHUB_RUN_ID || '<run id>'} and commit test/times.json.`);
}
const mine = share[machine - 1].sort();
console.error(`machine ${machine} of ${machines}: ${mine.length} files, about ${Math.round(load[machine - 1])}s `
  + `(the machines: ${load.map((s) => Math.round(s)).join(', ')}s)`);
if (!running) {
  for (const f of mine) console.log(`test/${f}`);
  process.exit(0);
}

/* Each file in a run of its own, one after another, as `node --test --test-concurrency=1` with them all would, so what
   each took is known. Every file runs even when an earlier one failed, and the machine fails if any did. */
const took = [];
for (const f of mine) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `test/${f}`], { cwd: ROOT, stdio: 'inherit' });
  const s = Math.round((Date.now() - t0) / 100) / 10;
  took.push({ f, s, ok: r.status === 0 });
  console.log(`took ${s.toFixed(1)}s ${r.status === 0 ? 'passed' : 'FAILED'} test/${f}`);
}
const failed = took.filter((t) => !t.ok);
const lines = took.map((t) => `- ${t.s.toFixed(1)} s, ${t.ok ? 'passed' : '**failed**'}: test/${t.f}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Machine ${machine} of ${machines}\n\n${lines.join('\n')}\n\n`);
}
console.log(`\n${lines.join('\n')}`);
if (failed.length) {
  console.log(`\nfailed: ${failed.map((t) => `test/${t.f}`).join(' ')}`);
  process.exit(1);
}
