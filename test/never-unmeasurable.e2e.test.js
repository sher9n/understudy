/* A written workload is always measured, end to end: a provider, a Jev and a language-model judge we control, a
   real database, the real measurement.

   On 24 Sep a workload of written answers ended "could not measure": its judge, asked once with the two answers in a
   random order, leaned towards whichever it read first, put the customer's own model clearly worse than itself on 47%
   of calls, and the measurement gave up at 40%. What is checked here:
   - read both ways round, a judge that leans on the order of the answers sees no difference where there is none, and
     the workload is measured (A);
   - the bar is the customer's model against itself plus a margin, with no rate past which it gives up, so even a model
     clearly worse than itself on half its calls gets a bar and a measurement (B);
   - the judge is chosen on answers planted as clearly worse, the language model where Jev misses one, and where both
     miss, nothing switches on their word alone (B);
   - the workload's own instruction is read once as a checklist, and an answer that breaks it where the customer's
     keeps it is worse whatever a reading says: in code for a count or a sign-off, by Jev for what only a reader can
     tell (C);
   - a structured workload whose model disagrees with itself is held to "at least as good" too;
   - and what must NOT change: a workload whose model agrees with itself stays on "the same answer" and pays for no
     checklist, translation or planted reading; a judge that does not answer interrupts the measurement to try again
     rather than ending it unmeasurable; the daily checks read answers as the measurement did; and the page says how
     each was judged and draws a measurement that compared nothing. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4893;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_measurable_${process.pid}`;
const adminUrl = new URL(ADMIN);
adminUrl.pathname = '/postgres';
{
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
}
const testUrl = new URL(ADMIN);
testUrl.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = testUrl.toString();
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.JEV_VIA = 'typesafe';
process.env.TYPESAFE_API_KEY = 'test-typesafe';
process.env.TYPESAFE_BASE = `http://127.0.0.1:${PORT}/typesafe`;
process.env.MODEL_MIN_GAP_MS = '0';
process.env.EVAL_MAX_USD_PER_RUN = '100';
process.env.JOBS_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';
process.env.SPEED_SLACK_MS = '5000';
process.env.REQUEST_LOGS = 'false';
process.env.EVAL_JUDGE_MODEL = 'judge/small';
process.env.ROLLOUT_ENABLED = 'false';
process.env.RESEND_API_KEY = '';
process.env.MEASURE_READY_CHECK_MS = '0';

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { move } = await import('../src/billing.js');
const { judgeQuality } = await import('../src/eval/judge.js');
const { barOf, scoreServed, forgetBar } = await import('../src/learn/control.js');
const { maybeShadow, stateOf } = await import('../src/learn/explore.js');
const { askOf } = await import('../src/eval/ask.js');
const { keptChecklist } = await import('../src/eval/checklist.js');
const { runPageOf, pageOf } = await import('../src/workloadPage.js');

await migrate({ quiet: true });

const DAY = 86400000;
const REF = 'openai/gpt-5.4';
const SIGN = '- Acme Poems';
const INSTRUCTION = `You are the poet for Acme. Write at most 60 words about what you are asked, and always end with the line: ${SIGN}`;
const VOCAB = ['the', 'sea', 'waves', 'light', 'blue', 'night', 'and', 'of', 'wind', 'stars', 'home', 'shore', 'salt', 'grey', 'dawn', 'song'];
const INLAND = ['the', 'hills', 'fields', 'light', 'green', 'night', 'and', 'of', 'wind', 'stars', 'home', 'road', 'stone', 'grey', 'dawn', 'song'];
const DE = { the: 'die', sea: 'meer', waves: 'wellen', light: 'licht', blue: 'blau', night: 'nacht', and: 'und', of: 'von', wind: 'wind',
  stars: 'sterne', home: 'heim', shore: 'ufer', salt: 'salz', grey: 'grau', dawn: 'morgen', song: 'lied' };
/* A poem of `n` words, a different one for every seed, signed as the instruction asks unless told not to be. One about
   the sea opens with it, as a poem asked to be about the sea does. */
const poem = (n, seed, { signed = true, vocab = VOCAB } = {}) => {
  const words = Array.from({ length: n }, (_, k) => vocab[(seed * 7 + k * 5 + Math.floor(k / 3)) % vocab.length]);
  if (vocab === VOCAB) words.splice(0, 2, 'the', 'sea');
  return `${words.join(' ')}${signed ? `\n${SIGN}` : ''}`;
};
const wordCount = (t) => String(t).split(/\s+/).filter(Boolean).length;

/* A competent reader's faults in an answer: the sign-off or the length the instruction asks for, the wrong language,
   too short to be the poem asked for. */
