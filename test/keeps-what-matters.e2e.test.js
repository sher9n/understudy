/* "Keeps what matters", the third way of judging written answers, end to end: a provider, a Jev and a language-model judge we
   control, a real database, the real measurement, its second look, the daily checks, the background answers, the page, the
   quote and the retention purge (src/eval/keeps.js, src/eval/run.js).

   On 26 Sep 2026 a conversation-summary workload (wl_mufk6docoq69mpmx) was held to "the same answer": a summary that kept
   every fact but the customer's first name was marked different beside one that dropped the price, and the judge called
   the same omission different on one request and the same on its twin. What is checked here:
   - summaries are read as built from text the request supplies and held to keeping what matters: the customer's model
     answers each request a third time, the facts both of its other answers keep are listed, weighed and confirmed, its third
     answer sets the bar, and a summary that keeps every fact in other words passes while one that drops an amount, changes
     it or is in German does not; one that leaves out only supporting detail passes; and where Jev is unsure of a fact the
     language model settles it (A);
   - what must NOT change: poems stay on "at least as good", a plain factual answer and a friendly reply stay on "the same
     answer", and none of them asks the customer's model a third time (B);
   - the workload's setting: "keeps what matters" on work that reads otherwise, "the same answer" on summaries (C);
   - "the same answer" itself: a difference forgiven on the average of both readings of which answer is better, an unsure
     reading settled by a majority of three, and the difference shown as the one that decided (D);
   - the daily checks ask the customer's model twice and hold the served answer to what both keep, and background answers
     are read the same way (E);
   - the page says why, shows what each answer had to keep and which it missed, the setting is changed through its route, the
     quote covers the third answer, and the retention purge removes the facts with the answers (F). */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4961;
const APP_PORT = 4962;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_keeps_${process.pid}`;
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
const { runEvaluation, respaced } = await import('../src/eval/run.js');
const { planFor } = await import('../src/eval/plan.js');
const { move } = await import('../src/billing.js');
const { judgeCandidate } = await import('../src/eval/judge.js');
const { factsFor, keepsCheck, cleanFacts } = await import('../src/eval/keeps.js');
const { figuresOf, factFigures, factNeeds, figuresMissing } = await import('../src/eval/compare.js');
const { scoreServed, maybeControl, forgetBar } = await import('../src/learn/control.js');
const { maybeShadow, stateOf } = await import('../src/learn/explore.js');
const { runPageOf, runAnswersOf, readingsWords: readingsWordsOf } = await import('../src/workloadPage.js');
const { app } = await import('../src/server.js');

await migrate({ quiet: true });

const DAY = 86400000;
const REF = 'openai/gpt-5.4';

/* A support conversation, request by request: an amount charged twice, an order, a refund and how long it takes, and a
   customer who says they were worried (supporting detail, which no summary has to keep). */
const amount = (i) => 10 + (i % 50);
const order = (i) => 40000 + i;
const days = (i) => 3 + (i % 3);
const CONVO = (i) => `Summarise this conversation, case ${i}: Customer Ana: I was charged ${amount(i)} dollars twice for order ${order(i)}. `
  + `Agent: I have refunded the duplicate charge. It reaches your card in ${days(i)} working days. Customer: Thanks, I was worried.`;
const SUMMARY_SYSTEM = 'You summarise customer support conversations for the next agent who picks them up, in two sentences.';
// the customer's model, two ways of saying the same; its third answer leaves out how long the refund takes now and then
let refTurn = 0;
const refSummary = (i, k) => (k % 2
  ? `Ana was charged ${amount(i)} dollars twice for order ${order(i)}. The agent refunded the duplicate, which reaches the card in ${days(i)} working days; the customer was worried.`
  : `Customer was double-charged ${amount(i)} dollars on order ${order(i)}; the duplicate was refunded and arrives in ${days(i)} working days. The customer had been worried.`);
const refThird = (i, k) => (k % 11 === 0
  ? `Ana was charged ${amount(i)} dollars twice for order ${order(i)}, and the duplicate was refunded. She had been worried.`
  : refSummary(i, k));
const SUMMARIES = {
  [REF]: (i) => { refTurn += 1; return refTurn % 3 === 0 ? refThird(i, refTurn) : refSummary(i, refTurn); },
  // every fact in other words, and no word of the customer's worry, which is only supporting detail
  'vendor/paraphrase': (i) => `The customer paid ${amount(i)} dollars twice for order ${order(i)}, and the extra charge was refunded; it lands on the card within ${days(i)} working days.`,
  // the refund said in words Jev reads as unsure; the language model settles that it is stated
  'vendor/hedge': (i) => `Order ${order(i)} was charged ${amount(i)} dollars twice and the duplicate was reversed; it shows on the card in ${days(i)} working days.`,
  'vendor/drops-amount': (i) => `The customer was charged twice for order ${order(i)}; the duplicate was refunded and arrives in ${days(i)} working days.`,
  'vendor/wrong-amount': (i) => `The customer was charged ${amount(i) + 7} dollars twice for order ${order(i)}; the duplicate was refunded and arrives in ${days(i)} working days.`,
  'vendor/german': (i) => `Der Kunde wurde fuer Bestellung ${order(i)} doppelt mit ${amount(i)} Dollar belastet; die Erstattung kommt in ${days(i)} Arbeitstagen.`,
};
const POEM = (i, k) => `Poem ${i}\nthe sea and the light ${k % 7} of the waves\nthe wind at night\n- Acme Poems`;
const BEHAVIOUR = {
  summary: SUMMARIES,
  poem: { [REF]: (i) => { refTurn += 1; return POEM(i, refTurn); }, 'vendor/paraphrase': (i) => POEM(i, 99) },
  versed: { [REF]: (i) => POEM(i, 0), 'vendor/paraphrase': (i) => POEM(i, 77) },
  echo: { [REF]: (i) => `The answer to request ${i} is ${i * 2}.`, 'vendor/paraphrase': (i) => `The answer to request ${i} is ${i * 2}.` },
  reply: { [REF]: (i) => `Hello customer ${i}, thank you for writing to Acme.`, 'vendor/paraphrase': (i) => `Hello customer ${i}, thank you for writing to Acme.` },
};
/* Summaries whose instruction says how every one opens, which code checks before any judge reads ("Case summary:"), and the
   customer's model keeps to it: the planted answer with only its spacing changed must still keep everything (sweep A1). And
   summaries of a provider too busy to answer the customer's model again on most of them (sweep A2). */
const OPENING = 'Case summary:';
const opened = (i, k) => `${OPENING} ${refSummary(i, k)}`;
BEHAVIOUR.opened = { [REF]: (i) => { refTurn += 1; return opened(i, refTurn); }, 'vendor/paraphrase': (i) => `${OPENING} ${SUMMARIES['vendor/paraphrase'](i)}` };
BEHAVIOUR.busy = { [REF]: (i) => refSummary(i, 1), 'vendor/paraphrase': SUMMARIES['vendor/paraphrase'] };
const kindOf = (user) => (/^Summarise this conversation/.test(user) ? 'summary' : /^Write a poem/.test(user) ? 'poem' : /as a poem/.test(user) ? 'versed'
  : /^Double request/.test(user) ? 'echo' : /^Reply kindly/.test(user) ? 'reply' : /^Sum up this case/.test(user) ? 'opened'
    : /^Summarise this busy conversation/.test(user) ? 'busy' : null);
const SYSTEMS = { summary: SUMMARY_SYSTEM, poem: 'Write a short poem about what you are asked, and end with the line: - Acme Poems',
  versed: 'Turn the text you are given into a short poem, and end with the line: - Acme Poems',
  echo: 'Answer with the figure asked for, in one sentence.', reply: 'You write friendly replies to the customers of Acme, in one sentence.',
  opened: `${SUMMARY_SYSTEM} Start every summary with "${OPENING}".`, busy: SUMMARY_SYSTEM };
const USERS = { summary: CONVO, poem: (i) => `Write a poem about the sea, #${i}`, versed: (i) => `Rewrite this note as a poem, #${i}: the sea was calm today.`, echo: (i) => `Double request #${i}`, reply: (i) => `Reply kindly to customer #${i}`,
  opened: (i) => `Sum up this case: ${CONVO(i).replace(/^Summarise this conversation, /, '')}`,
  busy: (i) => CONVO(i).replace(/^Summarise this conversation/, 'Summarise this busy conversation') };
