/* Open-ended writing is judged for answers at least as good as the original model's, end to end: a provider, a Jev and
   a language-model judge we control, a real database, the real measurement, the daily checks, the background answers,
   the page and its route.

   On 24 Sep a poem workload (wl_mufo6b151fhb1ngm) failed every model tested. Its own model's two poems for a request
   read to Jev as the same, since they share a voice, so it was held to "the same answer"; every other model's poem read
   as different, as every different poem does, and a lean towards whichever poem Jev read first kept those differences
   from being forgiven. 492 of the 498 differences counted against them were in wording alone. The stand-in Jev here
   reads poems the way it did. What is checked:
   - a workload whose requests ask for open-ended writing is held to "at least as good" however well its model agrees
     with itself: a good poem in another voice passes; one without the sign-off, one on a single line, one too short
     and one that changes a figure its model gives both times do not (A);
   - what must NOT change: plain factual answers, friendly replies Jev reads as only partly creative, and poems whose own
     answers differ in figures stay on "the same answer", and the last is never even asked about; a language model
     reading in Jev's place says it cannot tell of the friendly replies (B);
   - the workload's own setting: "the same answer" or "at least as good" whatever its work reads as; a workload read as
     open-ended stays so on a later test unless its requests clearly read otherwise; and one held to the same answer
     that varies too much is told how to change it (C);
   - a lean too slight to count is a tie, and a sure one is not (D);
   - the daily checks after a switch, and the answers read in the background, judge as the test did (E);
   - the page says why each model was judged the way it was and shows the judge's two readings, and the setting can be
     read and changed through its route, for written work only (F). */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4901;
const APP_PORT = 4902;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_open_ended_${process.pid}`;
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
process.env.STARTER_CREDIT_USD = '0';
process.env.MEASURE_READY_CHECK_MS = '0';
process.env.CONTROL_ENABLED = 'true';
process.env.PUBLIC_URL = `http://localhost:${APP_PORT}`;