function faults(request, text) {
  const t = String(text);
  let n = 0;
  const poemAsked = String(request).includes('Acme Poems');
  if (poemAsked && !t.includes(SIGN)) n += 1;
  if (poemAsked && wordCount(t) > 63) n += 1;
  if (/\b(meer|wellen|und|die|nacht)\b/.test(t)) n += 1;
  if (poemAsked && wordCount(t) < 20) n += 1;
  // an invoice's total is 100 more than its number: another invoice's answer is wrong about this one
  const invoice = String(request).match(/Invoice #(\d+)/);
  const total = t.match(/"total":\s*(\d+)/);
  if (invoice && total && Number(total[1]) !== 100 + Number(invoice[1])) n += 1;
  return n;
}
/* How a judge picks between two answers: the one with fewer faults. Where they have as many, a fair judge says they
   are equal, one that leans says the first, whichever that is; a blind one says equal to everything; one that sees
   only length counts nothing but a poem too short, and leans. */
const mode = { jev: 'fair', llm: 'fair' };
function pick(how, request, first, second) {
  if (how === 'blind') return 'equal';
  const seen = how === 'lengthonly' ? (t) => (String(request).includes('Acme Poems') && wordCount(t) < 20 ? 1 : 0) : (t) => faults(request, t);
  const a = seen(first);
  const b = seen(second);
  if (a < b) return 'first';
  if (b < a) return 'second';
  return how === 'leans' || how === 'lengthonly' ? 'first' : 'equal';
}

/* What the reference model does now: a good poem every time; 'wobbly', a short one on every other replay; 'worse-today',
   a short one on every replay, against the good ones it gave the customer (recorded). */
let refMode = 'steady';
let wobble = 0;
const counts = { extract: 0, translate: 0, llmQuality: 0, jevBetter: 0, jevNeeds: 0 };
let seedCounter = 0;
const nextSeed = () => { seedCounter += 1; return seedCounter * 13 + 5; };
const BEHAVIOUR = {
  [REF]: () => {
    wobble += 1;
    if (refMode === 'worse-today' || (refMode === 'wobbly' && wobble % 2 === 0)) return poem(8, nextSeed());
    return poem(40, nextSeed());
  },
  'vendor/good-poet': () => poem(40, nextSeed()),
  'vendor/nosign-poet': () => poem(40, nextSeed(), { signed: false }),
  'vendor/short-poet': () => poem(10, nextSeed()),
  'vendor/landlocked-poet': () => poem(40, nextSeed(), { vocab: INLAND }),
};
const categories = ['travel', 'food', 'office'];
/* 'slips', the customer's model gives another currency on one answer in forty it gives again: a field it still gives the
   same way on nearly every call */
let refJson = 0;
const JSONS = {
  [REF]: (i) => JSON.stringify({ category: categories[nextSeed() % 3], total: 100 + i,
    currency: refMode === 'slips' && (refJson += 1) % 40 === 0 ? 'USD' : 'EUR' }),
  'vendor/good-json': (i) => JSON.stringify({ category: categories[nextSeed() % 3], total: 100 + i, currency: 'EUR' }),
  'vendor/broken-json': () => '{"category": "travel", "total": ',
  /* right on everything the judge looks at, and on every third invoice the wrong currency: a field the customer's model
     gives the same way every time, which no judge here reads */
  'vendor/slip-json': (i) => JSON.stringify({ category: categories[nextSeed() % 3], total: 100 + i, currency: i % 3 === 0 ? 'USD' : 'EUR' }),
};
const ECHO = { [REF]: (i) => `The answer to request ${i} is ${i * 2}.`, 'vendor/echo': (i) => `The answer to request ${i} is ${i * 2}.` };

const fenced = (text, label) => (String(text).match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const p = JSON.parse(raw || '{}');
    // Jev
    if (req.url.endsWith('/systemone')) {
      const q = p.questions || {};
      const s = p.state || {};
      const answers = {};
      if (mode.jev === 'malformed') return json(res, 200, { model: 'typesafe/jev', answers: {}, usage: { input_tokens: 300 } });
      for (const [k, v] of Object.entries(q)) {
        if (k === 'better') {
          counts.jevBetter += 1;
          const c = pick(mode.jev, s.request, s.answers?.first, s.answers?.second);
          answers.better = { choice: c, confidence: 0.9, probabilities: { first: c === 'first' ? 0.9 : 0.05, second: c === 'second' ? 0.9 : 0.05, equal: c === 'equal' ? 0.9 : 0.05 } };
        } else if (/^need\d+[ab]$/.test(k)) {
          counts.jevNeeds += 1;
          const text = k.endsWith('a') ? s.answers?.first : s.answers?.second;
          const wants = /sea/i.test(v.instructions) ? /\bsea\b/.test(String(text)) : true;
          answers[k] = { noul: mode.jev === 'blind' || mode.jev === 'lengthonly' ? 0.5 : wants ? 0.95 : 0.05 };
        } else if (/^same\d?$/.test(k)) {
          const xs = Object.values(s.answers || {});
          answers[k] = { noul: xs.length >= 2 && String(xs[0]).trim() === String(xs[1]).trim() ? 0.95 : 0.05 };
        } else if (k === 'refuses' || k === 'cut') answers[k] = { noul: 0.02 };
        else if (k === 'kind' || k === 'kind1') answers[k] = { choice: 'wording', confidence: 0.8 };
        else if (k === 'check') answers.check = { choice: 'fine', confidence: 0.9, probabilities: { fine: 0.9, doubtful: 0.08, fails: 0.02 } };
        else answers[k] = { score: 2, confidence: 0.8, legend: {} };
      }
      return json(res, 200, { model: 'typesafe/jev', answers, usage: { input_tokens: 300 } });
    }
    const model = p.model;
    const sys = String(p.messages?.find((m) => m.role === 'system')?.content || '');
    const user = String(p.messages?.find((m) => m.role === 'user')?.content || '');
    const send = (content, cost = 0.0002) => json(res, 200, { id: `gen-${Math.random().toString(36).slice(2)}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 600, completion_tokens: 60, cost } });
    // the language-model judge, the checklist reader and the translator
    if (model === 'judge/small') {
      if (sys.includes('say which one serves')) {
        counts.llmQuality += 1;
        if (mode.llm === 'down') return json(res, 400, { error: { message: 'judge unavailable' } });
        const c = pick(mode.llm, fenced(user, 'REQUEST'), fenced(user, 'FIRST'), fenced(user, 'SECOND'));
        return send(c === 'first' ? 'FIRST' : c === 'second' ? 'SECOND' : 'TIE', 0.00005);
      }
      if (sys.includes('list the requirements')) {
        counts.extract += 1;
        const items = user.includes('Acme Poems')
          ? [{ kind: 'max_words', n: 60, say: 'At most 60 words' }, { kind: 'includes', text: SIGN, say: 'Ends with the Acme Poems line' },
            { kind: 'ask', say: 'About the sea' }]
          : [];
        return send(JSON.stringify({ items }), 0.0003);
      }
      if (sys.includes('Translate the text')) {
        counts.translate += 1;
        return send(user.split(/(\s+)/).map((w) => DE[w] ?? w).join('').replace(SIGN, '- Acme Gedichte'), 0.0003);
      }
      // the agreement judge: the same only when it is the same text
      const a = fenced(user, 'A');
      const b = fenced(user, 'B');
      return send(a.trim() === b.trim() ? 'SAME' : 'DIFFERENT', 0.00005);
    }
    const i = Number((user.match(/#(\d+)/) || [])[1] || 0);
    if (user.startsWith('Write a poem')) return send((BEHAVIOUR[model] || (() => 'no poem'))(i), model === REF ? 0.002 : 0.0002);
    if (user.startsWith('Invoice')) return send((JSONS[model] || (() => '{}'))(i), model === REF ? 0.002 : 0.0002);
    return send((ECHO[model] || (() => 'nothing'))(i), model === REF ? 0.002 : 0.0002);
  });
});

const CANDIDATES = ['vendor/good-poet', 'vendor/nosign-poet', 'vendor/short-poet', 'vendor/landlocked-poet', 'vendor/good-json',
  'vendor/broken-json', 'vendor/slip-json', 'vendor/echo', 'judge/small'];

test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await saveCatalog([
    { model_id: REF, name: 'gpt-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    ...CANDIDATES.map((m) => ({ model_id: m, name: m.split('/')[1], context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6,
      open_weights: m === 'judge/small' ? 0 : 1, zdr: 1 })),
  ]);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

let seq = 0;
/** A workspace with one workload of `n` recorded calls: poems (the default), invoices read as JSON, or plain answers. */
async function seed({ n = 220, kind = 'poem', enabled = [], mode: optimize = 'auto', system = INSTRUCTION } = {}) {
  seq += 1;
  const { workspace } = await createAccount({ email: `measurable-${seq}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `m${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(optimize, workspace.id);
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const request = kind === 'json'
      ? { model: REF, messages: [{ role: 'system', content: 'Read the invoice and give its category and total as JSON.' }, { role: 'user', content: `Invoice #${i}` }],
        response_format: { type: 'json_object' } }
      : kind === 'echo'
        ? { model: REF, messages: [{ role: 'system', content: 'Answer with the figure asked for, in one sentence.' }, { role: 'user', content: `Double request #${i}` }] }
        : { model: REF, messages: [{ role: 'system', content: system }, { role: 'user', content: `Write a poem about the sea, #${i}` }] };
    const answer = kind === 'json' ? JSON.stringify({ category: categories[i % 3], total: 100 + i, currency: 'EUR' })
      : kind === 'echo' ? ECHO[REF](i) : poem(40, i);
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 600, completionTokens: 60, costUsd: 0.002, chargedUsd: 0,
      request, response: { choices: [{ message: { content: answer } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?')
    .run(now() - DAY, workload.id);
  for (const m of CANDIDATES) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, enabled.includes(m) ? 1 : 0, now());
  }
  return { workspace, workload: await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id) };
}
const runOf = (id) => db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id);
const resultOf = async (runId, model) => db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(runId, model);
const checkOf = (run) => JSON.parse(run.judge_check_json || 'null');
const judgedBy = async (runId, model) => (await db.prepare(
  'SELECT judged_by, COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND judged_by IS NOT NULL GROUP BY 1').all(runId, model))
  .reduce((a, r) => ({ ...a, [r.judged_by]: Number(r.n) }), {});
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

const poemRuns = {};

test('A: a judge that leans towards whichever answer it reads first no longer makes a written workload unmeasurable', async () => {
  mode.jev = 'leans';
  mode.llm = 'fair';
  refMode = 'steady';
  const { workload } = await seed({ enabled: ['vendor/good-poet', 'vendor/nosign-poet', 'vendor/short-poet', 'vendor/landlocked-poet'] });
  assert.equal(workload.shape_kind, 'free_text');
  // two equally good poems, read one way round, are one clearly better than the other; read both ways, a tie
  const one = poem(40, 1);
  const two = poem(40, 2);
  const j = await judgeQuality(`system: ${INSTRUCTION}\nuser: Write a poem about the sea, #1`, one, two, { scope: workload.workspace_id });
  assert.equal(j.score, 0);
  assert.equal(j.detail.split, true, 'each reading preferred whichever it read first');
  assert.deepEqual(j.detail.picks, ['first', 'first']);

  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  poemRuns.leans = { run, workload };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'quality');
  assert.ok(Number(run.noise_pct) < 10, `the customer's model against itself, read both ways: ${run.noise_pct}%`);
  assert.ok(near(run.floor_pct, Math.max(Number(run.noise_pct) + 5, 3)), `the bar is the noise plus five points: ${run.floor_pct} from ${run.noise_pct}`);
  const check = checkOf(run);
  assert.equal(check.judge, 'jev');
  assert.equal(check.errors, 0, JSON.stringify(check));
  assert.equal(check.prefer, null);
  for (const kind of ['spacing', 'cut', 'ignored instruction', 'wrong language']) assert.ok(check.kinds.includes(kind), `planted ${kind}: ${check.kinds}`);
  assert.ok(!check.kinds.includes('another request'), 'every request asks for the same poem, so another request\'s poem is as good an answer');
  // the instruction, read once as a checklist and kept
  const items = await keptChecklist(workload.id);
  assert.deepEqual(items.map((x) => x.kind), ['max_words', 'includes', 'ask']);
  const plan = JSON.parse(run.plan_json);
  assert.deepEqual(plan.yardstick.checklist, ['At most 60 words', 'Ends with the Acme Poems line', 'About the sea']);

  const good = await resultOf(out.runId, 'vendor/good-poet');
  assert.equal(good.verdict, 'cleared', `${good.gap_pct}% against ${run.floor_pct}%`);
  const nosign = await resultOf(out.runId, 'vendor/nosign-poet');
  assert.notEqual(nosign.verdict, 'cleared');
  assert.equal(nosign.difference, 'ignores your instruction');
  assert.ok((await judgedBy(out.runId, 'vendor/nosign-poet')).checklist > 0, 'the missing sign-off is found in code, whatever the reading says');
  const short = await resultOf(out.runId, 'vendor/short-poet');
  assert.notEqual(short.verdict, 'cleared');
  // no word of the sea: only a reader can say, and Jev is asked beside the comparison
  const inland = await resultOf(out.runId, 'vendor/landlocked-poet');
  assert.notEqual(inland.verdict, 'cleared', `${inland.gap_pct}%`);
  assert.ok((await judgedBy(out.runId, 'vendor/landlocked-poet'))['jev-quality+checklist'] > 0);
  // the one as good as the customer's own passed its second look too, and serves
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(workload.id)).routed_model, 'vendor/good-poet');

  // a second measurement reads the checklist it kept rather than paying to read the instruction again
  const before = counts.extract;
  const again = await runEvaluation(workload.id);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(counts.extract, before, 'the same instruction is read once');
});