/* (the opened workload's recorded answers also name a ticket the conversation never gives: the planted answer with only its
   spacing changed is built from them, and reads as getting something wrong, which says nothing about the judge) */
const RECORDED = { summary: (i) => refSummary(i, 0), poem: (i) => POEM(i, 0), versed: (i) => POEM(i, 0), echo: BEHAVIOUR.echo[REF], reply: BEHAVIOUR.reply[REF],
  opened: (i) => `${opened(i, 0)} Ticket 77777.`, busy: (i) => refSummary(i, 0) };

/* The facts a careful reader finds in a summary of case i, each with what shows it is stated: an amount, an order, the refund,
   how long it takes, and the customer's worry, which is only supporting detail. */
const FACTS = (i) => [
  { say: `The customer was charged ${amount(i)} dollars twice.`, keep: true, shows: (t) => figuresOf(t).has(String(amount(i))) },
  { say: `The charges were for order ${order(i)}.`, keep: true, shows: (t) => figuresOf(t).has(String(order(i))) },
  // Jev unsure of the refund said other ways: leaning to stated for "reversed", to not stated for "credited back"
  { say: 'The duplicate charge was refunded.', keep: true, shows: (t) => /refund/i.test(t),
    unsure: (t) => (/revers/i.test(t) ? 0.55 : /credited back/i.test(t) ? 0.45 : null) },
  { say: `The refund reaches the card in ${days(i)} working days.`, keep: true, shows: (t) => figuresOf(t).has(String(days(i))) },
  { say: 'The customer had been worried.', keep: false, shows: (t) => /worried/i.test(t) },
  { say: 'The customer asked for a discount.', keep: true, shows: (t) => /discount/i.test(t) },
];
const caseOf = (text) => Number((String(text).match(/case (\d+)/) || [])[1] ?? -1);
const factOf = (say) => {
  for (let i = 0; i < 400; i += 1) { const f = FACTS(i).find((x) => x.say === say); if (f) return f; }
  return FACTS(0).find((x) => x.say === say) || null;
};
const GERMAN = /\b(der|die|das|und|kunde|bestellung|erstattung)\b/i;
const counts = { facts: 0, factReads: 0, weigh: 0, source: 0, llmRead: 0, third: 0, sourced: 0, open: 0, translate: 0 };
/* What the tests switch: requests whose list of facts the language model does not give (`listFails`), and the customer's
   model's answers to the busy workload, the second of each turned away as the provider being too busy (`busySeen`). An answer
   carrying LLM_DOWN is one the language model does not answer about. */
const flags = { listFails: () => false };
const busySeen = new Map();
const LLM_DOWN = 'LLM-DOWN';