const { db, now } = await import('../src/db/index.js');
const { default: migrate } = await import('../src/db/migrate.js');
const { createAccount } = await import('../src/auth.js');
const { workloadFor, recordCall, learningSettled } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { planFor } = await import('../src/eval/plan.js');
const { move } = await import('../src/billing.js');
const { judgeQuality } = await import('../src/eval/judge.js');
const { scoreServed, maybeControl, forgetBar } = await import('../src/learn/control.js');
const { maybeShadow, stateOf } = await import('../src/learn/explore.js');
const { keptChecklist } = await import('../src/eval/checklist.js');
const { runPageOf, runAnswersOf } = await import('../src/workloadPage.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const DAY = 86400000;
const REF = 'openai/gpt-5.4';
const SIGN = '- Acme Poems';
const INSTRUCTION = `You are the poet for Acme. Write a short poem about what you are asked, and always end with the line: ${SIGN}`;
// the customer's model's voice, and another model's: the same sea, in other words
const VOCAB = ['the', 'sea', 'waves', 'light', 'blue', 'night', 'and', 'of', 'wind', 'stars', 'home', 'shore', 'salt', 'grey', 'dawn', 'song'];
const OTHER = ['the', 'sea', 'surf', 'light', 'blue', 'night', 'and', 'of', 'wind', 'stars', 'home', 'coast', 'foam', 'grey', 'dawn', 'song'];
const DE = { the: 'die', sea: 'meer', waves: 'wellen', surf: 'brandung', light: 'licht', blue: 'blau', night: 'nacht', and: 'und', of: 'von',
  wind: 'wind', stars: 'sterne', home: 'heim', shore: 'ufer', coast: 'kueste', salt: 'salz', foam: 'schaum', grey: 'grau', dawn: 'morgen', song: 'lied' };
/* A verse of `n` words about the sea, a different one for every seed; in the other voice it carries "brine", a word
   the customer's model never uses, so the two voices are told apart. */
const verse = (n, seed, vocab = VOCAB) => {
  const words = Array.from({ length: n }, (_, k) => vocab[(seed * 7 + k * 5 + Math.floor(k / 3)) % vocab.length]);
  words.splice(0, 2, 'the', 'sea');
  if (vocab === OTHER && n > 2) words.splice(2, 1, 'brine');
  return words.join(' ');
};
const titled = (i, body, { signed = true } = {}) => `Poem ${i}\n${body}${signed ? `\n${SIGN}` : ''}`;
const otherVoice = (t) => /\bbrine\b/.test(String(t));
const wordCount = (t) => String(t).split(/\s+/).filter(Boolean).length;
const lineCount = (t) => String(t).split('\n').filter((l) => l.trim()).length;
const figures = (t) => (String(t).match(/\d+/g) || []).join(',');

/* A competent reader's faults in a poem: no sign-off, too short to be the poem asked for, run onto one line, or in
   German. Two poems with as few faults are as good as each other, whoever wrote them. */
function faults(request, text) {
  if (!String(request).includes('Acme Poems')) return 0;
  const t = String(text);
  let n = 0;
  if (!t.includes(SIGN)) n += 1;
  if (wordCount(t) < 15) n += 1;
  if (lineCount(t) < 3) n += 1;
  if (/\b(meer|wellen|brandung|und|die|nacht)\b/.test(t)) n += 1;
  return n;
}
const pickOf = (c, p) => ({ choice: c, confidence: p,
  probabilities: { first: c === 'first' ? p : (1 - p) / 2, second: c === 'second' ? p : (1 - p) / 2, equal: c === 'equal' ? p : (1 - p) / 2 } });
/* Which of two answers serves the request better, as Jev read the poems: the one with fewer faults, surely; the same
   text, equal; and two different poems as good as each other, spread across the three, with a lean to whichever it
   read first. `leanTo` is a preference for the customer's model's voice in whichever order, as sure as it says. */
const jev = { leanTo: null, openMode: 'content', openCounter: 0 };
function better(request, first, second) {
  const a = faults(request, first);
  const b = faults(request, second);
  if (a !== b) return pickOf(a < b ? 'first' : 'second', 0.9);
  if (String(first).trim() === String(second).trim()) return pickOf('equal', 0.9);
  if (jev.leanTo !== null && otherVoice(first) !== otherVoice(second)) return pickOf(otherVoice(first) ? 'second' : 'first', jev.leanTo);
  return { choice: 'first', confidence: 0.4, probabilities: { first: 0.4, second: 0.35, equal: 0.25 } };
}
/* Whether two answers serve the person equally, as Jev read them: the same words, however spaced; or two poems in one
   voice with the same figures, since two poems from one model share a voice (which is what set the 24 Sep bar). */
const spaced = (t) => String(t).replace(/\s+/g, ' ').trim();
const sameServe = (x, y) => spaced(x) === spaced(y)
  || (String(x).includes(SIGN) && String(y).includes(SIGN) && otherVoice(x) === otherVoice(y) && figures(x) === figures(y));

const counts = { open: 0, llmOpen: 0, extract: 0, translate: 0, llmQuality: 0, better: 0 };
let seedCounter = 0;
const nextSeed = () => { seedCounter += 1; return seedCounter * 13 + 5; };
let replay = 0;
let refMode = 'voice';
/* What each model writes, by the kind of request: poems about the sea, poems about an order (whose number the
   customer's model changes on one answer in four), a figure doubled, and a friendly reply. */
const REPLY = (i) => `Hello customer ${i}, thank you for writing to Acme. We are glad to help.`;
const refPoem = (i, k) => titled(i, verse(30, i * 31 + k, refMode === 'mixedvoice' && k % 2 ? OTHER : VOCAB));
const BEHAVIOUR = {
  poem: {
    [REF]: (i) => { replay += 1; return refPoem(i, replay); },
    'vendor/other-poet': (i) => titled(i, verse(30, nextSeed(), OTHER)),
    'vendor/nosign-poet': (i) => titled(i, verse(30, nextSeed(), OTHER), { signed: false }),
    'vendor/oneline-poet': (i) => `Poem ${i} ${verse(30, nextSeed(), OTHER)} ${SIGN}`,
    'vendor/short-poet': (i) => titled(i, verse(5, nextSeed(), OTHER)),
    'vendor/miscount-poet': (i) => titled(i + 1, verse(30, nextSeed(), OTHER)),
  },
  order: {
    [REF]: (i) => { replay += 1; return `Order ${replay % 4 === 0 ? i + 1 : i}\n${verse(30, i * 31 + replay)}\n${SIGN}`; },
    'vendor/other-poet': (i) => `Order ${i}\n${verse(30, nextSeed(), OTHER)}\n${SIGN}`,
  },
  echo: {
    [REF]: (i) => `The answer to request ${i} is ${i * 2}.`,
    'vendor/echo': (i) => `The answer to request ${i} is ${i * 2}.`,
    'vendor/echo-wrong': (i) => `The answer to request ${i} is ${i * 2 + 1}.`,
  },
  reply: {
    [REF]: REPLY,
    'vendor/echo': REPLY,
  },
  json: {
    [REF]: (i) => JSON.stringify({ category: 'travel', total: 100 + i }),
    'vendor/good-json': (i) => JSON.stringify({ category: 'travel', total: 100 + i }),
  },
};
const kindOf = (user) => (/^Write a poem about the sea/.test(user) ? 'poem' : /^Write a poem about order/.test(user) ? 'order'
  : /^Double request/.test(user) ? 'echo' : /^Reply kindly/.test(user) ? 'reply' : /^Invoice/.test(user) ? 'json' : null);

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
      for (const [k, v] of Object.entries(q)) {
        if (k === 'better') {
          counts.better += 1;
          answers.better = better(s.request, s.answers?.first, s.answers?.second);
        } else if (k === 'open') {
          counts.open += 1;
          if (jev.openMode === 'none') continue;
          const request = String(s.request);
          const high = jev.openMode === 'counter' ? (jev.openCounter++ % 8) < 5
            : /Write a poem/.test(request);
          answers.open = { noul: high ? 0.95 : /Reply kindly/.test(request) ? 0.7 : 0.05 };
        } else if (/^need\d+[ab]$/.test(k)) {
          const text = k.endsWith('a') ? s.answers?.first : s.answers?.second;
          answers[k] = { noul: /sea/i.test(v.instructions) ? (/\bsea\b/.test(String(text)) ? 0.95 : 0.05) : 0.95 };
        } else if (/^same\d?$/.test(k)) {
          // the two answers this question names, however they were labelled
          const [, x, y] = String(v.instructions).match(/`answers\.(\w+)` as by `answers\.(\w+)`/) || [];
          answers[k] = { noul: x && y && sameServe(s.answers?.[x], s.answers?.[y]) ? 0.95 : 0.05 };
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
    // priced from the catalogue, as the quote prices them
    const send = (content) => json(res, 200, { id: `gen-${Math.random().toString(36).slice(2)}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 600, completion_tokens: 60 } });
    // the language-model judge, the checklist reader, the translator and the reader of what writing is asked for
    if (model === 'judge/small') {
      if (sys.includes('creative or open-ended writing')) {
        counts.llmOpen += 1;
        const request = fenced(user, 'REQUEST');
        return send(/Write a poem/.test(request) ? 'YES' : /Reply kindly/.test(request) ? 'UNSURE' : 'NO');
      }
      if (sys.includes('say which one serves')) {
        counts.llmQuality += 1;
        const c = better(fenced(user, 'REQUEST'), fenced(user, 'FIRST'), fenced(user, 'SECOND')).choice;
        return send(c === 'first' ? 'FIRST' : c === 'second' ? 'SECOND' : 'TIE');
      }
      if (sys.includes('list the requirements')) {
        counts.extract += 1;
        const items = user.includes('Acme Poems')
          ? [{ kind: 'includes', text: SIGN, say: 'Ends with the Acme Poems line' }, { kind: 'min_lines', n: 3, say: 'At least three lines' },
            { kind: 'ask', say: 'About the sea' }]
          : [];
        return send(JSON.stringify({ items }));
      }
      if (sys.includes('Translate the text')) {
        counts.translate += 1;
        return send(user.split(/(\s+)/).map((w) => DE[w] ?? w).join('').replace(SIGN, '- Acme Gedichte'));
      }
      // the same-answer judge: the same only when it is the same text
      const a = fenced(user, 'A');
      const b = fenced(user, 'B');
      return send(a.trim() === b.trim() ? 'SAME' : 'DIFFERENT');
    }
    const i = Number((user.match(/#(\d+)/) || [])[1] || 0);
    const kind = kindOf(user);
    const write = kind && BEHAVIOUR[kind][model];
    return send(write ? write(i) : 'nothing');
  });
});

const CANDIDATES = ['vendor/other-poet', 'vendor/nosign-poet', 'vendor/oneline-poet', 'vendor/short-poet', 'vendor/miscount-poet',
  'vendor/echo', 'vendor/echo-wrong', 'vendor/good-json', 'judge/small'];

let appServer = null;
test.before(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => { appServer = app.listen(APP_PORT, '127.0.0.1', r); });
  await saveCatalog([
    { model_id: REF, name: 'OpenAI: GPT-5.4', context_len: 200000, price_in: 2.5e-6, price_out: 15e-6, open_weights: 0, zdr: 1 },
    ...CANDIDATES.map((m) => ({ model_id: m, name: m.split('/')[1], context_len: 128000, price_in: 0.1e-6, price_out: 0.3e-6,
      open_weights: m === 'judge/small' ? 0 : 1, zdr: 1 })),
  ]);
});

test.after(async () => {
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => server.close(r));
  await learningSettled();
  await db.close();
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.end();
});

const SYSTEMS = {
  poem: INSTRUCTION, order: INSTRUCTION, echo: 'Answer with the figure asked for, in one sentence.',
  reply: 'You write friendly replies to the customers of Acme, in two sentences.', json: 'Read the invoice and give its category and total as JSON.',
};
const USERS = { poem: (i) => `Write a poem about the sea, #${i}`, order: (i) => `Write a poem about order #${i}`, echo: (i) => `Double request #${i}`,
  reply: (i) => `Reply kindly to customer #${i}`, json: (i) => `Invoice #${i}` };
const RECORDED = { poem: (i) => refPoem(i, 0), order: (i) => `Order ${i}\n${verse(30, i * 31)}\n${SIGN}`, echo: BEHAVIOUR.echo[REF],
  reply: REPLY, json: BEHAVIOUR.json[REF] };

let seq = 0;
/** A workspace with one workload of `n` recorded calls of one kind, the models named enabled, and its own judging setting. */
async function seed({ n = 220, kind = 'poem', enabled = [], optimize = 'auto', judgeMode = null } = {}) {
  seq += 1;
  const email = `open-${seq}-${process.pid}@understudy.dev`;
  const { workspace } = await createAccount({ email, password: 'correct-horse-battery', name: `o${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(optimize, workspace.id);
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const request = { model: REF, messages: [{ role: 'system', content: SYSTEMS[kind] }, { role: 'user', content: USERS[kind](i) }],
      ...(kind === 'json' ? { response_format: { type: 'json_object' } } : {}) };
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 600, completionTokens: 60, costUsd: 0.002, chargedUsd: 0,
      request, response: { choices: [{ message: { content: RECORDED[kind](i) } }], usage: { cost: 0.002 } },
    });
  }
  await db.prepare('UPDATE calls SET created_at = ?::bigint - (abs(hashtext(id)) % 14)::bigint * 86400000 WHERE workload_id = ?')
    .run(now() - DAY, workload.id);
  if (judgeMode) await db.prepare('UPDATE workloads SET judge_mode = ? WHERE id = ?').run(judgeMode, workload.id);
  for (const m of CANDIDATES) {
    await db.prepare(`INSERT INTO workspace_models (workspace_id, model_id, enabled, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, model_id) DO UPDATE SET enabled = excluded.enabled`).run(workspace.id, m, enabled.includes(m) ? 1 : 0, now());
  }
  return { workspace, email, workload: await load(workload.id) };
}
const load = (id) => db.prepare('SELECT * FROM workloads WHERE id = ?').get(id);
const runOf = (id) => db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id);
const resultOf = (runId, model) => db.prepare('SELECT * FROM eval_results WHERE run_id = ? AND model_id = ?').get(runId, model);
const planOf = (run) => JSON.parse(run.plan_json || 'null');
const judgedBy = async (runId, model) => (await db.prepare(
  'SELECT judged_by, COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND judged_by IS NOT NULL GROUP BY 1').all(runId, model))
  .reduce((a, r) => ({ ...a, [r.judged_by]: Number(r.n) }), {});
/* A finished test from before open-ended writing was looked for, as the 24 Sep ones were: held to the same answer,
   with nothing in it about what kind of writing the requests ask for. */
async function oldTest(workload, { yardstick = 'agreement', judging = null, at = now() - 2 * DAY } = {}) {
  const id = `run_old_${seq}_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  await db.prepare(`INSERT INTO eval_runs (id, workspace_id, workload_id, status, outcome, shape_kind, reference_model, sample_size, noise_pct,
      yardstick, plan_json, created_at) VALUES (?, ?, ?, 'done', 'compared', 'free_text', ?, 40, 10, ?, ?, ?)`)
    .run(id, workload.workspace_id, workload.id, REF, yardstick, judging ? JSON.stringify({ judging }) : null, at);
  return id;
}

const runs = {};

/* A. Open-ended writing ---------------------------------------------------------------------------------------- */

test('A: poems are held to "at least as good" however well their model agrees with itself, and the quote covers it', async () => {
  jev.openMode = 'content';
  jev.leanTo = null;
  refMode = 'voice';
  const { workload, email } = await seed({ enabled: ['vendor/other-poet', 'vendor/nosign-poet', 'vendor/oneline-poet', 'vendor/short-poet',
    'vendor/miscount-poet'] });
  assert.equal(workload.shape_kind, 'free_text');
  // last tested the way the 24 Sep tests were, held to the same answer: the quote must still cover "at least as good"
  await oldTest(workload);
  const plan = await planFor(await load(workload.id), { canRoute: true });
  assert.equal(plan.yardstick, 'agreement');
  assert.equal(plan.closedWork, false, 'nothing said that its requests are not open-ended writing');
  const before = { ...counts };
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  runs.open = { run, workload, email };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  const p = planOf(run);
  // its model agrees with itself: held to the same answer, that set a bar no poem in another voice could meet
  assert.ok(p.yardstick.agreementNoisePct < 10, `the customer's poems read as the same as each other: ${p.yardstick.agreementNoisePct}%`);
  assert.equal(run.yardstick, 'quality');
  assert.equal(p.yardstick.reason, 'open-ended');
  assert.equal(p.judging.mode, 'auto');
  assert.equal(p.judging.reason, 'open-ended');
  assert.equal(p.judging.openEnded.yes, true);
  assert.equal(p.judging.openEnded.share, 1);
  assert.equal(p.judging.openEnded.judge, 'jev');
  assert.equal(p.judging.openEnded.factsShare, 0);
  const asked = counts.open - before.open;
  assert.ok(asked >= 5 && asked <= 8, `up to eight requests read for what they ask: ${asked}`);
  assert.equal(p.judging.openEnded.n, asked);
  assert.equal(counts.llmOpen, before.llmOpen, 'Jev read them all, so the language model was not asked');
  // the bar: the customer's model is never clearly worse than itself, so five points
  assert.ok(Math.abs(Number(run.floor_pct) - 5) < 1e-6, `${run.floor_pct}% from ${run.noise_pct}%`);
  // the instruction's checklist, with its least number of lines
  const items = await keptChecklist(workload.id);
  assert.deepEqual(items.map((x) => x.kind), ['includes', 'min_lines', 'ask']);

  const other = await resultOf(out.runId, 'vendor/other-poet');
  assert.equal(other.verdict, 'cleared', `a good poem in another voice passes: ${other.gap_pct}% against ${run.floor_pct}%`);
  for (const m of ['vendor/nosign-poet', 'vendor/oneline-poet', 'vendor/short-poet', 'vendor/miscount-poet']) {
    const r = await resultOf(out.runId, m);
    assert.notEqual(r.verdict, 'cleared', `${m}: ${r.gap_pct}%`);
  }
  assert.ok((await judgedBy(out.runId, 'vendor/nosign-poet')).checklist > 0, 'the missing sign-off is found in code');
  assert.ok((await judgedBy(out.runId, 'vendor/oneline-poet')).checklist > 0, 'and a poem on one line, under the least number of lines');
  assert.ok((await judgedBy(out.runId, 'vendor/miscount-poet')).numbers > 0, 'a figure its model gives both times, changed, is worse in code');
  // the one as good as the customer's own passed its second look too, and serves
  assert.equal((await load(workload.id)).routed_model, 'vendor/other-poet');
  // what it spent is inside what it was quoted
  assert.ok(Number(run.spend_usd) <= Number(run.quote_usd) + 1e-9, `spent $${run.spend_usd}, quoted $${run.quote_usd}`);

  // what the judge said of each answer, kept for its page
  const kept = async (m, by) => JSON.parse((await db.prepare(`SELECT readings FROM eval_replays WHERE run_id = ? AND model_id = ?
      AND judged_by = ? AND readings IS NOT NULL LIMIT 1`).get(out.runId, m, by))?.readings || 'null');
  const read = await kept('vendor/other-poet', 'jev-quality');
  assert.deepEqual(read.picks, ['equal', 'equal'], 'a lean too slight to count is a tie');
  assert.deepEqual(read.seen, ['first', 'first'], 'each reading leaned to whichever poem it read first');
  assert.deepEqual(read.chances, [0.4, 0.4]);
  assert.deepEqual(await kept('vendor/miscount-poet', 'numbers'), { figures: true });
  assert.deepEqual(await kept('vendor/nosign-poet', 'checklist'), { broke: 'Ends with the Acme Poems line' });
  // the original model's own answers are read the same way, and nothing is kept for them
  assert.equal((await db.prepare(`SELECT COUNT(*)::int AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND readings IS NOT NULL`)
    .get(out.runId, REF)).n, 0);
});

/* B. What must not change --------------------------------------------------------------------------------------- */

test('B: plain factual answers stay on "the same answer": asked about, read as not open-ended', async () => {
  jev.openMode = 'content';
  const before = { ...counts };
  const { workload, email } = await seed({ kind: 'echo', enabled: ['vendor/echo', 'vendor/echo-wrong'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  runs.echo = { run, workload, email };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'agreement');
  const p = planOf(run);
  assert.equal(p.judging.reason, null);
  assert.equal(p.judging.openEnded.yes, false);
  assert.equal(p.judging.openEnded.share, 0);
  assert.ok(counts.open > before.open, 'its requests were read');
  assert.equal(counts.extract, before.extract, 'no checklist read');
  assert.equal(counts.llmQuality, before.llmQuality, 'no "at least as good" reading');
  assert.ok(Math.abs(Number(run.floor_pct) - Math.max(Number(run.noise_pct) * 1.25, 3)) < 1e-6, 'its bar is still a multiple of its noise');
  assert.equal((await resultOf(out.runId, 'vendor/echo')).verdict, 'cleared');
  assert.notEqual((await resultOf(out.runId, 'vendor/echo-wrong')).verdict, 'cleared', 'a wrong figure is a different answer');
  const page = await runPageOf(await load(workload.id), run);
  assert.doesNotMatch(page.take, /open-ended/);
  assert.ok(Number(run.spend_usd) <= Number(run.quote_usd) + 1e-9, `spent $${run.spend_usd}, quoted $${run.quote_usd}`);
});

test('B: friendly replies, which Jev reads as only partly creative, stay on "the same answer"', async () => {
  jev.openMode = 'content';
  const { workload } = await seed({ kind: 'reply', n: 160, enabled: ['vendor/echo'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'agreement');
  const open = planOf(run).judging.openEnded;
  assert.equal(open.yes, false);
  assert.equal(open.share, 0, 'read at 0.7, under the 0.85 it takes');
  assert.deepEqual([...new Set(open.ps)], [0.7]);
});

test('B: poems whose own answers differ in a figure stay on "the same answer", and are never asked about', async () => {
  jev.openMode = 'content';
  refMode = 'voice';
  const before = counts.open;
  const { workload, email } = await seed({ kind: 'order', enabled: ['vendor/other-poet'] });
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  runs.order = { run, workload, email };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'agreement');
  const p = planOf(run);
  assert.equal(p.judging.reason, null);
  assert.equal(p.judging.openEnded.yes, false);
  assert.equal(p.judging.openEnded.share, null, 'not read at all');
  assert.ok(p.judging.openEnded.factsShare > 0.1, `the order number changes on about one answer in four: ${p.judging.openEnded.factsShare}`);
  assert.equal(counts.open, before, 'Jev was not asked what kind of writing these requests ask for');
  // and so the quote for its next test is for "the same answer" alone
  const plan = await planFor(await load(workload.id), { canRoute: true });
  assert.equal(plan.closedWork, true);
});

test('B: where Jev cannot read the requests, the language model does, and cannot tell of friendly replies', async () => {
  jev.openMode = 'none';
  try {
    const before = { ...counts };
    const replies = await seed({ kind: 'reply', n: 120, enabled: ['vendor/echo'] });
    const one = await runOf((await runEvaluation(replies.workload.id)).runId);
    assert.equal(one.yardstick, 'agreement');
    assert.equal(planOf(one).judging.openEnded.judge, 'llm');
    assert.deepEqual([...new Set(planOf(one).judging.openEnded.ps)], [0.5], 'it said UNSURE, read as a half');
    assert.ok(counts.llmOpen > before.llmOpen);
    // a poem it says YES to, as plainly creative
    const poems = await seed({ n: 160, enabled: ['vendor/other-poet'] });
    const two = await runOf((await runEvaluation(poems.workload.id)).runId);
    assert.equal(two.yardstick, 'quality');
    assert.equal(planOf(two).judging.reason, 'open-ended');
    assert.equal(planOf(two).judging.openEnded.judge, 'llm');
    // Jev was asked and failed on each one, so the language model's readings are not kept under Jev's name
    const kept = await db.prepare(`SELECT COUNT(*)::int AS n FROM judge_cache WHERE judged_by = 'llm' AND detail_json IN ('{"p":1}', '{"p":0.5}')`).get();
    assert.equal(kept.n, 0);
  } finally {
    jev.openMode = 'content';
  }
});

/* C. The workload's own setting --------------------------------------------------------------------------------- */

test('C: set to "the same answer", poems are held to it, and the page says the setting asked for it', async () => {
  jev.openMode = 'content';
  refMode = 'voice';
  const before = counts.open;
  const { workload } = await seed({ enabled: ['vendor/other-poet'], judgeMode: 'same' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'agreement');
  assert.equal(planOf(run).judging.mode, 'same');
  assert.equal(planOf(run).judging.openEnded, null);
  assert.equal(counts.open, before, 'nothing asked about the requests');
  // exactly what failed on 24 Sep: a good poem in another voice, held to the same answer
  assert.notEqual((await resultOf(out.runId, 'vendor/other-poet')).verdict, 'cleared');
  const page = await runPageOf(await load(workload.id), run);
  assert.match(page.take, /As this workload's setting asks, each model was checked for the same answers as the original model's\./);
});

test('C: set to "at least as good", factual answers are held to it, and a changed figure is still worse', async () => {
  jev.openMode = 'content';
  const { workload } = await seed({ kind: 'echo', enabled: ['vendor/echo', 'vendor/echo-wrong'], judgeMode: 'quality' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'quality');
  assert.equal(planOf(run).judging.reason, 'chosen');
  assert.equal((await resultOf(out.runId, 'vendor/echo')).verdict, 'cleared');
  assert.notEqual((await resultOf(out.runId, 'vendor/echo-wrong')).verdict, 'cleared');
  assert.ok((await judgedBy(out.runId, 'vendor/echo-wrong')).numbers > 0, 'the figure the customer\'s model gives both times, changed');
  const page = await runPageOf(await load(workload.id), run);
  assert.match(page.take, /As this workload's setting asks, each model was checked for answers at least as good as the original model's, rather than the same answers\./);
  assert.ok(Number(run.spend_usd) <= Number(run.quote_usd) + 1e-9, `spent $${run.spend_usd}, quoted $${run.quote_usd}`);
});

test('C: work read as open-ended stays so on a later test unless its requests clearly read otherwise', async () => {
  refMode = 'voice';
  jev.openMode = 'counter';
  try {
    // five of the eight requests read as open-ended: not enough to become so
    jev.openCounter = 0;
    const fresh = await seed({ n: 160, enabled: ['vendor/other-poet'] });
    const one = await runOf((await runEvaluation(fresh.workload.id)).runId);
    assert.equal(one.yardstick, 'agreement');
    assert.equal(planOf(one).judging.openEnded.share, 0.625);
    assert.equal(planOf(one).judging.openEnded.yes, false);
    // enough to stay so, where the newest test read it as open-ended
    jev.openCounter = 0;
    const was = await seed({ n: 160, enabled: ['vendor/other-poet'] });
    await oldTest(was.workload, { yardstick: 'quality', judging: { mode: 'auto', reason: 'open-ended' } });
    const two = await runOf((await runEvaluation(was.workload.id)).runId);
    assert.equal(two.yardstick, 'quality');
    const open = planOf(two).judging.openEnded;
    assert.deepEqual([open.yes, open.share, open.kept], [true, 0.625, true]);
    assert.equal((await resultOf(two.id, 'vendor/other-poet')).verdict, 'cleared');
  } finally {
    jev.openMode = 'content';
  }
});

test('C: held to "the same answer" by its setting, a model that varies too much is told how to change it', async () => {
  jev.openMode = 'content';
  refMode = 'mixedvoice';
  try {
    const { workload } = await seed({ n: 160, enabled: ['vendor/other-poet'], judgeMode: 'same' });
    const run = await runOf((await runEvaluation(workload.id)).runId);
    assert.equal(run.outcome, 'unmeasurable', `${run.outcome}: ${run.error}`);
    const page = await runPageOf(await load(workload.id), run);
    assert.match(page.take, /This workload's setting asks for the same answers as the original model's\. Set Answers judged, at the top of this page, to Automatically or At least as good, and the next test compares models on whether their answers are at least as good\.$/);
    // once the setting is changed, the same test says the next one compares models
    await db.prepare('UPDATE workloads SET judge_mode = NULL WHERE id = ?').run(workload.id);
    assert.match((await runPageOf(await load(workload.id), run)).take, /With this workload's setting changed since, the next test compares models/);
  } finally {
    refMode = 'voice';
  }
});

/* D. A lean too slight to count --------------------------------------------------------------------------------- */

test('D: a preference for the original model\'s poem is counted only where Jev gives it at least half a chance', async () => {
  const { workload } = runs.open;
  const request = `system: ${INSTRUCTION}\nuser: Write a poem about the sea, #3`;
  try {
    jev.leanTo = 0.45;
    const mild = await judgeQuality(request, titled(3, verse(30, 901, OTHER)), titled(3, verse(30, 902)), { scope: workload.workspace_id });
    assert.equal(mild.score, 0, 'both readings leaned to the original model\'s poem, too slightly to count');
    assert.deepEqual(mild.detail.picks, ['equal', 'equal']);
    assert.deepEqual(mild.detail.seen, ['second', 'first'], 'the original model\'s, in whichever order it was read');
    assert.deepEqual(mild.detail.chances, [0.45, 0.45]);
    jev.leanTo = 0.6;
    const sure = await judgeQuality(request, titled(3, verse(30, 903, OTHER)), titled(3, verse(30, 904)), { scope: workload.workspace_id });
    assert.equal(sure.score, 1, 'sure enough, in both orders, is clearly worse');
    assert.deepEqual(sure.detail.picks, ['second', 'first']);
  } finally {
    jev.leanTo = null;
  }
});

/* E. After the test ------------------------------------------------------------------------------------------------ */

const asJson = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const bodyOf = (i) => ({ model: REF, messages: [{ role: 'system', content: INSTRUCTION }, { role: 'user', content: `Write a poem about the sea, #${i}` }] });

test('E: the daily checks hold a changed figure to the original model asked again, as the test does', async () => {
  const { workload } = runs.open;
  const opts = { scope: workload.workspace_id, yardstick: 'quality', checklist: await keptChecklist(workload.id) };
  let asked = 0;
  const again = (text) => async () => { asked += 1; return { json: asJson(text), cost: 0.001 }; };
  // the figure changed, and the customer's model gives it again: worse, whatever a reading says
  const held = await scoreServed(bodyOf(7), asJson(titled(8, verse(30, 11, OTHER))), asJson(titled(7, verse(30, 12))), 'free_text',
    { ...opts, again: again(titled(7, verse(30, 13))) });
  assert.deepEqual([held.score, held.judgedBy, held.kind, held.twice], [1, 'numbers', 'fact', true]);
  assert.ok(held.cost >= 0.001, 'the second answer is paid for');
  // the customer's model itself gives another figure the second time: the reading decides
  const loose = await scoreServed(bodyOf(7), asJson(titled(8, verse(30, 14, OTHER))), asJson(titled(7, verse(30, 15))), 'free_text',
    { ...opts, again: again(titled(9, verse(30, 16))) });
  assert.deepEqual([loose.score, loose.judgedBy, loose.twice], [0, 'jev-quality', true]);
  // the same figure: nothing asked again
  const before = asked;
  const same = await scoreServed(bodyOf(7), asJson(titled(7, verse(30, 17, OTHER))), asJson(titled(7, verse(30, 18))), 'free_text',
    { ...opts, again: again('never') });
  assert.equal(same.score, 0);
  assert.equal(asked, before, 'the customer\'s model is asked once');
  assert.equal(same.twice, false);

  // and in a real check of the switch: asked twice, the row says so
  const w = await load(workload.id);
  assert.ok(w.routed_arm_id, 'switched in A');
  forgetBar(w.id);
  const ref = [];
  const serve = async (spec) => { ref.push(spec.model ?? spec.kind); return { json: asJson(titled(7, verse(30, 19))), cost: 0.002, latencyMs: 20 }; };
  const row = await maybeControl({ workload: w, body: bodyOf(7), response: asJson(titled(8, verse(30, 20, OTHER))), callId: null,
    decision: { armId: w.routed_arm_id } }, { rng: () => 0, serve });
  assert.ok(row, 'a check was made');
  assert.deepEqual([row.score, row.judged_by, row.yardstick], [1, 'numbers', 'quality']);
  assert.equal(JSON.parse(row.detail_json).askedTwice, true);
  assert.equal(ref.length, 2, 'the customer\'s model answered twice');
  assert.ok(Math.abs(row.cost_usd - 0.004) < 1e-9, `both answers are paid for: ${row.cost_usd}`);
});

test('E: answers read in the background are read as the test judged, and only those readings count', async () => {
  jev.openMode = 'content';
  refMode = 'voice';
  // asks before switching, so the one that passed is tried in the background rather than switched to
  const { workload } = await seed({ n: 160, enabled: ['vendor/other-poet'], optimize: 'ask' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'quality');
  assert.equal((await resultOf(out.runId, 'vendor/other-poet')).verdict, 'cleared');
  await db.prepare(`UPDATE workloads SET explore_mode = 'shadow' WHERE id = ?`).run(workload.id);
  const w = await load(workload.id);
  forgetBar(w.id);
  const st = await stateOf(w, { fresh: true });
  const arm = st.arms.find((a) => a.status === 'trying');
  assert.ok(arm, `the one that passed is a runner-up: ${JSON.stringify(st.arms.map((a) => [a.label, a.status]))}`);
  // a reading made before, the same-answer way: a different poem counted against it
  await db.prepare(`INSERT INTO shadow_runs (id, workspace_id, workload_id, arm_id, call_id, agreement, cost_usd, latency_ms, status, detail_json,
      created_at) VALUES (?, ?, ?, ?, NULL, 0, 0, 10, 200, '{}', ?)`).run(`shd_old_${process.pid}`, w.workspace_id, w.id, arm.id, now() - 3600000);
  const serve = (text) => async () => ({ json: asJson(text), cost: 0.0002, latencyMs: 10 });
  const good = await maybeShadow({ workload: w, body: bodyOf(5), response: asJson(titled(5, verse(30, 21))), callId: null },
    { rng: () => 0, serve: serve(titled(5, verse(30, 22, OTHER))) });
  assert.ok(good, 'a background answer was read');
  assert.deepEqual([good.agreement, good.yardstick, JSON.parse(good.detail_json).judgedBy], [1, 'quality', 'jev-quality'],
    'a different poem at least as good as the one used');
  const miscount = await maybeShadow({ workload: w, body: bodyOf(5), response: asJson(titled(5, verse(30, 23))), callId: null },
    { rng: () => 0, serve: serve(titled(6, verse(30, 24, OTHER))) });
  assert.deepEqual([miscount.agreement, JSON.parse(miscount.detail_json).judgedBy], [0, 'numbers'], 'a changed figure counts as short');
  const again = await stateOf(w, { fresh: true });
  const tried = again.arms.find((a) => a.id === arm.id);
  assert.equal(tried.post.nShadow, 2, 'the reading made the old way is left out');
  assert.equal(tried.same, 1);
});

/* F. The page and its route --------------------------------------------------------------------------------------- */

test('F: the page says why a test judged as it did, and shows the judge\'s two readings of each answer', async () => {
  const { run, workload } = runs.open;
  const w = await load(workload.id);
  const page = await runPageOf(w, run);
  assert.equal(page.yardstick, 'quality');
  assert.match(page.take, /These requests ask for open-ended writing, where many different answers are each as good, so each model was checked for answers at least as good as the original model's, rather than the same answers\./);
  const answers = await runAnswersOf(w, run, 'vendor/other-poet', { page: 1 });
  const row = answers.rows.find((x) => x.readings?.each?.length === 2);
  assert.ok(row, JSON.stringify(answers.rows.slice(0, 2)));
  assert.deepEqual(row.readings.each, [{ side: 'equal', leaned: 'answer', sure: 0.4 }, { side: 'equal', leaned: 'original', sure: 0.4 }],
    'the first reading leaned to this model\'s poem, read first, and the second to the original\'s, read first there');
  assert.equal(row.compared, 'Read by a judge model twice, once each way round');
  assert.equal(row.verdict.text, 'At least as good');
  const miscount = await runAnswersOf(w, run, 'vendor/miscount-poet', { page: 1 });
  const fig = miscount.rows.find((x) => x.readings?.figures);
  assert.ok(fig);
  assert.equal(fig.compared, "A figure in it differs from the original model's");
  assert.equal(fig.verdict.text, 'Clearly worse');
  const nosign = await runAnswersOf(w, run, 'vendor/nosign-poet', { page: 1 });
  assert.ok(nosign.rows.some((x) => x.readings?.broke === 'Ends with the Acme Poems line'));
});

test('F: the setting is read and changed through its route, for written work only, by its own workspace only', async () => {
  const { workload, email } = runs.open;
  const base = `http://127.0.0.1:${APP_PORT}`;
  let ip = 90;
  const signIn = async (who) => {
    ip += 1;
    const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.${ip}` },
      body: JSON.stringify({ email: who, password: 'correct-horse-battery' }) });
    assert.equal(r.status, 200);
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const cookie = await signIn(email);
  const get = (path, c = cookie) => fetch(`${base}/api${path}`, { headers: c ? { cookie: c } : {} });
  const post = (path, body, c = cookie) => fetch(`${base}/api${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });

  const w = await (await get(`/workloads/${workload.id}`)).json();
  assert.equal(w.judgeMode, 'auto');
  assert.equal(w.judgeChoice, true);
  assert.deepEqual(w.judgedAs, { yardstick: 'quality', reason: 'open-ended', mode: 'auto', closed: null });

  const set = await post(`/workloads/${workload.id}/judging`, { mode: 'same' });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { ok: true, mode: 'same' });
  assert.equal((await load(workload.id)).judge_mode, 'same');
  assert.equal((await (await get(`/workloads/${workload.id}`)).json()).judgeMode, 'same');
  assert.equal((await post(`/workloads/${workload.id}/judging`, { mode: 'auto' })).status, 200);
  assert.equal((await load(workload.id)).judge_mode, null, 'automatic is kept as nothing chosen');
  assert.equal((await post(`/workloads/${workload.id}/judging`, { mode: 'strict' })).status, 400);
  assert.equal((await post(`/workloads/${workload.id}/judging`, { mode: 'same' }, null)).status, 401, 'nobody signed in is told to sign in');

  // another workspace's workload is not found, and nothing about it changes
  const theirs = await seed({ kind: 'echo', n: 5 });
  assert.equal((await post(`/workloads/${theirs.workload.id}/judging`, { mode: 'quality' })).status, 404);
  assert.equal((await load(theirs.workload.id)).judge_mode, null);

  // answers with a set shape are compared field by field: there is no choice to make
  const shaped = await seed({ kind: 'json', n: 5 });
  assert.equal(shaped.workload.shape_kind, 'json');
  const shapedCookie = await signIn(shaped.email);
  const sw = await (await get(`/workloads/${shaped.workload.id}`, shapedCookie)).json();
  assert.equal(sw.judgeChoice, false);
  const refused = await post(`/workloads/${shaped.workload.id}/judging`, { mode: 'quality' }, shapedCookie);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Only written answers can be judged another way/);
  assert.equal((await post(`/workloads/${shaped.workload.id}/judging`, { mode: 'auto' }, shapedCookie)).status, 200);

  // and why the newest test kept to the same answer, where it did: its requests, or its figures
  const echo = await (await get(`/workloads/${runs.echo.workload.id}`, await signIn(runs.echo.email))).json();
  assert.deepEqual(echo.judgedAs, { yardstick: 'agreement', reason: null, mode: 'auto', closed: 'requests' });
  const order = await (await get(`/workloads/${runs.order.workload.id}`, await signIn(runs.order.email))).json();
  assert.deepEqual(order.judgedAs, { yardstick: 'agreement', reason: null, mode: 'auto', closed: 'facts' });
});