test('B: the language model reads the run where the planted answers catch Jev out', async () => {
  mode.jev = 'lengthonly';
  mode.llm = 'fair';
  refMode = 'steady';
  const { workload } = await seed({ enabled: ['vendor/good-poet', 'vendor/short-poet'] });
  const llmBefore = counts.llmQuality;
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  poemRuns.llm = { run, workload };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  const check = checkOf(run);
  assert.equal(check.judge, 'llm', JSON.stringify(check));
  assert.equal(check.prefer, 'llm');
  assert.equal(check.errors, 0);
  const jev = check.tried.find((t) => t.judge === 'jev');
  assert.ok(jev && jev.errors > 0, `Jev, seeing only length, missed the translated and the repeated answers: ${JSON.stringify(check.tried)}`);
  assert.ok(counts.llmQuality > llmBefore);
  const good = await resultOf(out.runId, 'vendor/good-poet');
  assert.equal(good.verdict, 'cleared', `${good.gap_pct}% against ${run.floor_pct}%`);
  const short = await resultOf(out.runId, 'vendor/short-poet');
  assert.notEqual(short.verdict, 'cleared', 'the language model sees what Jev, reading blind, would have let through');
  // every reading of a candidate is the language model's, or the checklist's
  const by = await judgedBy(out.runId, 'vendor/short-poet');
  assert.ok(Object.keys(by).every((k) => k === 'llm-quality' || k === 'checklist' || k === 'same text'), JSON.stringify(by));
});