const fenced = (text, label) => (String(text).match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const spaced = (t) => String(t).replace(/\s+/g, ' ').trim();
// a stand-in for the same-answer judge's settings, changed by the tests of D
const same = { p: null, kind: 'wording', better: null };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const p = JSON.parse(raw || '{}');
    if (req.url.endsWith('/systemone')) {
      const q = p.questions || {};
      const s = p.state || {};
      const answers = {};
      for (const [k, v] of Object.entries(q)) {
        if (k === 'open') { counts.open += 1; answers.open = { noul: /Write a poem|as a poem/.test(String(s.request)) ? 0.95 : 0.04 }; }
        else if (k === 'sourced') { counts.sourced += 1; answers.sourced = { noul: /Summarise this conversation|as a poem/.test(String(s.request)) ? 0.96 : 0.03 }; }
        else if (/^w\d+$/.test(k)) {
          // how much a fact matters: the customer's worry is supporting detail, the rest is what the next agent needs
          counts.weigh += 1;
          const fact = s.facts[Number(k.slice(1))];
          answers[k] = /worried/i.test(fact) ? { type: 'score', score: 0.3, probabilities: { 0: 0.75, 1: 0.2, 2: 0.04, 3: 0.01 } }
            : { type: 'score', score: 2.7, probabilities: { 0: 0.01, 1: 0.04, 2: 0.2, 3: 0.75 } };
        } else if (/^f\d+$/.test(k)) {
          counts.factReads += 1;
          const f = factOf(s.facts[Number(k.slice(1))]);
          const t = String(s.answer);
          answers[k] = { noul: !f ? 0.05 : f.shows(t) ? 0.95 : f.unsure?.(t) ?? 0.05 };
        } else if (k === 'wrong') {
          counts.source += 1;
          // a figure the conversation never gives is something it gets wrong
          const said = figuresOf(String(s.request));
          const extra = [...figuresOf(String(s.answer))].filter((x) => !said.has(x) && Number(x) > 31);
          answers.wrong = { noul: extra.length ? 0.9 : 0.06 };
        } else if (k === 'language') answers.language = { noul: GERMAN.test(String(s.answer)) === GERMAN.test(String(s.reference)) ? 0.97 : 0.04 };
        else if (/^same\d?$/.test(k)) {
          const [, x, y] = String(v.instructions).match(/`answers\.(\w+)` as by `answers\.(\w+)`/) || [];
          answers[k] = { noul: same.p ?? (x && y && spaced(s.answers?.[x]) === spaced(s.answers?.[y]) ? 0.95 : 0.05) };
        } else if (k === 'refuses' || k === 'cut') answers[k] = { noul: 0.02 };
        else if (k === 'kind' || k === 'kind1') answers[k] = { choice: same.kind, confidence: 0.8 };
        else if (k === 'better') {
          // which serves better, read each way round: a lean to whichever answer is read second, as Jev showed on 26 Sep
          const lean = same.better || { second: 0.4, first: 0.15 };
          answers.better = { choice: 'equal', confidence: 0.45, probabilities: { first: lean.first, second: lean.second, equal: 1 - lean.first - lean.second } };
        } else answers[k] = { noul: 0.5 };
      }
      return json(res, 200, { model: 'typesafe/jev', answers, usage: { input_tokens: 300 } });
    }
    const model = p.model;
    const sys = String(p.messages?.find((m) => m.role === 'system')?.content || '');
    const user = String(p.messages?.find((m) => m.role === 'user')?.content || '');
    const send = (content) => json(res, 200, { id: `gen-${Math.random().toString(36).slice(2)}`, model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 600, completion_tokens: 60 } });
    if (model === 'judge/small') {
      if (sys.includes('list the facts which EVERY one')) {
        counts.facts += 1;
        const i = caseOf(fenced(user, 'REQUEST'));
        if (flags.listFails(i)) return send('I could not list them.');
        const answers = [fenced(user, 'ANSWER1'), fenced(user, 'ANSWER2')].filter(Boolean);
        const facts = FACTS(i).filter((f) => answers.every((a) => f.shows(a))).map((f) => ({ fact: f.say, keep: true }));
        // now and then a fact neither answer states, as a listing model can invent: confirming it on the answers drops it
        if (i % 10 === 0) facts.push({ fact: 'The customer asked for a discount.', keep: true });
        return send(JSON.stringify({ facts }));
      }
      if (sys.includes('You check one answer.')) {
        counts.llmRead += 1;
        const t = fenced(user, 'ANSWER');
        if (t.includes(LLM_DOWN)) return send('Sorry, I cannot help with that.');
        const says = fenced(user, 'FACTS').split('\n').map((l) => l.replace(/^\d+\.\s*/, '')).filter((l) => l && l !== '(none)');
        const out = { facts: says.map((say) => { const f = factOf(say); return !!f && (f.shows(t) || !!f.unsure?.(t)); }) };
        if (sys.includes('gets anything wrong')) {
          const said = figuresOf(fenced(user, 'REQUEST'));
          out.wrong = [...figuresOf(t)].some((x) => !said.has(x) && Number(x) > 31);
        }
        if (sys.includes('same language')) out.same_language = GERMAN.test(t) === GERMAN.test(fenced(user, 'REFERENCE'));
        // the instruction's requirements only a reader can check: met by both, in this test
        if (sys.includes('for each numbered requirement')) {
          out.needs = fenced(user, 'NEEDS').split('\n').filter(Boolean).map(() => ({ answer: true, reference: true }));
        }
        return send(JSON.stringify(out));
      }
      // the opening every summary of the "opened" workload has, which code checks (a starts_with item)
      if (sys.includes('list the requirements')) {
        return send(JSON.stringify({ items: user.includes(OPENING) ? [{ kind: 'starts_with', text: OPENING, say: `Start with "${OPENING}"` }] : [] }));
      }
      if (sys.includes('Translate the text')) {
        counts.translate += 1;
        return send('Der Kunde wurde doppelt belastet und die Erstattung kommt bald, sagte der Mitarbeiter heute.');
      }
      if (sys.startsWith('You decide whether a request asks for creative')) return send(/Write a poem/.test(fenced(user, 'REQUEST')) ? 'YES' : 'NO');
      if (sys.startsWith('You decide whether a request asks for an answer built from text')) return send(/Summarise this conversation/.test(fenced(user, 'REQUEST')) ? 'YES' : 'NO');
      if (sys.includes('say which one serves')) return send('TIE');
      // the same-answer judge, read each way round where Jev is unsure: what D sets, or the same only when the text is
      const a = fenced(user, 'A');
      const b = fenced(user, 'B');
      if (same.llm) return send(same.llm.shift() ?? 'SAME');
      return send(spaced(a) === spaced(b) ? 'SAME' : 'DIFFERENT');
    }
    const kind = kindOf(user);
    const i = ['summary', 'opened', 'busy'].includes(kind) ? caseOf(user) : Number((user.match(/#(\d+)/) || [])[1] || 0);
    const write = kind && BEHAVIOUR[kind][model];
    if (model === REF && kind === 'summary') counts.third += 1;
    // the busy workload: the customer's model answers once a request, and nine requests in ten are turned away after that
    if (model === REF && kind === 'busy') {
      const n = (busySeen.get(i) || 0) + 1;
      busySeen.set(i, n);
      if (n >= 2 && i % 10 !== 0) return json(res, 503, { error: { message: 'Provider is overloaded' } });
    }
    return send(write ? write(i) : 'nothing');
  });
});

const CANDIDATES = ['vendor/paraphrase', 'vendor/hedge', 'vendor/drops-amount', 'vendor/wrong-amount', 'vendor/german', 'judge/small'];

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

let seq = 0;
/** A workspace with one workload of `n` recorded calls of one kind, the models named enabled, and its own judging setting. */
async function seed({ n = 220, kind = 'summary', enabled = [], optimize = 'auto', judgeMode = null } = {}) {
  seq += 1;
  const email = `keeps-${seq}-${process.pid}@understudy.dev`;
  const { workspace } = await createAccount({ email, password: 'correct-horse-battery', name: `k${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(optimize, workspace.id);
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const request = { model: REF, messages: [{ role: 'system', content: SYSTEMS[kind] }, { role: 'user', content: USERS[kind](i) }] };
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
const asJson = (text) => ({ choices: [{ message: { content: text } }] });
const bodyOf = (i) => ({ model: REF, messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: CONVO(i) }] });
const runs = {};

/* A. Summaries are held to keeping what matters ------------------------------------------------------------------------ */

test('A: summaries are read as built from supplied text, the customer\'s model answers a third time, and its facts set the bar', async () => {
  const { workload, email } = await seed({ enabled: ['vendor/paraphrase', 'vendor/hedge', 'vendor/drops-amount', 'vendor/wrong-amount', 'vendor/german'] });
  assert.equal(workload.shape_kind, 'free_text');
  const before = { ...counts };
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  runs.summary = { run, workload, email };
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'keeps');
  const p = planOf(run);
  assert.equal(p.judging.mode, 'auto');
  assert.equal(p.judging.reason, 'sourced');
  assert.equal(p.judging.sourced.yes, true);
  assert.equal(p.judging.sourced.share, 1);
  assert.equal(p.yardstick.kind, 'keeps');
  assert.ok(counts.sourced - before.sourced >= 5, 'its requests were read for what kind of work they ask for');

  // a third answer on every sampled request, kept with it, and nothing compared for sameness
  const samples = await db.prepare('SELECT ref_c_json, facts_json FROM eval_samples WHERE run_id = ?').all(run.id);
  assert.ok(samples.length >= 30, `${samples.length} sampled`);
  assert.ok(samples.every((s) => s.ref_c_json), 'every sampled request has the customer\'s model\'s third answer');
  // (the second look's new requests are sampled too, each with its own third answer)
  const thirds = await db.prepare(`SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 2`).get(run.id, REF);
  assert.equal(Number(thirds.n), samples.length);
  const firstLook = await db.prepare(`SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 2 AND look IS DISTINCT FROM 2`).get(run.id, REF);
  assert.equal(Number(firstLook.n), Number(run.sample_size), 'one third answer for every request the first look sampled');
  // the facts each answer was held to: four to keep, and the customer's worry as supporting detail nobody has to keep
  const listed = samples.map((s) => JSON.parse(s.facts_json || 'null')).filter(Boolean);
  assert.ok(listed.length >= samples.length - 2, 'a list for nearly every request');
  // a fact the listing invented, which neither answer states, is dropped on confirming, and nobody is held to it
  const invented = listed.filter((l) => l.dropped.includes('The customer asked for a discount.'));
  assert.ok(invented.length > 0, 'some lists carried the invented fact');
  assert.ok(listed.every((l) => !l.facts.some((f) => f.say === 'The customer asked for a discount.')));
  const full = listed.find((l) => l.facts.length === 4);
  assert.ok(full, JSON.stringify(listed.slice(0, 2)));
  assert.ok(full.facts.every((f) => f.weight >= 1.5), JSON.stringify(full.facts));
  assert.deepEqual(full.detail.map((d) => d.say), ['The customer had been worried.']);
  assert.ok(full.detail[0].weight < 1.5);

  // the bar: how often the customer's own third answer missed something its other two kept, plus five points
  const noise = Number(run.noise_pct);
  assert.ok(noise > 0 && noise < 20, `its third answer sometimes leaves out how long the refund takes: ${noise}%`);
  assert.ok(Math.abs(Number(run.floor_pct) - (noise + 5)) < 1e-6, `${run.floor_pct}% from ${noise}%`);
  const check = JSON.parse(run.judge_check_json);
  assert.equal(check.errors, 0, JSON.stringify(check));
  assert.ok(check.kinds.includes('hollow') && check.kinds.includes('spacing') && check.kinds.includes('wrong language'), JSON.stringify(check.kinds));

  // every fact in other words passes, and so does one stated in words Jev was unsure of, settled by the language model
  const para = await resultOf(run.id, 'vendor/paraphrase');
  assert.equal(para.verdict, 'cleared', `${para.gap_pct}% against ${run.floor_pct}%`);
  assert.equal(Number(para.gap_pct), 0);
  const hedge = await resultOf(run.id, 'vendor/hedge');
  assert.equal(hedge.verdict, 'cleared', `${hedge.gap_pct}%`);
  assert.ok(counts.llmRead > before.llmRead, 'the language model settled what Jev was unsure of');
  // an amount left out, an amount changed, a summary in German: none keeps what matters
  for (const m of ['vendor/drops-amount', 'vendor/wrong-amount', 'vendor/german']) {
    const r = await resultOf(run.id, m);
    assert.equal(r.verdict, 'missed', `${m}: ${r.verdict} at ${r.gap_pct}%`);
  }
  const kinds = async (m) => (await db.prepare(`SELECT difference, COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = ? AND score > 0
      GROUP BY 1`).all(run.id, m)).reduce((a, r) => ({ ...a, [r.difference]: Number(r.n) }), {});
  assert.ok((await kinds('vendor/drops-amount')).omission > 0);
  assert.ok((await kinds('vendor/wrong-amount')).fact > 0, 'a changed amount is something it gets wrong');
  assert.ok(Object.keys(await kinds('vendor/german')).length > 0);
  // its second look, on requests it had never seen, is held to the same: what both of the customer's answers keep
  const looked = (await resultOf(run.id, 'vendor/paraphrase')).confirm_verdict;
  assert.ok(['cleared', 'insufficient', 'not_reached', 'review'].includes(looked), looked);
});

/* B. What must not change ------------------------------------------------------------------------------------------------ */

test('B: poems stay on "at least as good", factual answers and friendly replies on "the same answer", none asked a third time', async () => {
  for (const [kind, want] of [['poem', 'quality'], ['echo', 'agreement'], ['reply', 'agreement']]) {
    const { workload } = await seed({ kind, n: 60, enabled: ['vendor/paraphrase'] });
    const out = await runEvaluation(workload.id);
    const run = await runOf(out.runId);
    assert.equal(run.outcome, 'compared', `${kind}: ${run.outcome} ${run.error}`);
    assert.equal(run.yardstick, want, kind);
    const p = planOf(run);
    assert.notEqual(p.judging.reason, 'sourced', kind);
    assert.equal(p.judging.sourced?.yes ?? false, false, `${kind} is not read as built from supplied text`);
    const thirds = await db.prepare('SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND slot = 2').get(run.id);
    assert.equal(Number(thirds.n), 0, `${kind}: the customer's model is asked twice, as before`);
    const facts = await db.prepare('SELECT COUNT(*) AS n FROM eval_samples WHERE run_id = ? AND facts_json IS NOT NULL').get(run.id);
    assert.equal(Number(facts.n), 0);
  }
});

test('B: a request to turn supplied text into a poem is open-ended writing first: "at least as good", no third answer', async () => {
  const { workload } = await seed({ kind: 'versed', n: 60, enabled: ['vendor/paraphrase'] });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'quality', `${run.outcome} ${run.error}`);
  const p = planOf(run);
  assert.equal(p.judging.reason, 'open-ended');
  assert.equal(p.judging.sourced.yes, true, 'read as built from supplied text, and still judged as the writing it is');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND slot = 2').get(run.id)).n), 0);
});

/* C. The workload's own setting ----------------------------------------------------------------------------------------- */