test('B: the daily checks read answers as the measurement did: its judge, and the instruction\'s checklist', async () => {
  const { workload } = poemRuns.llm;
  forgetBar(workload.id);
  const bar = await barOf(workload);
  assert.equal(bar.yardstick, 'quality');
  assert.equal(bar.prefer, 'llm');
  const checklist = await keptChecklist(workload.id);
  const body = { model: REF, messages: [{ role: 'system', content: INSTRUCTION }, { role: 'user', content: 'Write a poem about the sea, #7' }] };
  const asJson = (content) => ({ choices: [{ message: { content } }] });
  const unsigned = await scoreServed(body, asJson(poem(40, 3, { signed: false })), asJson(poem(40, 4)), 'free_text',
    { scope: workload.workspace_id, yardstick: 'quality', prefer: bar.prefer, checklist });
  assert.equal(unsigned.score, 1);
  assert.equal(unsigned.judgedBy, 'checklist');
  assert.equal(unsigned.kind, 'instruction');
  const llmBefore = counts.llmQuality;
  const fine = await scoreServed(body, asJson(poem(40, 5)), asJson(poem(40, 6)), 'free_text',
    { scope: workload.workspace_id, yardstick: 'quality', prefer: bar.prefer, checklist });
  assert.equal(fine.score, 0);
  assert.equal(fine.judgedBy, 'llm-quality', 'read by the judge the measurement chose');
  assert.equal(counts.llmQuality - llmBefore, 2, 'both ways round');
});