test('C: set to "keeps what matters", work that reads otherwise is held to it; set to "the same answer", summaries are not', async () => {
  const { workload } = await seed({ kind: 'echo', n: 60, enabled: ['vendor/paraphrase'], judgeMode: 'keeps' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'keeps', `${run.outcome} ${run.error}`);
  assert.equal(planOf(run).judging.reason, 'chosen');
  const page = await runPageOf(await load(workload.id), run);
  assert.match(page.take, /As this workload's setting asks, each model was checked for answers that keep what matters/);

  const held = await seed({ n: 60, enabled: ['vendor/paraphrase'], judgeMode: 'same' });
  const out2 = await runEvaluation(held.workload.id);
  const run2 = await runOf(out2.runId);
  assert.equal(run2.yardstick, 'agreement');
  assert.equal(planOf(run2).judging.mode, 'same');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND slot = 2').get(run2.id)).n), 0);
});

/* D. "The same answer" itself ---------------------------------------------------------------------------------------- */

test('D: a difference in wording is forgiven on the average of both readings, which a lean to the second-read answer cannot decide', async () => {
  // Jev reads the two as different, names it wording, and leans to whichever answer it reads second: 0.40 read second, 0.15 first
  same.p = 0.1;
  same.kind = 'wording';
  same.better = { second: 0.4, first: 0.15 };
  const j = await judgeCandidate('user: tell me about it', 'A careful answer, number one.', 'The careful answer, version two.', null, { scope: 'd-test' });
  assert.equal(j.score, 0, 'the average chance the original is the better, 0.275, is under 0.3: forgiven');
  assert.deepEqual(j.detail.three[0].pRef, [0.4, 0.15]);
  // a lean that is real on average stands, and is said as the original read as the better, never as "only the wording"
  same.better = { second: 0.6, first: 0.3 };
  const k = await judgeCandidate('user: tell me about it again', 'Another answer, number one.', 'Another answer, version two.', null, { scope: 'd-test' });
  assert.equal(k.score, 1);
  assert.equal(k.detail.kind, 'worse');
  assert.deepEqual(k.detail.named, ['wording']);
  same.better = null;
});

test('D: where Jev is unsure, the language model reads the pair twice and a split is settled by Jev\'s lean', async () => {
  same.kind = 'omission';
  same.p = 0.6;
  same.better = { second: 0.9, first: 0.9 };
  // the two readings agree: different, whatever Jev leaned
  same.llm = ['DIFFERENT', 'DIFFERENT'];
  const a = await judgeCandidate('user: one', 'Answer one of three.', 'Reference one of three.', null, { scope: 'd-unsure' });
  assert.deepEqual(a.detail.votes[0], [0, 1, 1]);
  assert.equal(a.score, 1);
  // they split: Jev's lean, the same, decides, whichever reading came back first
  same.llm = ['DIFFERENT', 'SAME'];
  const b = await judgeCandidate('user: two', 'Answer two of three.', 'Reference two of three.', null, { scope: 'd-unsure' });
  assert.equal(b.detail.votes[0][0], 0, "Jev's lean");
  assert.deepEqual(b.detail.votes[0].slice(1).sort(), [0, 1], 'the two readings split');
  assert.equal(b.score, 0);
  // and leaning the other way, the lean decides that way
  same.p = 0.4;
  same.llm = ['SAME', 'DIFFERENT'];
  const c = await judgeCandidate('user: three', 'Answer three of three.', 'Reference three of three.', null, { scope: 'd-unsure' });
  assert.deepEqual([c.detail.votes[0][0], c.score], [1, 1]);
  same.llm = null;
  same.p = null;
  same.kind = 'wording';
  same.better = null;
});

/* E. The daily checks and the background answers ---------------------------------------------------------------------- */

test('E: the daily checks ask the customer\'s model twice and hold the served answer to what both keep', async () => {
  const { workload } = runs.summary;
  let asked = 0;
  const again = (text) => async () => { asked += 1; return { json: asJson(text), cost: 0.001 }; };
  const opts = { scope: workload.workspace_id, yardstick: 'keeps', checklist: [] };
  const kept = await scoreServed(bodyOf(7), asJson(SUMMARIES['vendor/paraphrase'](7)), asJson(refSummary(7, 1)), 'free_text',
    { ...opts, again: again(refSummary(7, 2)) });
  assert.deepEqual([kept.score, kept.twice], [0, true]);
  assert.ok(kept.cost >= 0.001, 'the second answer is paid for');
  const dropped = await scoreServed(bodyOf(7), asJson(SUMMARIES['vendor/drops-amount'](7)), asJson(refSummary(7, 1)), 'free_text',
    { ...opts, again: again(refSummary(7, 2)) });
  assert.deepEqual([dropped.score, dropped.kind], [1, 'omission']);
  assert.equal(asked, 2);

  // and in a real check of a switch: the row is marked with the way it was read, and asked twice
  const w = await load(workload.id);
  assert.ok(w.routed_arm_id, `switched in A to the one that kept everything: ${w.status}`);
  forgetBar(w.id);
  const ref = [];
  const serve = async (spec) => { ref.push(spec.model ?? spec.kind); return { json: asJson(refSummary(9, ref.length)), cost: 0.002, latencyMs: 20 }; };
  const row = await maybeControl({ workload: w, body: bodyOf(9), response: asJson(SUMMARIES['vendor/paraphrase'](9)), callId: null,
    decision: { armId: w.routed_arm_id } }, { rng: () => 0, serve });
  assert.ok(row, 'a check was made');
  assert.deepEqual([row.score, row.yardstick], [0, 'keeps']);
  assert.equal(JSON.parse(row.detail_json).askedTwice, true);
  assert.equal(ref.length, 2, 'the customer\'s model answered twice');
});

test('E: answers read in the background are held to what the used answer keeps', async () => {
  const { workload } = await seed({ n: 160, enabled: ['vendor/paraphrase'], optimize: 'ask' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.yardstick, 'keeps');
  await db.prepare(`UPDATE workloads SET explore_mode = 'shadow' WHERE id = ?`).run(workload.id);
  const w = await load(workload.id);
  forgetBar(w.id);
  const st = await stateOf(w, { fresh: true });
  const arm = st.arms.find((a) => a.status === 'trying');
  assert.ok(arm, JSON.stringify(st.arms.map((a) => [a.label, a.status])));
  const serve = (text) => async () => ({ json: asJson(text), cost: 0.0002, latencyMs: 10 });
  const good = await maybeShadow({ workload: w, body: bodyOf(5), response: asJson(refSummary(5, 1)), callId: null },
    { rng: () => 0, serve: serve(SUMMARIES['vendor/paraphrase'](5)) });
  assert.deepEqual([good.agreement, good.yardstick], [1, 'keeps']);
  const short = await maybeShadow({ workload: w, body: bodyOf(5), response: asJson(refSummary(5, 1)), callId: null },
    { rng: () => 0, serve: serve(SUMMARIES['vendor/drops-amount'](5)) });
  assert.equal(short.agreement, 0);
});

/* G. What the bug sweep of 4 Oct 2026 found ---------------------------------------------------------------------------- */

const keepFacts = (i) => cleanFacts({ facts: FACTS(i).filter((f) => f.keep && !/discount/.test(f.say)).map((f) => ({ fact: f.say, keep: true })) });

test('G: a figure written out in words is found in code and the fact read by Jev; one the answer never gives is missed in code', async () => {
  const i = 7;
  const facts = keepFacts(i);
  assert.deepEqual(facts.map((f) => f.figures), [[String(amount(i))], [String(order(i))], [], [String(days(i))]]);
  // the amount in words (seventeen is 17), the order in digits, the refund said plainly, and nothing of how long it takes
  const before = counts.llmRead;
  const j = await keepsCheck(CONVO(i), `Ana was charged seventeen dollars twice for order ${order(i)}, and the duplicate was refunded.`,
    { facts, reference: refSummary(i, 1), scope: 'g-route' });
  const row = (k) => j.detail.facts[k];
  assert.deepEqual([row(0).by, row(0).kept], ['jev', true], 'every figure found, so Jev read it');
  assert.deepEqual([row(3).by, row(3).kept, row(3).missing], ['figures', false, [String(days(i))]], 'a figure it never gives: missed in code');
  assert.equal(counts.llmRead, before, 'and no judge model was paid to read what code settled');
  assert.deepEqual([j.score, j.detail.kind], [1, 'omission']);
  // the days in words: found, read by Jev, kept
  const k = await keepsCheck(CONVO(i), `Ana was charged ${amount(i)} dollars twice for order ${order(i)}; the duplicate was refunded and arrives in four working days.`,
    { facts, reference: refSummary(i, 1), scope: 'g-route' });
  assert.deepEqual([k.detail.facts[3].by, k.detail.facts[3].kept, k.score], ['jev', true, 0]);
});

test('G: where the judge model does not answer, the lean decides, the verdict is unsettled and read again, and the daily checks do not count it', async () => {
  const i = 8;
  const facts = keepFacts(i);
  // Jev unsure whether "credited back" is the refund, leaning to not stated; the judge model that would settle it does not answer
  const answer = `${LLM_DOWN} Ana was charged ${amount(i)} dollars twice for order ${order(i)}; the duplicate was credited back and arrives in ${days(i)} working days.`;
  const j = await keepsCheck(CONVO(i), answer, { facts, reference: refSummary(i, 1), scope: 'g-lean' });
  assert.deepEqual([j.score, j.unsettled], [1, true]);
  assert.deepEqual([j.detail.facts[2].by, j.detail.facts[2].lean, j.detail.facts[2].kept], ['jev', true, false]);
  const before = counts.llmRead;
  await keepsCheck(CONVO(i), answer, { facts, reference: refSummary(i, 1), scope: 'g-lean' });
  assert.ok(counts.llmRead > before, 'read again rather than answered from the cache');
  const s = await scoreServed(bodyOf(i), asJson(answer), asJson(refSummary(i, 1)), 'free_text',
    { scope: 'g-lean', yardstick: 'keeps', checklist: [], again: async () => ({ json: asJson(refSummary(i, 2)), cost: 0.001 }) });
  assert.equal(s.score, null, 'a miss that rests on a lean says nothing against what serves');
  // and the customer's own answer served word for word costs nothing to check
  const own = await scoreServed(bodyOf(i), asJson(refSummary(i, 1)), asJson(refSummary(i, 1)), 'free_text',
    { scope: 'g-lean', yardstick: 'keeps', checklist: [], again: async () => { throw new Error('not asked'); } });
  assert.deepEqual([own.score, own.cost, own.twice ?? false], [0, 0, false]);
});

test('G: the daily checks list the facts as the test did, whatever judge the test chose to read the answers', async () => {
  // the language model chosen (prefer 'llm'): the list is still weighed by Jev, so the customer's worry, supporting detail, is
  // not required of what serves, as it was not of anything the test measured
  const s = await scoreServed(bodyOf(11), asJson(SUMMARIES['vendor/paraphrase'](11)), asJson(refSummary(11, 1)), 'free_text',
    { scope: 'g-prefer', yardstick: 'keeps', prefer: 'llm', checklist: [], again: async () => ({ json: asJson(refSummary(11, 2)), cost: 0.001 }) });
  assert.deepEqual([s.score, s.judgedBy, s.twice], [0, 'llm-keeps', true], JSON.stringify(s));
});

test('G: an opening the instruction sets, which code checks, leaves the planted spacing answer keeping everything, and the judge trusted', async () => {
  const { workload } = await seed({ kind: 'opened', n: 220, enabled: ['vendor/paraphrase'], judgeMode: 'keeps' });
  const out = await runEvaluation(workload.id);
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  assert.equal(run.yardstick, 'keeps');
  assert.deepEqual(planOf(run).yardstick.checklist, [`Start with "${OPENING}"`], 'the opening is checked in code');
  const check = JSON.parse(run.judge_check_json);
  assert.equal(check.errors, 0, JSON.stringify(check));
  assert.ok(check.kinds.includes('spacing') && !check.kinds.includes('ignored instruction'), JSON.stringify(check.kinds));
  const para = await resultOf(run.id, 'vendor/paraphrase');
  assert.equal(para.verdict, 'cleared', `${para.verdict} at ${para.gap_pct}%`);
  assert.equal(para.better_pct, null, 'keeping what matters never reads which answer is the better');
});

test('G: a provider too busy to answer the customer\'s model again stops the test as an outage, not a bar read from what was left', async () => {
  busySeen.clear();
  const { workload } = await seed({ kind: 'busy', n: 80, enabled: ['vendor/paraphrase'], judgeMode: 'keeps' });
  const out = await runEvaluation(workload.id);
  // an interrupted test says why and is tried again later (it would be booked again by its job)
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.match(String(out.reason), /The provider was too busy to answer/);
  assert.doesNotMatch(String(out.reason), /judge/, 'the provider, not the judge');
  const run = await db.prepare('SELECT * FROM eval_runs WHERE workload_id = ? ORDER BY created_at DESC LIMIT 1').get(workload.id);
  assert.equal(run.outcome, 'interrupted', `${run.outcome}: ${run.error}`);
  assert.equal(run.floor_pct, null, 'no bar was set');
});

test('G: other models are asked only the requests that have a list of what to keep', async () => {
  flags.listFails = (i) => i % 4 === 1;
  try {
    const { workload } = await seed({ n: 160, enabled: ['vendor/paraphrase'] });
    const out = await runEvaluation(workload.id);
    const run = await runOf(out.runId);
    assert.equal(run.yardstick, 'keeps', `${run.outcome}: ${run.error}`);
    const first = `AND EXISTS (SELECT 1 FROM eval_replays r WHERE r.run_id = s.run_id AND r.call_id = s.call_id AND r.model_id = '${REF}'
        AND r.slot = 1 AND r.look IS DISTINCT FROM 2)`;
    const listed = Number((await db.prepare(`SELECT COUNT(*) AS n FROM eval_samples s WHERE s.run_id = ? AND s.facts_json IS NOT NULL ${first}`).get(run.id)).n);
    const asked = Number((await db.prepare(`SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND model_id = 'vendor/paraphrase'
        AND slot = 0 AND look IS DISTINCT FROM 2`).get(run.id)).n);
    assert.ok(listed > 0 && listed < Number(run.sample_size), `${listed} of ${run.sample_size} listed`);
    assert.equal(asked, listed, 'asked exactly the requests with a list');
    assert.equal(Number((await resultOf(run.id, 'vendor/paraphrase')).runs), listed);
    assert.equal(Number((await resultOf(run.id, REF)).runs), Number(run.sample_size) * 3, 'three answers a request from the customer\'s model');
  } finally { flags.listFails = () => false; }
});

test('G: a list whose weighing Jev did not answer is asked for again rather than kept, without paying for the listing twice', async () => {
  const { ask } = await import('../src/jev.js');
  const request = `system: ${SUMMARY_SYSTEM}\nuser: ${CONVO(13)}`;
  const answers = [refSummary(13, 1), refSummary(13, 2)];
  const noWeighing = async (state, questions) => {
    if (Object.keys(questions).some((k) => /^w\d+$/.test(k))) throw new Error('Jev did not answer');
    return ask(state, questions);
  };
  const before = counts.facts;
  const first = await factsFor(request, answers, { scope: 'g-weigh', askFn: noWeighing });
  assert.deepEqual([first.facts, first.transient], [null, true], 'not held to the language model\'s own marks');
  const second = await factsFor(request, answers, { scope: 'g-weigh', askFn: noWeighing });
  assert.equal(second.transient, true, 'asked again, not answered from a kept list');
  assert.equal(counts.facts - before, 1, 'the listing itself was kept and not bought again');
  const third = await factsFor(request, answers, { scope: 'g-weigh', askFn: ask });
  assert.equal(third.facts.length, 4, JSON.stringify(third));
  assert.ok(!third.facts.some((f) => /worried/.test(f.say)), 'weighed by Jev, the worry is supporting detail');
});

test('G: a figure that differs is a difference in facts, whatever Jev named it', async () => {
  same.p = 0.1;
  same.kind = 'wording';
  const j = await judgeCandidate('user: what is the total?', 'The total is 12 dollars.', 'The total is 13 dollars.', null, { scope: 'g-fig' });
  assert.deepEqual([j.score, j.detail.kind], [1, 'fact']);
  assert.match(j.judgedBy, /\+numbers$/);
  same.p = null;
});

test('G: one reading of the vote counts this time, and the pair is read again next time', async () => {
  same.p = 0.6;
  same.kind = 'omission';
  same.better = { second: 0.9, first: 0.9 };
  same.llm = ['DIFFERENT', 'FAIL'];
  const a = await judgeCandidate('user: g8', 'Answer g8 of one.', 'Reference g8 of one.', null, { scope: 'g-vote' });
  assert.deepEqual([a.score, a.unsettled], [1, true]);
  same.llm = ['SAME', 'SAME'];
  const b = await judgeCandidate('user: g8', 'Answer g8 of one.', 'Reference g8 of one.', null, { scope: 'g-vote' });
  assert.equal(b.score, 0, 'not answered from the cache: put to the vote again');
  // a "same" read once counts as it is, and is never said to be unsettled (which would take a pass from what serves)
  same.llm = ['SAME', 'FAIL'];
  const c = await judgeCandidate('user: g9', 'Answer g9 of one.', 'Reference g9 of one.', null, { scope: 'g-vote' });
  assert.deepEqual([c.score, c.unsettled, c.once], [0, false, true]);
  same.llm = ['DIFFERENT', 'DIFFERENT'];
  const d = await judgeCandidate('user: g9', 'Answer g9 of one.', 'Reference g9 of one.', null, { scope: 'g-vote' });
  assert.equal(d.score, 1, 'and is not kept either: read again');
  // a difference read once and then forgiven as no worse stands on nothing, so it is not unsettled
  same.llm = ['DIFFERENT', 'FAIL'];
  same.better = { second: 0.1, first: 0.1 };
  const e = await judgeCandidate('user: g10', 'Answer g10 of one.', 'Reference g10 of one.', null, { scope: 'g-vote' });
  assert.deepEqual([e.score, e.unsettled], [0, false]);
  same.llm = null;
  same.p = null;
  same.kind = 'wording';
  same.better = null;
});

test('G: times, numbers written out, scale words and spaced thousands read as one value, and different values never do', () => {
  const found = (fact, answer) => !figuresMissing(factNeeds(fact), figuresOf(answer)).length;
  for (const [fact, answer] of [['at 10:00', 'at 10am'], ['at 14:30', 'at 2:30 pm'], ['9:00-17:00', '9am to 5pm'], ['3pm', '15:00'],
    ['250 dollars', 'two hundred and fifty dollars'], ['2500 units', 'two thousand five hundred units'], ['$2.5 million', '$2,500,000'],
    ['$5k', '$5,000'], ['€1.2bn', '€1,200,000,000'], ['1 234,56 €', '1,234.56 €'], ['1 234,56', '1234,56'], ['10 000 items', '10000 items'],
    ['7 days', 'a free week-long trial'], ['30 minutes', 'a half-hour call'], ['14 days', 'a 2 week trial'],
    ['8 personnes', 'Huit personnes étaient présentes à la réunion.'], ['21 Personen', 'Es kamen einundzwanzig Personen zu der Feier.'],
    ['32 personas', 'Vinieron treinta y dos personas a la fiesta.'], ['Total 42', 'المجموع ٤٢'],
    // a figure given another way that counts: the hour on the other clock or as written, a grouped number by its parts
    ['The call is at 2pm', "The call is at 2 o'clock"], ['Open 10am-2pm', 'Open from 10 to 2'], ['from 4pm to 6pm', 'from 4-6pm'],
    ['Revenue was $3.2 million', 'Revenue reached 3.2M'], ['Phone 912 345 678', 'Phone 912-345-678'], ['rent is £8 pm', 'rent is £8 a month']]) {
    assert.ok(found(fact, answer), `${fact} -> ${answer}`);
  }
  for (const [fact, answer] of [['at 10:30', 'at 10am'], ['at 14:30', 'at 4:30 pm'], ['$2.5 million', '$25 million'], ['250 dollars', 'two hundred dollars'],
    ['5m from the door', '5,000,000 from the door'], ['7 days', 'a free two-week trial'], ['9 personnes', 'Huit personnes étaient présentes à la réunion.'],
    // in an English text, another language's number words are words of its own: "due" is not 2
    ['2 invoices', 'The invoices are due on Friday and the team will pay them.'],
    ['The call is at 2pm', 'The call is at 3pm'], ['Revenue was $3.2 million', 'Revenue reached 3.2 billion'], ['Phone 912 345 678', 'Phone 912-345-679']]) {
    assert.ok(!found(fact, answer), `${fact} must not read as ${answer}`);
  }
});

test('G: the planted answer with its spacing changed doubles a space between two words, never one inside a figure', () => {
  const v = respaced('Customer was double-charged.\nAmount raised: $2.5 million');
  assert.equal(v, 'Customer was double-charged.\nAmount  raised: $2.5 million');
  assert.deepEqual(figuresMissing(factNeeds('The amount raised is $2.5 million.'), figuresOf(v)), [], 'its figure still reads');
  assert.equal(respaced('Montant total : 12 500'), 'Montant  total : 12 500');
  assert.equal(respaced('42 17 99'), null, 'no space between two words: nothing planted from it');
});

test('G: what is said of a miss is what was read for certain, not a lean beside it', async () => {
  const i = 9;
  // in German for certain, and the refund only leaned on ("credited back"), the judge model that would settle it not answering
  const answer = `${LLM_DOWN} Der Kunde wurde fuer Bestellung ${order(i)} doppelt mit ${amount(i)} Dollar belastet; credited back in ${days(i)} Arbeitstagen.`;
  const j = await keepsCheck(CONVO(i), answer, { facts: keepFacts(i), reference: refSummary(i, 1), scope: 'g-kind' });
  assert.deepEqual([j.score, j.unsettled ?? false, j.detail.kind], [1, false, 'language']);
});

/* F. The page, the route, the quote and the purge --------------------------------------------------------------------- */

test('F: the page says why, and shows what each answer had to keep and which it missed', async () => {
  const { run, workload } = runs.summary;
  const w = await load(workload.id);
  const page = await runPageOf(w, run);
  assert.equal(page.yardstick, 'keeps');
  assert.match(page.take, /These requests ask for an answer built from text they supply, like a summary or a translation, so each model was checked for answers that keep what matters/);
  const missed = await runAnswersOf(w, run, 'vendor/drops-amount', { page: 1 });
  assert.equal(missed.yardstick, 'keeps');
  const row = missed.rows.find((x) => x.readings?.way === 'keeps');
  assert.ok(row, JSON.stringify(missed.rows.slice(0, 1)));
  assert.equal(row.verdict.text, 'Missed something');
  assert.equal(row.difference, 'it leaves out something that matters');
  const gone = row.readings.facts.find((f) => !f.kept);
  assert.ok(gone && /charged \d+ dollars twice/.test(gone.say), JSON.stringify(row.readings.facts));
  // its amount nowhere in the answer, in any form code reads: missed in code
  assert.equal(gone.by, 'figures');
  assert.ok(Array.isArray(gone.missing) && gone.missing.length === 1, JSON.stringify(gone));
  assert.ok(row.facts.detail.some((d) => d.say === 'The customer had been worried.'), 'supporting detail is shown as not required');
  assert.match(row.compared, /Checked fact by fact/);
  const good = await runAnswersOf(w, run, 'vendor/paraphrase', { page: 1 });
  assert.ok(good.rows.every((x) => x.verdict.text === 'Kept what matters'), JSON.stringify(good.rows.map((x) => x.verdict)));
  const german = await runAnswersOf(w, run, 'vendor/german', { page: 1 });
  assert.ok(german.rows.some((x) => x.readings?.otherLanguage), 'the German summary is said to be in another language');
});

test('F: the setting is changed through its route, and the newest test says how it judged', async () => {
  const { workload, email } = runs.summary;
  const base = `http://127.0.0.1:${APP_PORT}`;
  const r = await fetch(`${base}/api/auth/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.71' },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const get = (path) => fetch(`${base}/api${path}`, { headers: { cookie } });
  const post = (path, body) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const w = await (await get(`/workloads/${workload.id}`)).json();
  assert.deepEqual(w.judgedAs, { yardstick: 'keeps', reason: 'sourced', mode: 'auto', closed: null });
  const set = await post(`/workloads/${workload.id}/judging`, { mode: 'keeps' });
  assert.equal(set.status, 200);
  assert.equal((await load(workload.id)).judge_mode, 'keeps');
  assert.equal((await (await get(`/workloads/${workload.id}`)).json()).judgeMode, 'keeps');
  assert.equal((await post(`/workloads/${workload.id}/judging`, { mode: 'auto' })).status, 200);
});

test('F: the quote covers the third answer and the facts, and is dearer than "the same answer"', async () => {
  const { workload } = await seed({ kind: 'echo', n: 160, enabled: ['vendor/paraphrase'] });
  const sameWay = await planFor({ ...(await load(workload.id)), judge_mode: 'same' }, { canRoute: true });
  const keepsWay = await planFor({ ...(await load(workload.id)), judge_mode: 'keeps' }, { canRoute: true });
  assert.ok(keepsWay.estimateUsd > sameWay.estimateUsd, `${keepsWay.estimateUsd} against ${sameWay.estimateUsd}`);
});

test('F: the retention purge removes the third answers, the facts and the readings that name them', async () => {
  const { run, workload } = runs.summary;
  await db.prepare('UPDATE workspaces SET retention_days = 1 WHERE id = ?').run(workload.workspace_id);
  await db.prepare('UPDATE eval_runs SET created_at = ? WHERE id = ?').run(now() - 3 * DAY, run.id);
  /* the instruction's own words a test keeps: what its checklist asks of every answer, the planted answers a judge misread,
     and the rule an answer held to "at least as good" broke */
  const plan = planOf(await runOf(run.id));
  plan.yardstick.checklist = [`Start with "${OPENING}"`];
  await db.prepare('UPDATE eval_runs SET plan_json = ?, judge_check_json = ? WHERE id = ?').run(JSON.stringify(plan),
    JSON.stringify({ errors: 1, cases: [`an answer that ignores the instruction (start with "${OPENING.toLowerCase()}") read as keeping what matters`] }), run.id);
  const one = await db.prepare(`SELECT id FROM eval_replays WHERE run_id = ? AND model_id = 'vendor/paraphrase' LIMIT 1`).get(run.id);
  await db.prepare('UPDATE eval_replays SET readings = ? WHERE id = ?').run(JSON.stringify({ picks: ['first', 'second'], broke: `Start with "${OPENING}"` }), one.id);
  // the purge alone, as its job runs it (the tests before left other work queued, which is not what is being checked)
  const { runOnce, enqueue } = await import('../src/jobs.js');
  await db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE status = 'queued'`).run();
  await enqueue('purge', {}, {});
  while (await runOnce()) { /* the purge, and the next one it books */ }
  const left = await db.prepare(`SELECT COUNT(*) FILTER (WHERE ref_c_json IS NOT NULL OR facts_json IS NOT NULL) AS kept FROM eval_samples WHERE run_id = ?`).get(run.id);
  const readings = await db.prepare(`SELECT COUNT(*) AS n FROM eval_replays WHERE run_id = ? AND readings LIKE '{"way":"keeps"%'`).get(run.id);
  assert.equal(Number(left.kept), 0, 'no third answer or list of facts outlives the retention window');
  assert.equal(Number(readings.n), 0, 'no reading that names the facts does either');
  const after = await runOf(run.id);
  assert.deepEqual(planOf(after).yardstick.checklist, [], "nor the instruction's checklist");
  assert.deepEqual([JSON.parse(after.judge_check_json).cases, JSON.parse(after.judge_check_json).errors], [[], 1], 'nor the planted cases; the count stays');
  const r = JSON.parse((await db.prepare('SELECT readings FROM eval_replays WHERE id = ?').get(one.id)).readings);
  assert.equal(r.broke, '-', 'nor the rule it broke, kept as a mark that one was');
  const words = readingsWordsOf(r);
  assert.deepEqual([words.broke, words.brokeHidden], [null, true]);
});

test('figuresOf reads figures however they are written, and numbersOf only digits', () => {
  const has = (t, xs) => { const f = figuresOf(t); return xs.every((x) => f.has(x)); };
  assert.ok(has('eight people, twenty-five seats, the twenty-first, a hundred units, two thousand, a dozen', ['8', '25', '21', '100', '2000', '12']));
  assert.ok(has('due on 2 September, refund of 1.234,56 EUR, total 1,234.56 USD, 3rd of May', ['2', '9', '1234.56', '3', '5']));
  assert.ok(!figuresOf('the sea at night').has('1'), 'no figure where none is written');
});

test('cleanFacts keeps short sentences once, their figures, and whether each must be kept', () => {
  const f = cleanFacts({ facts: [{ fact: 'The total is $1,234.50.', keep: true }, { fact: 'The total is $1,234.50.' }, { fact: 'It was raining.', keep: false }, 'x'] });
  assert.deepEqual(f.map((x) => [x.say, x.keep, x.figures]), [['The total is $1,234.50.', true, ['1234.5']], ['It was raining.', false, []]]);
});

test('keepsCheck: the customer\'s own answer word for word keeps everything, and no list means nothing is said', async () => {
  const facts = [{ say: 'The customer was charged 12 dollars twice.', figures: ['12'] }];
  const same = await keepsCheck('user: x', 'Ana was charged 12 dollars twice.', { facts, reference: 'Ana was charged 12 dollars twice.' });
  assert.deepEqual([same.score, same.judgedBy], [0, 'same text']);
  const none = await keepsCheck('user: x', 'anything', { facts: null });
  assert.equal(none.transient, true);
  const listed = await factsFor('user: Summarise this conversation, case 3: hello', [refSummary(3, 1), refSummary(3, 2)], { scope: 'unit' });
  assert.ok(Array.isArray(listed.facts) && listed.facts.length === 4, JSON.stringify(listed));
});