test('B: where neither judge gets the planted answers right, nothing switches on their word alone', async () => {
  mode.jev = 'lengthonly';
  mode.llm = 'blind';
  refMode = 'steady';
  const { workload } = await seed({ enabled: ['vendor/good-poet', 'vendor/short-poet'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  poemRuns.unsure = { run, workload };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  const check = checkOf(run);
  assert.equal(run.yardstick, 'quality');
  assert.ok(check.errors > 0, JSON.stringify(check));
  assert.equal(check.judge, 'jev', 'the one that missed fewer reads the run');
  assert.equal(check.tried.length, 2, 'both were tried');
  // the short poems are seen; the one as good as the customer's is kept for a person to look at, never switched to
  const short = await resultOf(out.runId, 'vendor/short-poet');
  assert.notEqual(short.verdict, 'cleared');
  const good = await resultOf(out.runId, 'vendor/good-poet');
  assert.equal(good.verdict, 'review');
  // nor a strategy built on it: its scores are the same judge's readings (a cascade over it cleared, and could have been switched to)
  const clearedRows = await db.prepare(`SELECT model_id FROM eval_results WHERE run_id = ? AND verdict = 'cleared'`).all(out.runId);
  assert.deepEqual(clearedRows, [], `nothing clears on an unsure judge's word: ${JSON.stringify(clearedRows)}`);
  assert.equal((await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(workload.id)).routed_model, null);
  const page = await runPageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id), run);
  const row = page.cands.find((c) => c.key === 'vendor/good-poet');
  assert.equal(row.verdict, 'Passed, judge unsure');
  assert.match(page.take, /^good-poet stayed within the allowed difference as the judge read it: clearly worse on /,
    JSON.stringify(page.cands.map((c) => [c.key, c.kind, c.verdict, c.tone])));
  assert.match(page.take, /The judge was first tested on \d+ answers whose right verdict is already known, and it got \d+ wrong, so nothing is switched on its word\. The next test checks the judge again\.$/);
  const line = (await pageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id))).measurements.find((r) => r.id === run.id);
  assert.equal(line.tag.text, 'Passed, judge unsure', 'the line in the list says what the setup\'s own row says');
});

for (const [how, words] of [['wobbly', 'clearly worse than itself on half its calls'], ['worse-today', 'clearly worse today than the answers it gave, on every call']]) {
  test(`B: a customer's model ${words} still gets a bar, and a measurement that passes only what is as good`, async () => {
    mode.jev = 'fair';
    mode.llm = 'fair';
    refMode = how;
    try {
      const { workload } = await seed({ enabled: ['vendor/good-poet', 'vendor/short-poet'] });
      const out = await runEvaluation(workload.id);
      assert.equal(out.ok, true, JSON.stringify(out));
      const run = await runOf(out.runId);
      assert.equal(run.outcome, 'compared', `the old measurement gave up here: ${run.outcome}, ${run.error}`);
      assert.equal(run.yardstick, 'quality');
      assert.ok(Number(run.noise_pct) > 40, `clearly worse than itself on ${run.noise_pct}% of calls`);
      // the noise plus five points, and never past half plus five, where a setup worse on every call would pass
      assert.ok(near(run.floor_pct, Math.min(Number(run.noise_pct) + 5, 55)), `${run.floor_pct} from ${run.noise_pct}`);
      if (how === 'worse-today') assert.ok(near(run.floor_pct, 55));
      const good = await resultOf(out.runId, 'vendor/good-poet');
      assert.equal(good.verdict, 'cleared', `${good.gap_pct}% against ${run.floor_pct}%`);
      const short = await resultOf(out.runId, 'vendor/short-poet');
      assert.notEqual(short.verdict, 'cleared', `${short.gap_pct}% against ${run.floor_pct}%`);
    } finally {
      refMode = 'steady';
    }
  });
}

test('a structured workload whose model disagrees with itself is held to "at least as good" too', async () => {
  mode.jev = 'fair';
  mode.llm = 'fair';
  const { workload } = await seed({ kind: 'json', enabled: ['vendor/good-json', 'vendor/broken-json'] });
  assert.equal(workload.shape_kind, 'json');
  const extractBefore = counts.extract;
  const translateBefore = counts.translate;
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'quality');
  const plan = JSON.parse(run.plan_json);
  assert.ok(plan.yardstick.agreementNoisePct > 40, `the categories differ from call to call: ${plan.yardstick.agreementNoisePct}%`);
  assert.equal(counts.extract, extractBefore, 'a structured answer is read as its JSON, with no checklist');
  assert.equal(counts.translate, translateBefore, 'and never translated');
  const good = await resultOf(out.runId, 'vendor/good-json');
  assert.equal(good.verdict, 'cleared', `${good.gap_pct}% (up to ${good.gap_hi}%) against ${run.floor_pct}% on ${good.runs} calls, `
    + `${good.errors} errors, stopped ${good.stopped}; judge check ${run.judge_check_json}`);
  const broken = await resultOf(out.runId, 'vendor/broken-json');
  assert.notEqual(broken.verdict, 'cleared');
});

test('a structured answer judged "at least as good" still fails when it changes a field its customer model gives the same way every time', async () => {
  mode.jev = 'fair';
  mode.llm = 'fair';
  const { workload } = await seed({ kind: 'json', enabled: ['vendor/good-json', 'vendor/slip-json'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'quality', 'judged "at least as good", since its categories differ from call to call');
  // the fields its model gives the same way on nearly every call: never the category, which it picks afresh each time
  const stableFields = JSON.parse(run.plan_json).yardstick?.stableFields;
  assert.deepEqual([...(stableFields || [])].sort(), ['currency', 'total'], JSON.stringify(stableFields));
  const good = await resultOf(out.runId, 'vendor/good-json');
  assert.equal(good.verdict, 'cleared', `keeps every field the customer's model keeps: ${good.verdict}, ${good.gap_pct}% against ${run.floor_pct}%`);
  const slip = await resultOf(out.runId, 'vendor/slip-json');
  assert.notEqual(slip.verdict, 'cleared', `no judge here reads the currency, so this is the field check at work: ${slip.verdict}, ${slip.gap_pct}%`);
  const by = await judgedBy(out.runId, 'vendor/slip-json');
  assert.ok((by.fields || 0) > 0, `decided in code on the invoices it changed the currency of: ${JSON.stringify(by)}`);
  const one = await db.prepare(`SELECT readings FROM eval_replays WHERE run_id = ? AND model_id = ? AND judged_by = 'fields' LIMIT 1`)
    .get(out.runId, 'vendor/slip-json');
  assert.equal(JSON.parse(one.readings).field, 'currency', 'and its page can name the field');

  /* the daily checks read a served answer the same way, held to the fields that measurement read (barOf): the customer's
     model is asked again, and gives the same currency again */
  forgetBar(workload.id);
  const { stable } = await barOf(workload);
  assert.deepEqual([...(stable || [])].sort(), ['currency', 'total'], 'read back for the daily checks');
  const body = { model: REF, messages: [{ role: 'system', content: 'Read the invoice and give its category and total as JSON.' }, { role: 'user', content: 'Invoice #3' }],
    response_format: { type: 'json_object' } };
  const as = (x) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(x) } }] });
  const own = as({ category: 'travel', total: 103, currency: 'EUR' });
  const ownAgain = async () => ({ json: as({ category: 'office', total: 103, currency: 'EUR' }), cost: 0.002 });
  const slipped = await scoreServed(body, as({ category: 'food', total: 103, currency: 'USD' }), own, 'json', { yardstick: 'quality', again: ownAgain, stable });
  assert.equal(slipped.score, 1, JSON.stringify(slipped));
  assert.equal(slipped.judgedBy, 'fields');
  assert.equal(slipped.field, 'currency');
  assert.equal(slipped.twice, true, 'after asking the customer\'s model a second time');
  // one that keeps what the customer's model keeps, and differs only in what it varies itself, is read by the judge
  const kept = await scoreServed(body, as({ category: 'food', total: 103, currency: 'EUR' }), own, 'json', { yardstick: 'quality', again: ownAgain, stable });
  assert.notEqual(kept.judgedBy, 'fields', JSON.stringify(kept));
  assert.equal(kept.score, 0, JSON.stringify(kept));
  // and a check with no fields read to go on (a measurement from before they were read) holds none, rather than guess
  const unread = await scoreServed(body, as({ category: 'food', total: 103, currency: 'USD' }), own, 'json', { yardstick: 'quality', again: ownAgain });
  assert.notEqual(unread.judgedBy, 'fields', JSON.stringify(unread));
});

test('the judge reads the question at the end of a long request, however much comes before it', async () => {
  const seen = [];
  const askFn = async (state) => {
    seen.push(state.request);
    return { answers: { better: { type: 'choice', probabilities: { first: 0.1, second: 0.1, equal: 0.8 } } }, costUsd: 0.001 };
  };
  const body = { model: REF, messages: [{ role: 'system', content: `Rules. ${'Be exact about every figure. '.repeat(300)}` },
    { role: 'user', content: `${'Background. '.repeat(400)}Question: which invoice is overdue, #${process.pid}?` }] };
  await judgeQuality(askOf(body), 'Invoice 7 is overdue.', 'Invoice 7 is overdue, by nine days.', { scope: `ask-${process.pid}`, askFn, prefer: 'jev' });
  assert.equal(seen.length, 2, 'read both ways round');
  for (const r of seen) {
    assert.ok(r.length <= 2500, `${r.length} characters`);
    assert.match(r, /Rules\. Be exact/, 'the start of the instructions');
    assert.match(r, new RegExp(`Question: which invoice is overdue, #${process.pid}\\?$`), 'and the question itself, whole');
  }
});

test("the bar reads the customer's model against itself as a candidate is read: its own slips on a held field count half", async () => {
  mode.jev = 'fair';
  mode.llm = 'fair';
  refMode = 'slips';
  refJson = 0;
  try {
    const { workload } = await seed({ kind: 'json', enabled: ['vendor/good-json'] });
    const out = await runEvaluation(workload.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    const run = await runOf(out.runId);
    assert.equal(run.yardstick, 'quality');
    const y = JSON.parse(run.plan_json).yardstick;
    // one answer in forty with another currency is still nearly every call: held
    assert.deepEqual([...(y.stableFields || [])].sort(), ['currency', 'total'], JSON.stringify(y));
    /* a fair judge reads neither a category nor a currency as a fault, so every pair of the bar is "as good" to it: what
       lifts the bar off nothing is the pairs whose two answers gave two currencies, at half each */
    const pairs = Number(run.sample_size);
    const slips = Math.floor(pairs / 40);
    assert.ok(slips >= 1, `the bar has pairs that slipped: ${pairs} pairs`);
    assert.ok(Math.abs(Number(y.qualityNoisePct) - (50 * slips) / pairs) < 0.6, `${y.qualityNoisePct}% for ${slips} of ${pairs}`);
    // and a candidate that never slips still clears
    const good = await resultOf(out.runId, 'vendor/good-json');
    assert.equal(good.verdict, 'cleared', `${good.verdict}, ${good.gap_pct}% against ${run.floor_pct}%`);
  } finally {
    refMode = 'steady';
  }
});

test('answers read in the background hold a structured answer to the figures its measurement read the same way', async () => {
  mode.jev = 'fair';
  mode.llm = 'fair';
  // asks before switching, so the one that passed is tried in the background rather than switched to
  const { workload } = await seed({ kind: 'json', enabled: ['vendor/good-json'], mode: 'ask' });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runOf(out.runId)).yardstick, 'quality');
  assert.equal((await resultOf(out.runId, 'vendor/good-json')).verdict, 'cleared');
  await db.prepare(`UPDATE workloads SET explore_mode = 'shadow' WHERE id = ?`).run(workload.id);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  forgetBar(w.id);
  const st = await stateOf(w, { fresh: true });
  assert.ok(st.arms.some((a) => a.status === 'trying'), `the one that passed is a runner-up: ${JSON.stringify(st.arms.map((a) => [a.label, a.status]))}`);
  const body = { model: REF, messages: [{ role: 'system', content: 'Read the invoice and give its category and total as JSON.' }, { role: 'user', content: 'Invoice #3' }],
    response_format: { type: 'json_object' } };
  const as = (x) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(x) } }] });
  const serve = (x) => async () => ({ json: as(x), cost: 0.0002, latencyMs: 10 });
  const used = as({ category: 'travel', total: 103, currency: 'EUR' });
  // a changed total is short, decided in code: the judge never reads it
  const moved = await maybeShadow({ workload: w, body, response: used, callId: null }, { rng: () => 0, serve: serve({ category: 'food', total: 130, currency: 'EUR' }) });
  assert.ok(moved, 'a background answer was read');
  assert.deepEqual([moved.agreement, moved.yardstick, JSON.parse(moved.detail_json).judgedBy], [0, 'quality', 'fields'], moved.detail_json);
  /* against one answer, not two, only a figure is held: a word the customer's model might have put another way on another
     reading (the currency here) is left to the judge, as is a category it picks afresh each time */
  const reworded = await maybeShadow({ workload: w, body, response: used, callId: null }, { rng: () => 0, serve: serve({ category: 'food', total: 103, currency: 'USD' }) });
  assert.ok(reworded, 'a background answer was read');
  assert.notEqual(JSON.parse(reworded.detail_json).judgedBy, 'fields', reworded.detail_json);
});

test('negative: a workload whose model agrees with itself stays on "the same answer", and pays for nothing new', async () => {
  mode.jev = 'fair';
  mode.llm = 'fair';
  const before = { ...counts };
  const { workload } = await seed({ kind: 'echo', enabled: ['vendor/echo'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'agreement');
  assert.ok(near(run.floor_pct, Math.max(Number(run.noise_pct) * 1.25, 3)), 'its bar is still a multiple of its noise');
  assert.equal(counts.extract, before.extract, 'no checklist read');
  assert.equal(counts.translate, before.translate, 'nothing translated');
  assert.equal(counts.llmQuality, before.llmQuality, 'no "at least as good" reading by the language model');
  assert.equal(checkOf(run)?.kinds, undefined, 'and no planted answers: the same-answer yardstick keeps its own two checks');
  assert.equal((await keptChecklist(workload.id)).length, 0);
  const echo = await resultOf(out.runId, 'vendor/echo');
  assert.equal(echo.verdict, 'cleared', `${echo.gap_pct}% against ${run.floor_pct}%`);
});

test('the page says how a measurement was judged, and draws one that compared nothing', async () => {
  const { run, workload } = poemRuns.leans;
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  const page = await runPageOf(w, run);
  assert.equal(page.yardstick, 'quality');
  assert.match(page.take, /Because the original model answers the same request differently each time, each model was checked for answers at least as good as the original model's, rather than the same answers\./);
  assert.ok(page.self, 'every measurement carries what to draw');
  // a measurement from before, that could not be measured, drawn against the most a bar could be set from
  const old = { ...run, id: `run_old_${process.pid}`, outcome: 'unmeasurable', noise_pct: 47, floor_pct: 58.75, yardstick: 'agreement',
    plan_json: null, judge_check_json: null, sample_size: 27 };
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, sample_size, noise_pct,
      floor_pct, created_at) VALUES (?, ?, ?, 'done', 'unmeasurable', 'free_text', ?, 27, 47, 58.75, ?)`)
    .run(old.id, w.workspace_id, w.id, REF, now() - 2 * DAY);
  const oldPage = await runPageOf(w, await runOf(old.id));
  assert.equal(oldPage.cands.length, 0);
  assert.equal(oldPage.self.noise, 0.47);
  assert.equal(oldPage.self.most, 0.4);
  assert.equal(oldPage.self.bar, null);
  assert.match(oldPage.take, /Workloads like this are now compared on whether answers are at least as good as the original model's, so the next test compares models\./);
});

// last, because the judge refusing everything leaves nothing in a state the other tests would read
test('negative: a judge that does not answer interrupts the measurement to try again, never ends it unmeasurable', async () => {
  mode.jev = 'malformed';
  mode.llm = 'down';
  refMode = 'steady';
  const { workload } = await seed({ n: 120, enabled: ['vendor/good-poet'] });
  const out = await runEvaluation(workload.id);
  const run = await db.prepare('SELECT * FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
  assert.equal(run.outcome, 'interrupted', `${run.outcome}: ${run.error} ${JSON.stringify(out)}`);
  // the pairs where the two answers are word for word the same need no judge
  assert.match(run.error, /The judge answered on only \d+ of the \d+ pairs/);
  assert.equal(await db.prepare(`SELECT COUNT(*)::int AS n FROM eval_runs WHERE workload_id = ? AND outcome = 'unmeasurable'`).get(workload.id)
    .then((r) => r.n), 0);
  const page = await runPageOf(await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id), run);
  assert.equal(page.cands.length, 0);
  assert.equal(page.self.noise, null, 'it ended before it set a bar');
  assert.ok(page.self.done > 0 && page.self.total >= page.self.done, JSON.stringify(page.self));
  mode.jev = 'fair';
  mode.llm = 'fair';
});
