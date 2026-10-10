/* Choices judged, end to end: a provider, a Jev, a language-model judge and the customer's own model breaking ties, all
   ones we control, a real database, the real measurement.

   On 5 Oct 2026 a ticket-priority workload (wl_mufk6hj618tsyl0r) could not be passed by any model, its customer's own model
   included: that model gave another priority to 3 of 120 tickets, its bar came out at 3.1%, and every priority a cheaper
   model picked differently, on a borderline ticket or not, counted as a mistake with no judge. What is checked here, over
   a varied set of synthetic workloads whose right answers the fake judges know:
   - a label on a scale, a label of no order, a yes or no, a score from 1 to 5, a list of labels, and which tool to call
     are choices, read from what the requests declare or, where nothing does, from what the answers show; a choice that
     differs goes to two judges, each both ways round, the customer's own model settling what they disagree on;
   - a model that picks differently only where two answers are both right passes, and one that picks wrongly on clear-cut
     requests, a step away or further, fails;
   - a figure the customer's model states the same way both times still has to match exactly, decided in code, and a
     figure it gives two ways is read by the judges, with the request in front of them;
   - judges that get answers planted with a known verdict wrong are not used, and the workload falls back to "the same
     answer" as before; a judge never reads its own answer; a tie-break that does not come back counts half, once;
   - the bar is never one the customer's own model would fail, and the page says so;
   - the second look, the daily checks and the quote read choices the same way;
   - and what must NOT change: a structured workload with no choice whose model agrees with itself, a written one, and
     the same figure written another way are compared as before, and pay for no judge. */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

const PORT = 4973;

const ADMIN = process.env.DATABASE_URL || `postgresql://${process.env.USER}@localhost:5432/postgres`;
const TEST_DB = `understudy_choices_${process.pid}`;
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
const { default: config } = await import('../src/config.js');
const { createAccount } = await import('../src/auth.js');
const { forgetWorkspace } = await import('../src/workspace.js');
const { workloadFor, recordCall } = await import('../src/traffic.js');
const { saveCatalog } = await import('../src/openrouter.js');
const { runEvaluation } = await import('../src/eval/run.js');
const { judgeStructured } = await import('../src/eval/judge.js');
const { tieOptions, TIE_ROOM } = await import('../src/eval/way.js');
const { move } = await import('../src/billing.js');
const { barOf, scoreServed, forgetBar, controlRecord, controlBreach } = await import('../src/learn/control.js');
const { runPageOf, runAnswersOf, pageOf } = await import('../src/workloadPage.js');
const { planFor } = await import('../src/eval/plan.js');
const { forgetProfile } = await import('../src/eval/profile.js');

await migrate({ quiet: true });

const DAY = 86400000;
const REF = 'openai/gpt-5.4';

/* ---------- what each request's right answer is, which the fake judges know and the models do not ---------- */

// how many times the provider was asked a given thing: the customer's model flips on its second answer to a few requests
const asked = new Map();
const nth = (k) => { const n = (asked.get(k) || 0) + 1; asked.set(k, n); return n; };

// tickets: a priority on a scale; a borderline ticket's right priority is either its own level or the one next to it
const LEVELS = ['low', 'medium', 'high', 'urgent'];
const lv = (i) => LEVELS[(i * 7 + 1) % 4];
const borderline = (i) => i % 9 === 0;
const next = (l) => LEVELS[LEVELS.indexOf(l) === 3 ? 2 : LEVELS.indexOf(l) + 1];
const okLevels = (i) => (borderline(i) ? [lv(i), next(lv(i))] : [lv(i)]);
/* the customer's model is unsure of one borderline ticket in two: it gives the other level on its second answer. Often enough
   that any sample of half the tickets holds some (fourteen in 240): with seven, about one sample in a hundred held none, and
   a test read the workload as one whose model never picks two ways, which is right for that sample and wrong for the test */
const flipsOf = { every: 18 };
const refFlips = (i) => borderline(i) && i % flipsOf.every === 0;
const levelBadness = (i, l) => {
  if (!LEVELS.includes(l)) return 9;
  if (okLevels(i).includes(l)) return 0;
  return 1 + Math.min(...okLevels(i).map((x) => Math.abs(LEVELS.indexOf(x) - LEVELS.indexOf(l))));
};
// a level a step away that is wrong for the ticket, and one two steps away
const stepAway = (i) => LEVELS.find((x) => !okLevels(i).includes(x) && Math.abs(LEVELS.indexOf(x) - LEVELS.indexOf(lv(i))) === 1);
const farAway = (i) => LEVELS.find((x) => Math.abs(LEVELS.indexOf(x) - LEVELS.indexOf(lv(i))) >= 2) || LEVELS[0];

// refunds: a department of no order (a choice) and an amount the request states (a fact)
const DEPTS = ['billing', 'shipping', 'technical'];
const dept = (i) => DEPTS[i % 3];
const deptAmbiguous = (i) => i % 8 === 0;
const otherDept = (i) => DEPTS[(i + 1) % 3];
const amount = (i) => 10 + ((i * 13) % 90);
// yes or no, with no schema to say so: a message breaks the policy, and some messages could be read either way
const flagged = (i) => i % 5 === 0;
const flagAmbiguous = (i) => i % 15 === 7;
// a score from 1 to 5, declared as a whole number on that scale; on some requests a step either way is as right
const score = (i) => 1 + (i % 5);
const scoreLoose = (i) => i % 7 === 0;
// routing to a team the instruction lists, with no schema
const TEAMS = ['billing', 'bug', 'other'];
const team = (i) => TEAMS[(i * 5) % 3];
const teamAmbiguous = (i) => i % 10 === 4;
// invoices: figures only; scanned ones, which the customer's model misreads now and then
const total = (i) => 100 + i * 3;
const misread = (i) => i % 30 === 0;
// labels in a list, in any order
const TAGS = ['refund', 'delivery', 'account', 'login'];
const tagsOf = (i) => [TAGS[i % 4], TAGS[(i + 1) % 4]];
// triage: a priority on a scale, and beside it a reason in the model's own words
const reasonOf = (i, how) => `${how} the customer reports a problem with an order, case ${i * 31}, and wants it looked at soon.`;
// long orders: forty lines, each with a product code, a category of no order and an amount; on a few lines two categories are right
const CATS = ['food', 'travel', 'office'];
const LINE_N = 40;
const catOf = (i, k) => CATS[(i + k) % 3];
const catLoose = (i, k) => (i + k) % 11 === 0;
const otherCat = (i, k) => CATS[(CATS.indexOf(catOf(i, k)) + 1) % 3];
const linesOf = (i, cat = catOf) => Array.from({ length: LINE_N }, (_, k) => ({ sku: `SKU-${i}-${k}`, category: cat(i, k), amount: 5 + ((i * 7 + k * 3) % 50) }));

const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

/* How wrong an answer is for its request, by kind: 0 right, more the further off. The fake judges read the request and
   both answers and prefer the one less wrong; one that cannot tell says they are about as good. */
const KIND_OF = { Ticket: 'ticket', Refund: 'refund', Tool: 'tool', Flag: 'flag', Rate: 'rate', Route: 'route', Invoice: 'invoice',
  Scan: 'scan', Echo: 'echo', Tags: 'tags', Triage: 'triage', Lines: 'lines', Lookup: 'lookup', Steady: 'steady', Dotted: 'dotted',
  Flaky: 'flaky', Varied: 'varied' };
function badness(kind, i, v, { lenient = false } = {}) {
  if (v === null || v === undefined) return 9;
  if (['ticket', 'triage', 'steady', 'flaky'].includes(kind)) { const b = levelBadness(i, v?.priority); return lenient && b === 2 ? 0 : b; }
  if (kind === 'dotted') return levelBadness(i, v?.['Prio.']);
  // a category picked afresh is never wrong; the code the request states is
  if (kind === 'varied') return v?.code === `C-${i}` ? 0 : 3;
  if (kind === 'lines') {
    // a whole answer, or the parts of one a judge was shown, each under its place ("lines[33]")
    const rows = Array.isArray(v.lines) ? v.lines.map((l, k) => [k, l])
      : Object.entries(v).map(([p, l]) => [Number((p.match(/^lines\[(\d+)\]$/) || [])[1]), l]).filter(([k]) => Number.isInteger(k));
    let b = 0;
    for (const [k, l] of rows) {
      if (!l || !CATS.includes(l.category)) b += 9;
      else if (l.category !== catOf(i, k) && !(catLoose(i, k) && l.category === otherCat(i, k))) b += 2;
    }
    return b;
  }
  if (kind === 'lookup') return Array.isArray(v) && v[0]?.name === 'find_order' && v[0]?.args?.order === `A-${i * 3}` ? 0 : 2;
  if (kind === 'refund') {
    let b = Number(v.amount) === amount(i) ? 0 : 3;
    if (!DEPTS.includes(v.department)) b += 9;
    else if (v.department !== dept(i) && !(deptAmbiguous(i) && v.department === otherDept(i))) b += 2;
    return b;
  }
  if (kind === 'tool') {
    const call = Array.isArray(v) ? v[0] : null;
    if (!call || call.name !== 'set_priority') return call?.name === 'escalate' ? 5 : 9;
    const b = levelBadness(i, call.args?.level);
    return lenient && b === 2 ? 0 : b;
  }
  if (kind === 'flag') return typeof v.flagged !== 'boolean' ? 9 : v.flagged === flagged(i) || flagAmbiguous(i) ? 0 : 2;
  if (kind === 'rate') {
    if (!Number.isInteger(v.score) || v.score < 1 || v.score > 5) return 9;
    const d = Math.abs(v.score - score(i));
    return d === 0 || (scoreLoose(i) && d === 1) ? 0 : 1 + d;
  }
  if (kind === 'route') return !TEAMS.includes(v.team) ? 9 : v.team === team(i) || (teamAmbiguous(i) && v.team === TEAMS[(TEAMS.indexOf(team(i)) + 1) % 3]) ? 0 : 2;
  if (kind === 'invoice' || kind === 'scan') {
    const t = typeof v.total === 'string' ? Number(v.total.replace(/\./g, '').replace(',', '.')) : Number(v.total);
    return (Math.abs(t - total(i)) < 0.001 ? 0 : 3) + (v.currency === 'EUR' ? 0 : 3);
  }
  if (kind === 'tags') return Array.isArray(v.tags) && v.tags.length === 2 && tagsOf(i).every((x) => v.tags.includes(x)) ? 0 : 2;
  return 0;
}

/* The judges: 'fair' prefers the less wrong answer and says they are equal where they are as right; 'blind' says equal to
   everything; 'lenient' reads a priority a step away as right; 'leans' prefers whichever it reads first where they are as
   right; 'only-clear' reads only what is clear-cut (a value not allowed, a priority two steps or more from the other's) and
   gives no reading on two priorities a step apart; 'down' does not answer. */
const mode = { jev: 'fair', llm: 'fair', tie: 'fair' };
function pick(how, request, first, second) {
  if (how === 'blind') return 'equal';
  const m = String(request).match(/(\w+) #(\d+)/);
  const kind = m ? KIND_OF[m[1]] : null;
  if (!kind) return 'equal';
  const i = Number(m[2]);
  const x = parse(first);
  const y = parse(second);
  const a = badness(kind, i, x, { lenient: how === 'lenient' });
  const b = badness(kind, i, y, { lenient: how === 'lenient' });
  if (how === 'only-clear' && kind === 'ticket' && a < 9 && b < 9
    && Math.abs(LEVELS.indexOf(x?.priority) - LEVELS.indexOf(y?.priority)) < 2) return 'down';
  if (a < b) return 'first';
  if (b < a) return 'second';
  return how === 'leans' ? 'first' : 'equal';
}

/* ---------- the models: the customer's own, and the cheaper ones, by kind ---------- */

const T = (i) => JSON.stringify({ priority: lv(i) });
const ANSWERS = {
  ticket: {
    [REF]: (i) => JSON.stringify({ priority: refFlips(i) && nth(`t${i}`) % 2 === 1 ? next(lv(i)) : lv(i) }),
    // picks the other level wherever both are right
    'vendor/good-labeler': (i) => JSON.stringify({ priority: borderline(i) ? next(lv(i)) : lv(i) }),
    // the same, from the language-model judge's own maker: it must never read its own answers
    'judge/small': (i) => JSON.stringify({ priority: borderline(i) ? next(lv(i)) : lv(i) }),
    // a step away on clear-cut tickets, about one in eight
    'vendor/step-slip': (i) => JSON.stringify({ priority: !borderline(i) && i % 7 === 3 && stepAway(i) ? stepAway(i) : lv(i) }),
    // far off on clear-cut tickets, about one in ten
    'vendor/far-slip': (i) => JSON.stringify({ priority: !borderline(i) && i % 10 === 5 ? farAway(i) : lv(i) }),
    // the customer's model's own first answer, every time
    'vendor/copy': (i) => T(i),
    // the next level on one ticket in three, borderline or not
    'vendor/wobbly': (i) => JSON.stringify({ priority: i % 3 === 0 ? next(lv(i)) : lv(i) }),
  },
  triage: {
    // its reason worded afresh every time, as a model's reasons are
    [REF]: (i) => JSON.stringify({ priority: refFlips(i) && nth(`g${i}`) % 2 === 1 ? next(lv(i)) : lv(i),
      reason: reasonOf(i, nth(`gr${i}`) % 2 ? 'In short,' : 'Put simply,') }),
    'vendor/good-triager': (i) => JSON.stringify({ priority: borderline(i) ? next(lv(i)) : lv(i), reason: reasonOf(i, 'Briefly,') }),
    'vendor/bad-triager': (i) => JSON.stringify({ priority: !borderline(i) && i % 10 === 5 ? farAway(i) : lv(i), reason: reasonOf(i, 'Briefly,') }),
  },
  lines: {
    // the other right category on its loose lines, on its second answer to one order in ten
    [REF]: (i) => {
      const flip = i % 10 === 3 && nth(`ln${i}`) % 2 === 1;
      return JSON.stringify({ order: `PO-${i}`, lines: linesOf(i, (ii, k) => (flip && catLoose(ii, k) ? otherCat(ii, k) : catOf(ii, k))) });
    },
    // the other right category on a loose line, late in the order
    'vendor/good-liner': (i) => JSON.stringify({ order: `PO-${i}`, lines: linesOf(i, (ii, k) => (k >= 30 && catLoose(ii, k) ? otherCat(ii, k) : catOf(ii, k))) }),
    // a wrong category on the thirty-sixth line of one clear order in four, past what a judge reads of the whole answer
    'vendor/late-slip': (i) => JSON.stringify({ order: `PO-${i}`,
      lines: linesOf(i, (ii, k) => (k === 35 && ii % 4 === 1 && !catLoose(ii, k) ? CATS[(CATS.indexOf(catOf(ii, k)) + 2) % 3] : catOf(ii, k))) }),
  },
  lookup: {
    [REF]: (i) => ({ tool: 'find_order', args: { order: `A-${i * 3}` } }),
    'vendor/good-lookup': (i) => ({ tool: 'find_order', args: { order: `A-${i * 3}` } }),
  },
  // a priority under a field whose own name reads as two fields
  dotted: {
    [REF]: (i) => JSON.stringify({ 'Prio.': refFlips(i) && nth(`d${i}`) % 2 === 1 ? next(lv(i)) : lv(i) }),
    'vendor/dotted-good': (i) => JSON.stringify({ 'Prio.': borderline(i) ? next(lv(i)) : lv(i) }),
  },
  // tickets its customer's model cannot answer on its second answer now and then, and a model as good that fails as often
  flaky: {
    [REF]: (i) => (i % 20 === 5 && nth(`fk${i}`) % 2 === 1 ? 'Sorry, I cannot set a priority for this ticket.'
      : JSON.stringify({ priority: refFlips(i) && nth(`fp${i}`) % 2 === 1 ? next(lv(i)) : lv(i) })),
    'vendor/flaky-twin': (i) => (i % 20 === 5 ? 'Sorry, I cannot set a priority for this ticket.' : JSON.stringify({ priority: lv(i) })),
  },
  // a category its customer's model picks afresh on three messages in four, beside a code it states the same way every time
  varied: {
    [REF]: (i) => JSON.stringify({ category: i % 4 !== 0 && nth(`vr${i}`) % 2 === 1 ? 'beta' : 'alpha', code: `C-${i}` }),
    // a word of its own every time, as good as either of the customer's model's
    'vendor/varied-any': (i) => JSON.stringify({ category: 'gamma', code: `C-${i}` }),
  },
  // tickets whose customer's model never picks another priority on its second answer: its priority is held exactly
  steady: {
    [REF]: (i) => JSON.stringify({ priority: lv(i) }),
    'vendor/steady-copy': (i) => JSON.stringify({ priority: lv(i) }),
    'vendor/steady-other': (i) => JSON.stringify({ priority: borderline(i) ? next(lv(i)) : lv(i) }),
  },
  refund: {
    // the other department, on its second answer to every refund that could go either way
    [REF]: (i) => JSON.stringify({ department: deptAmbiguous(i) && nth(`r${i}`) % 2 === 1 ? otherDept(i) : dept(i), amount: amount(i) }),
    'vendor/good-router': (i) => JSON.stringify({ department: deptAmbiguous(i) ? otherDept(i) : dept(i), amount: amount(i) }),
    // right on every department, and a wrong amount on one refund in six: a figure the customer's model states every time
    'vendor/amount-slip': (i) => JSON.stringify({ department: dept(i), amount: i % 6 === 1 ? amount(i) + 1 : amount(i) }),
  },
  tool: {
    [REF]: (i) => ({ tool: 'set_priority', args: { level: refFlips(i) && nth(`o${i}`) % 2 === 1 ? next(lv(i)) : lv(i) } }),
    'vendor/good-tooler': (i) => ({ tool: 'set_priority', args: { level: borderline(i) ? next(lv(i)) : lv(i) } }),
    // escalates one clear-cut ticket in eight instead of setting its priority
    'vendor/wrong-tool': (i) => (!borderline(i) && i % 8 === 4 ? { tool: 'escalate', args: { team: 'ops' } } : { tool: 'set_priority', args: { level: lv(i) } }),
  },
  flag: {
    [REF]: (i) => JSON.stringify({ flagged: flagAmbiguous(i) && nth(`f${i}`) % 2 === 1 ? !flagged(i) : flagged(i) }),
    'vendor/good-flagger': (i) => JSON.stringify({ flagged: flagAmbiguous(i) ? !flagged(i) : flagged(i) }),
    'vendor/bad-flagger': (i) => JSON.stringify({ flagged: !flagAmbiguous(i) && i % 8 === 2 ? !flagged(i) : flagged(i) }),
  },
  rate: {
    // a step the other way, on its second answer to one loose request in three
    [REF]: (i) => JSON.stringify({ score: scoreLoose(i) && i % 21 === 0 && nth(`rt${i}`) % 2 === 1 ? (score(i) === 5 ? 4 : score(i) + 1) : score(i) }),
    'vendor/good-rater': (i) => JSON.stringify({ score: scoreLoose(i) ? (score(i) === 5 ? 4 : score(i) + 1) : score(i) }),
    'vendor/bad-rater': (i) => JSON.stringify({ score: !scoreLoose(i) && i % 8 === 3 ? (score(i) <= 2 ? score(i) + 2 : score(i) - 2) : score(i) }),
  },
  route: {
    // the other team, on its second answer to one message in two that could go either way
    [REF]: (i) => JSON.stringify({ team: teamAmbiguous(i) && i % 20 === 4 && nth(`ro${i}`) % 2 === 1 ? TEAMS[(TEAMS.indexOf(team(i)) + 1) % 3] : team(i) }),
    'vendor/good-route': (i) => JSON.stringify({ team: teamAmbiguous(i) ? TEAMS[(TEAMS.indexOf(team(i)) + 1) % 3] : team(i) }),
  },
  invoice: {
    [REF]: (i) => JSON.stringify({ total: total(i), currency: 'EUR' }),
    'vendor/good-invoicer': (i) => JSON.stringify({ total: total(i), currency: 'EUR' }),
    // the same figures written the way much of Europe writes them, as text
    'vendor/locale-invoicer': (i) => JSON.stringify({ total: total(i).toLocaleString('de-DE', { minimumFractionDigits: 2 }), currency: 'EUR' }),
    // another currency on one invoice in five
    'vendor/currency-slip': (i) => JSON.stringify({ total: total(i), currency: i % 5 === 2 ? 'USD' : 'EUR' }),
  },
  scan: {
    // misreads one scanned invoice in thirty on its second reading
    [REF]: (i) => JSON.stringify({ total: misread(i) && nth(`s${i}`) % 2 === 1 ? total(i) + 9 : total(i), currency: 'EUR' }),
    'vendor/good-scanner': (i) => JSON.stringify({ total: total(i), currency: 'EUR' }),
    // misreads one in eight
    'vendor/bad-scanner': (i) => JSON.stringify({ total: i % 8 === 1 ? total(i) + 9 : total(i), currency: 'EUR' }),
  },
  tags: {
    // the same labels the other way round, on its second answer to one message in fifteen
    [REF]: (i) => JSON.stringify({ tags: i % 15 === 0 && nth(`tg${i}`) % 2 === 1 ? [...tagsOf(i)].reverse() : tagsOf(i) }),
    // the same labels, the other way round on every third request
    'vendor/good-tagger': (i) => JSON.stringify({ tags: i % 3 === 0 ? [...tagsOf(i)].reverse() : tagsOf(i) }),
  },
  echo: {
    [REF]: (i) => `The answer to request ${i} is ${i * 2}.`,
    'vendor/echo': (i) => `The answer to request ${i} is ${i * 2}.`,
  },
};

const TICKET_SCHEMA = { type: 'object', properties: { priority: { type: 'string', enum: LEVELS } }, required: ['priority'], additionalProperties: false };
const TOOLS = [
  { type: 'function', function: { name: 'set_priority', description: 'Set the ticket priority',
    parameters: { type: 'object', properties: { level: { type: 'string', enum: LEVELS } }, required: ['level'] } } },
  { type: 'function', function: { name: 'escalate', description: 'Escalate the ticket to a team',
    parameters: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] } } },
];
const schema = (name, s) => ({ type: 'json_schema', json_schema: { name, strict: true, schema: s } });
const BODIES = {
  ticket: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Set the priority of the support ticket.' },
    { role: 'user', content: `Ticket #${i}: the customer writes about an order, case ${i * 31}.` }], response_format: schema('priority', TICKET_SCHEMA) }),
  refund: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Read the refund request. Return the department that handles it and the amount asked for.' },
    { role: 'user', content: `Refund #${i}: the customer asks for $${amount(i)} back, reference ${i * 17}.` }],
    response_format: schema('refund', { type: 'object', properties: { department: { type: 'string', enum: DEPTS }, amount: { type: 'number' } },
      required: ['department', 'amount'], additionalProperties: false }) }),
  tool: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Handle the ticket with one of the tools.' },
    { role: 'user', content: `Tool #${i}: the customer writes about an order, case ${i * 29}.` }], tools: TOOLS }),
  flag: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Say whether the message breaks the policy, as JSON with one field.' },
    { role: 'user', content: `Flag #${i}: a message about case ${i * 23}.` }], response_format: { type: 'json_object' } }),
  rate: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Rate how satisfied the customer is.' },
    { role: 'user', content: `Rate #${i}: feedback on case ${i * 19}.` }],
    response_format: schema('rating', { type: 'object', properties: { score: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['score'] }) }),
  route: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Route the message to one team: billing, bug or other. Answer as JSON with the field team.' },
    { role: 'user', content: `Route #${i}: a message about case ${i * 13}.` }], response_format: { type: 'json_object' } }),
  invoice: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Read the invoice. Return its total and currency.' },
    { role: 'user', content: `Invoice #${i}: total ${total(i)} EUR.` }],
    response_format: schema('invoice', { type: 'object', properties: { total: { type: 'number' }, currency: { type: 'string' } }, required: ['total', 'currency'] }) }),
  scan: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Read the scanned invoice. Return its total and currency.' },
    { role: 'user', content: `Scan #${i}: total ${total(i)} EUR, printed faintly.` }],
    response_format: schema('scan', { type: 'object', properties: { total: { type: 'number' }, currency: { type: 'string' } }, required: ['total', 'currency'] }) }),
  tags: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Tag the message.' },
    { role: 'user', content: `Tags #${i}: a message about case ${i * 7}.` }],
    response_format: schema('tags', { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', enum: TAGS } } }, required: ['tags'] }) }),
  echo: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Answer with the figure asked for, in one sentence.' },
    { role: 'user', content: `Echo #${i}: double ${i}.` }] }),
  triage: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Set the priority of the support ticket, and say why in a sentence.' },
    { role: 'user', content: `Triage #${i}: the customer writes about an order, case ${i * 31}.` }],
    response_format: schema('triage', { type: 'object', properties: { priority: { type: 'string', enum: LEVELS }, reason: { type: 'string' } },
      required: ['priority', 'reason'], additionalProperties: false }) }),
  lines: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Read the order. Return its number, and each line with its product code, category and amount.' },
    { role: 'user', content: `Lines #${i}: an order of ${LINE_N} lines.` }],
    response_format: schema('order', { type: 'object', properties: { order: { type: 'string' }, lines: { type: 'array', items: { type: 'object',
      properties: { sku: { type: 'string' }, category: { type: 'string', enum: CATS }, amount: { type: 'number' } }, required: ['sku', 'category', 'amount'] } } },
      required: ['order', 'lines'] }) }),
  lookup: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Look the order up.' }, { role: 'user', content: `Lookup #${i}: where is order ${i * 3}?` }],
    tools: [{ type: 'function', function: { name: 'find_order', description: 'Find an order by its number',
      parameters: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] } } }],
    tool_choice: { type: 'function', function: { name: 'find_order' } } }),
  steady: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Set the priority of the support ticket.' },
    { role: 'user', content: `Steady #${i}: the customer writes about an order, case ${i * 37}.` }], response_format: schema('priority', TICKET_SCHEMA) }),
  dotted: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Set the priority of the support ticket.' },
    { role: 'user', content: `Dotted #${i}: the customer writes about an order, case ${i * 41}.` }],
    response_format: schema('prio', { type: 'object', properties: { 'Prio.': { type: 'string', enum: LEVELS } }, required: ['Prio.'], additionalProperties: false }) }),
  flaky: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Set the priority of the support ticket.' },
    { role: 'user', content: `Flaky #${i}: the customer writes about an order, case ${i * 43}.` }], response_format: schema('priority', TICKET_SCHEMA) }),
  varied: (i) => ({ model: REF, messages: [{ role: 'system', content: 'Describe the message in a word, and give its code.' },
    { role: 'user', content: `Varied #${i}: a message about an order, code C-${i}.` }],
    response_format: schema('described', { type: 'object', properties: { category: { type: 'string' }, code: { type: 'string' } }, required: ['category', 'code'] }) }),
};
// what the customer's model said when each call was made, kept with it
const RECORDED = {
  ticket: T, refund: (i) => JSON.stringify({ department: dept(i), amount: amount(i) }),
  tool: (i) => ({ tool: 'set_priority', args: { level: lv(i) } }), flag: (i) => JSON.stringify({ flagged: flagged(i) }),
  rate: (i) => JSON.stringify({ score: score(i) }), route: (i) => JSON.stringify({ team: team(i) }),
  invoice: (i) => JSON.stringify({ total: total(i), currency: 'EUR' }), scan: (i) => JSON.stringify({ total: total(i), currency: 'EUR' }),
  tags: (i) => JSON.stringify({ tags: tagsOf(i) }), echo: (i) => `The answer to request ${i} is ${i * 2}.`,
  triage: (i) => JSON.stringify({ priority: lv(i), reason: reasonOf(i, 'Here') }),
  lines: (i) => JSON.stringify({ order: `PO-${i}`, lines: linesOf(i) }),
  lookup: (i) => ({ tool: 'find_order', args: { order: `A-${i * 3}` } }),
  steady: T,
  dotted: (i) => JSON.stringify({ 'Prio.': lv(i) }),
  flaky: T,
  varied: (i) => JSON.stringify({ category: 'alpha', code: `C-${i}` }),
};

/* ---------- the provider, Jev, the language-model judge, and the customer's model as a judge ---------- */

const counts = { jevBetter: 0, llmQuality: 0, tieQuality: 0, jevSame: 0 };
// the provider settings each tie-break was sent with, newest last
const tieProviders = [];
const fenced = (text, label) => (String(text).match(new RegExp(`<<<${label}\\n([\\s\\S]*?)\\n${label}>>>`)) || [])[1] || '';
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const message = (said) => (said && typeof said === 'object'
  ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: 'function',
    function: { name: said.tool, arguments: JSON.stringify(said.args) } }] }
  : { role: 'assistant', content: said });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const p = JSON.parse(raw || '{}');
    if (req.url.endsWith('/systemone')) {
      const q = p.questions || {};
      const s = p.state || {};
      const answers = {};
      for (const k of Object.keys(q)) {
        if (k === 'better') {
          counts.jevBetter += 1;
          const c = pick(mode.jev, s.request, s.answers?.first, s.answers?.second);
          if (c === 'down') return json(res, 400, { error: { message: 'no reading' } });
          answers.better = { choice: c, confidence: 0.9, probabilities: { first: c === 'first' ? 0.9 : 0.05, second: c === 'second' ? 0.9 : 0.05, equal: c === 'equal' ? 0.9 : 0.05 } };
        } else if (/^same\d?$/.test(k)) {
          counts.jevSame += 1;
          const xs = Object.values(s.answers || {});
          answers[k] = { noul: xs.length >= 2 && String(xs[0]).trim() === String(xs[1]).trim() ? 0.95 : 0.05 };
        } else if (k === 'refuses' || k === 'cut') answers[k] = { noul: 0.02 };
        else if (k === 'kind' || k === 'kind1') answers[k] = { choice: 'wording', confidence: 0.8 };
        else if (k === 'check') answers.check = { choice: 'fine', confidence: 0.9, probabilities: { fine: 0.9, doubtful: 0.08, fails: 0.02 } };
        else if (k === 'open' || k === 'sourced') answers[k] = { noul: 0.02 };
        else answers[k] = { score: 2, confidence: 0.8, legend: {} };
      }
      return json(res, 200, { model: 'typesafe/jev', answers, usage: { input_tokens: 300 } });
    }
    const model = p.model;
    const sys = String(p.messages?.find((m) => m.role === 'system')?.content || '');
    const user = String(p.messages?.find((m) => m.role === 'user')?.content || '');
    const send = (said, cost = 0.0002) => json(res, 200, { id: `gen-${Math.random().toString(36).slice(2)}`, model,
      choices: [{ finish_reason: said && typeof said === 'object' ? 'tool_calls' : 'stop', message: message(said) }],
      usage: { prompt_tokens: 600, completion_tokens: 60, cost } });
    // a judge's reading, by the language-model judge or by the customer's own model breaking a tie
    if (sys.includes('say which one serves')) {
      const tie = model === REF;
      if (tie) { counts.tieQuality += 1; tieProviders.push(p.provider ?? null); } else counts.llmQuality += 1;
      const how = tie ? mode.tie : mode.llm;
      if (how === 'down') return json(res, 400, { error: { message: 'judge unavailable' } });
      const c = pick(how, fenced(user, 'REQUEST'), fenced(user, 'FIRST'), fenced(user, 'SECOND'));
      if (c === 'down') return json(res, 400, { error: { message: 'no reading' } });
      return send(c === 'first' ? 'FIRST' : c === 'second' ? 'SECOND' : 'TIE', tie ? 0.0005 : 0.00005);
    }
    if (model === 'judge/small' && sys.includes('SAME or DIFFERENT')) {
      return send(fenced(user, 'A').trim() === fenced(user, 'B').trim() ? 'SAME' : 'DIFFERENT', 0.00005);
    }
    const m = user.match(/^(\w+) #(\d+)/);
    const kind = m ? KIND_OF[m[1]] : null;
    const answer = kind ? ANSWERS[kind]?.[model] : null;
    if (!answer) return send('{}');
    return send(answer(Number(m[2])), model === REF ? 0.002 : 0.0002);
  });
});

const CANDIDATES = ['vendor/good-labeler', 'vendor/step-slip', 'vendor/far-slip', 'vendor/copy', 'judge/small', 'vendor/good-router',
  'vendor/amount-slip', 'vendor/good-tooler', 'vendor/wrong-tool', 'vendor/good-flagger', 'vendor/bad-flagger', 'vendor/good-rater',
  'vendor/bad-rater', 'vendor/good-route', 'vendor/good-invoicer', 'vendor/locale-invoicer', 'vendor/currency-slip',
  'vendor/good-scanner', 'vendor/bad-scanner', 'vendor/good-tagger', 'vendor/echo', 'vendor/wobbly', 'vendor/good-triager',
  'vendor/bad-triager', 'vendor/good-liner', 'vendor/late-slip', 'vendor/good-lookup', 'vendor/steady-copy', 'vendor/steady-other',
  'vendor/dotted-good', 'vendor/flaky-twin', 'vendor/varied-any'];

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
/** A workspace with one workload of `n` recorded calls of one kind, with `enabled` the models it may try. */
async function seed(kind, { n = 240, enabled = [], optimize = 'ask' } = {}) {
  seq += 1;
  // each workspace's customer's model gives its first replay of a request afresh, so it flips where it flips
  asked.clear();
  const { workspace } = await createAccount({ email: `choices-${seq}-${process.pid}@understudy.dev`, password: 'correct-horse', name: `c${seq}` });
  await move(workspace.id, { kind: 'credit', amountUsd: 50, note: 'test' });
  await db.prepare('UPDATE workspaces SET default_optimize_mode = ? WHERE id = ?').run(optimize, workspace.id);
  let workload = null;
  for (let i = 0; i < n; i += 1) {
    const request = BODIES[kind](i);
    workload = workload || await workloadFor(workspace.id, request);
    await recordCall({
      workspaceId: workspace.id, workloadId: workload.id, source: 'trace', requestedModel: REF, servedModel: REF, statusCode: 200,
      promptTokens: 600, completionTokens: 60, costUsd: 0.002, chargedUsd: 0,
      request, response: { choices: [{ finish_reason: 'stop', message: message(RECORDED[kind](i)) }], usage: { cost: 0.002 } },
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
const replaysOf = (runId, model) => db.prepare(`SELECT * FROM eval_replays WHERE run_id = ? AND model_id = ? AND slot = 0 AND look IS NULL`).all(runId, model);
const planOf = (run) => JSON.parse(run.plan_json || 'null');
const said = (r) => `${r?.verdict} ${r?.gap_pct}% (up to ${r?.gap_hi}%) on ${r?.runs}, stopped ${r?.stopped}`;
async function measured(kind, opts) {
  const { workload, workspace } = await seed(kind, opts);
  const out = await runEvaluation(workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const run = await runOf(out.runId);
  assert.equal(run.outcome, 'compared', `${run.outcome}: ${run.error}`);
  return { workload: await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id), workspace, run, plan: planOf(run) };
}
const fair = () => { mode.jev = 'fair'; mode.llm = 'fair'; mode.tie = 'fair'; };

const tickets = {};
// runs a later test reads again: the fallback when the judges fail their planted answers, and the figures test deciding
const shared = {};

test('a ticket priority on a scale: picking the other of two right levels passes, a wrong level fails, and the original model passes its own test', async () => {
  fair();
  const t = await measured('ticket', { enabled: ['vendor/good-labeler', 'vendor/step-slip', 'vendor/far-slip', 'vendor/copy'] });
  tickets.fair = t;
  const { run, plan } = t;
  assert.equal(run.yardstick, 'quality', 'judged "at least as good"');
  assert.equal(plan.judging.reason, 'choices');
  // read as a choice where the requests declare one, and judged because the customer's own model picks it two ways
  assert.deepEqual([...plan.judging.offered].sort(), ['$', 'priority'], JSON.stringify(plan.judging));
  assert.deepEqual(plan.judging.choices, ['priority'], JSON.stringify(plan.judging));
  // the priority is a choice, never held exactly, however steadily the customer's model picks it
  assert.deepEqual(plan.yardstick.stableFields, [], JSON.stringify(plan.yardstick.stableFields));
  assert.equal(plan.yardstick.tieBreaker, REF);
  // the judges were checked on planted answers first, and both were right
  const check = JSON.parse(run.judge_check_json);
  assert.ok(check.planted >= 2, JSON.stringify(check));
  assert.equal(check.errors, 0, JSON.stringify(check));
  assert.deepEqual(check.judges.sort(), ['jev', 'llm']);
  assert.ok(check.kinds.includes('not allowed'), JSON.stringify(check.kinds));
  assert.ok(check.kinds.includes('far choice'), JSON.stringify(check.kinds));
  // the original model's own other level on a borderline ticket is as good: its own bar is the margin, and it passes it
  assert.ok(Number(run.noise_pct) < 1, `${run.noise_pct}%`);
  assert.equal(plan.selfTest.verdict, 'cleared', JSON.stringify(plan.selfTest));
  const good = await resultOf(run.id, 'vendor/good-labeler');
  assert.equal(good.verdict, 'cleared', said(good));
  assert.ok(Number(good.gap_pct) < 1, said(good));
  const copy = await resultOf(run.id, 'vendor/copy');
  assert.equal(copy.verdict, 'cleared', said(copy));
  const step = await resultOf(run.id, 'vendor/step-slip');
  assert.notEqual(step.verdict, 'cleared', `a priority a step away on clear tickets is clearly worse: ${said(step)}`);
  const far = await resultOf(run.id, 'vendor/far-slip');
  assert.notEqual(far.verdict, 'cleared', said(far));
  // the borderline tickets the good model picked differently on were read by both judges, and found as good
  const rows = (await replaysOf(run.id, 'vendor/good-labeler')).filter((r) => r.judged_by && r.judged_by.includes('-choices'));
  assert.ok(rows.length >= 5, `${rows.length} answers read by the judges`);
  for (const r of rows) {
    assert.equal(Number(r.score), 0, `${r.judged_by} ${r.readings}`);
    const read = JSON.parse(r.readings);
    assert.equal(read.way, 'choices');
    assert.ok(read.jev && read.llm, r.readings);
    assert.equal(read.verdict, 'fine');
  }
  // its same answers needed no judge at all
  const same = (await replaysOf(run.id, 'vendor/good-labeler')).filter((r) => r.judged_by === 'same');
  assert.ok(same.length > 50, `${same.length} answers the same by the field rules`);
  // and the second look, on tickets never seen, read them the same way: the first in line passed it
  assert.ok([good, copy].some((r) => r.confirm_verdict === 'cleared'), `${good.confirm_verdict}, ${copy.confirm_verdict}`);
});

test('the same tickets held to "the same answer", as before: the model that only picks the other right level fails, and the bar is raised to one its own model passes', async () => {
  fair();
  config.EVAL_JUDGE_CHOICES = false;
  // its model unsure of one borderline ticket in four, as the ticket-priority workload's was (about 3 in 120)
  flipsOf.every = 36;
  try {
    const { run, plan } = await measured('ticket', { enabled: ['vendor/good-labeler', 'vendor/copy'] });
    assert.equal(run.yardstick, 'agreement');
    assert.equal(plan.judging.reason, null);
    const raw = Math.max(Number(run.noise_pct) * 1.25, 3);
    // the original model, tested as if it were another model, passes the bar, raised where 1.25 times its own noise was too tight
    assert.equal(plan.selfTest.verdict, 'cleared', JSON.stringify(plan.selfTest));
    assert.ok(Math.abs(plan.selfTest.rawPct - raw) < 1e-6, JSON.stringify(plan.selfTest));
    if (Number(run.noise_pct) > 0) assert.equal(plan.selfTest.raised, true, JSON.stringify(plan.selfTest));
    if (plan.selfTest.raised) assert.ok(Number(run.floor_pct) > raw, `${run.floor_pct} over ${raw}`);
    const good = await resultOf(run.id, 'vendor/good-labeler');
    assert.notEqual(good.verdict, 'cleared', `every borderline ticket counts against it here: ${said(good)}`);
  } finally {
    config.EVAL_JUDGE_CHOICES = true;
    flipsOf.every = 18;
  }
});

test('the page says how a ticket test was judged, that the original model passes its own test, and what the judges said of each answer', async () => {
  const { workload, run } = tickets.fair;
  const page = await runPageOf(workload, run);
  assert.match(page.take, /These answers pick from a set of choices, such as a label or a level, and two good answers can pick differently\./);
  assert.match(page.take, /A figure the original model gave the same way both times still had to match exactly\./);
  assert.equal(page.ownTest.verdict, 'cleared');
  assert.match(page.ownTest.words, /Tested the same way as the other models, its own second answers held against its first, your original model, gpt-5\.4, passes/);
  const answers = await runAnswersOf(workload, run, 'vendor/good-labeler', { per: 50, result: 'same' });
  const judged = answers.rows.filter((a) => a.readings?.way === 'choices');
  assert.ok(judged.length >= 1, `the answers the judges read show their readings: ${JSON.stringify(answers.rows.slice(0, 2))}`);
  const r = judged[0].readings;
  assert.deepEqual(r.judges.map((j) => j.who), ['jev', 'llm']);
  assert.equal(r.verdict, 'fine');
  assert.match(judged[0].compared, /Read by two judges, each twice, once each way round/);
});

test("judges that disagree are settled by the customer's own model, and one that cannot be reached leaves the difference at half, read again next time", async () => {
  mode.jev = 'fair';
  mode.llm = 'lenient';
  mode.tie = 'fair';
  const before = counts.tieQuality;
  const { run } = await measured('ticket', { enabled: ['vendor/step-slip', 'vendor/good-labeler'] });
  assert.equal(run.yardstick, 'quality');
  assert.ok(counts.tieQuality > before, 'the customer\'s model was asked to settle');
  const step = await resultOf(run.id, 'vendor/step-slip');
  assert.notEqual(step.verdict, 'cleared', `the second judge reads a step away as fine, Jev and the tie-break do not: ${said(step)}`);
  const settled = (await replaysOf(run.id, 'vendor/step-slip')).filter((r) => String(r.judged_by).includes('+tie'));
  assert.ok(settled.length >= 1, 'some answers were settled by the tie-break');
  for (const r of settled) {
    assert.equal(Number(r.score), 1, r.readings);
    assert.equal(JSON.parse(r.readings).tie.model, REF);
  }
  // the tie-break cannot be reached: the difference counts half, and is not kept for next time
  mode.tie = 'down';
  try {
    const { run: run2 } = await measured('ticket', { enabled: ['vendor/step-slip'] });
    const halves = (await replaysOf(run2.id, 'vendor/step-slip')).filter((r) => Math.abs(Number(r.score) - 0.5) < 1e-9);
    assert.ok(halves.length >= 1, 'a difference nobody could call counts half');
    for (const r of halves) assert.equal(r.difference, 'unsure');
    const kept = await db.prepare(`SELECT COUNT(*) AS n FROM judge_cache WHERE score = 0.5`).get();
    assert.equal(Number(kept.n), 0, 'a tie-break that did not come back is never kept');
  } finally {
    fair();
  }
});

test('judges that get planted answers wrong are not used: the workload is compared for the same answer, as before, and its page says why', async () => {
  mode.jev = 'blind';
  mode.llm = 'blind';
  mode.tie = 'fair';
  try {
    const { workload, run, plan } = await measured('ticket', { enabled: ['vendor/good-labeler', 'vendor/copy'] });
    shared.fallback = { workload, run };
    assert.equal(run.yardstick, 'agreement', 'fell back to the same answer');
    assert.equal(plan.judging.reason, 'choices');
    assert.ok(plan.judging.fallback, JSON.stringify(plan.judging));
    const check = JSON.parse(run.judge_check_json);
    assert.ok(check.errors > 0, JSON.stringify(check));
    // nothing the blind judges said decided anything
    const judged = (await replaysOf(run.id, 'vendor/good-labeler')).filter((r) => String(r.judged_by).includes('-choices'));
    assert.equal(judged.length, 0);
    const page = await runPageOf(workload, run);
    assert.match(page.take, /The judges were first tested on answers whose right verdict is already known, and got some of them wrong, so they were not used/);
    assert.doesNotMatch(page.take, /nothing is switched on its word/);
    assert.equal(plan.selfTest.verdict, 'cleared');
  } finally {
    fair();
  }
});

test('a judge never reads its own answer: the language-model judge tested as a cheaper model is read by Jev, and the tie-break', async () => {
  fair();
  const { run } = await measured('ticket', { enabled: ['judge/small', 'vendor/copy'] });
  assert.equal(run.yardstick, 'quality');
  const rows = (await replaysOf(run.id, 'judge/small')).filter((r) => String(r.judged_by).includes('-choices'));
  assert.ok(rows.length >= 1, 'its differing answers were read');
  for (const r of rows) {
    const read = JSON.parse(r.readings);
    assert.equal(read.llm, undefined, `the judge read its own answer: ${r.readings}`);
    assert.ok(read.jev, r.readings);
  }
  assert.equal((await resultOf(run.id, 'judge/small')).verdict, 'cleared');
});

test('a department of no order beside an amount the request states: a different right department passes, a changed amount fails in code', async () => {
  fair();
  const { run, plan } = await measured('refund', { enabled: ['vendor/good-router', 'vendor/amount-slip'] });
  assert.equal(run.yardstick, 'quality');
  assert.deepEqual(plan.judging.choices, ['department']);
  assert.deepEqual(plan.yardstick.stableFields, ['amount'], 'the amount is held exactly, the department never');
  // departments have no order: the judges are checked on a department that is not allowed, never on one planted as far off
  const check = JSON.parse(run.judge_check_json);
  assert.ok(check.kinds.includes('not allowed'), JSON.stringify(check));
  assert.ok(!check.kinds.includes('far choice'), JSON.stringify(check.kinds));
  const good = await resultOf(run.id, 'vendor/good-router');
  assert.equal(good.verdict, 'cleared', said(good));
  const slip = await resultOf(run.id, 'vendor/amount-slip');
  assert.notEqual(slip.verdict, 'cleared', said(slip));
  const rows = (await replaysOf(run.id, 'vendor/amount-slip')).filter((r) => Number(r.score) > 0);
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.equal(r.judged_by, 'fields', `a changed amount is decided in code, never by a judge: ${r.judged_by}`);
});

test('a tool call: the level its model sets two ways is judged, the tool it always calls is held, so escalating clear tickets fails in code', async () => {
  fair();
  const { run, plan } = await measured('tool', { enabled: ['vendor/good-tooler', 'vendor/wrong-tool'] });
  assert.equal(run.yardstick, 'quality');
  // which tool is declared a choice (two tools, none forced), and the customer's model always calls the same one: held
  assert.ok(plan.judging.offered.includes('the tool called'), JSON.stringify(plan.judging));
  assert.deepEqual(plan.judging.choices, ['[].level'], JSON.stringify(plan.judging));
  assert.ok(plan.yardstick.stableFields.includes('the tool called'), JSON.stringify(plan.yardstick.stableFields));
  assert.equal(plan.yardstick.exactBarPct, undefined, 'a steady choice of tool is held on each answer, but is no figure to test');
  const check = JSON.parse(run.judge_check_json);
  assert.ok(!check.kinds.includes('no such tool'), 'no tool is planted where no judge reads which tool');
  assert.equal((await resultOf(run.id, 'vendor/good-tooler')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-tooler')));
  const wrong = await resultOf(run.id, 'vendor/wrong-tool');
  assert.notEqual(wrong.verdict, 'cleared', said(wrong));
  const rows = (await replaysOf(run.id, 'vendor/wrong-tool')).filter((r) => Number(r.score) > 0);
  assert.ok(rows.length >= 3, `${rows.length}`);
  for (const r of rows) assert.equal(r.judged_by, 'fields', `another tool is decided in code where the customer's model never varies it: ${r.judged_by}`);
});

test('negative: a priority its own model never picks two ways stays on "the same answer": held exactly, and no judge', async () => {
  fair();
  const before = { ...counts };
  const { run, plan } = await measured('steady', { enabled: ['vendor/steady-copy', 'vendor/steady-other'] });
  assert.equal(run.yardstick, 'agreement', JSON.stringify(plan.judging));
  assert.equal(plan.judging.reason, null);
  assert.deepEqual([...plan.judging.offered].sort(), ['$', 'priority'], 'read as a choice the requests offer');
  assert.deepEqual(plan.judging.choices, [], 'but judged only where its own model picks it two ways');
  assert.equal(counts.jevBetter, before.jevBetter);
  assert.equal(counts.llmQuality, before.llmQuality);
  assert.equal(counts.tieQuality, before.tieQuality);
  assert.equal((await resultOf(run.id, 'vendor/steady-copy')).verdict, 'cleared');
  assert.notEqual((await resultOf(run.id, 'vendor/steady-other')).verdict, 'cleared', 'another priority counts against it, as before');
});

test('a yes or no with no schema to declare it is a choice too, read from the answers', async () => {
  fair();
  const { run, plan } = await measured('flag', { enabled: ['vendor/good-flagger', 'vendor/bad-flagger'] });
  assert.equal(run.yardstick, 'quality');
  assert.deepEqual(plan.judging.choices, ['flagged']);
  assert.equal((await resultOf(run.id, 'vendor/good-flagger')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-flagger')));
  assert.notEqual((await resultOf(run.id, 'vendor/bad-flagger')).verdict, 'cleared');
});

test('a score from 1 to 5, declared as a whole number on that scale, is a choice: a step on a loose request passes, two steps on a clear one fails', async () => {
  fair();
  const { run, plan } = await measured('rate', { enabled: ['vendor/good-rater', 'vendor/bad-rater'] });
  assert.equal(run.yardstick, 'quality');
  assert.deepEqual(plan.judging.choices, ['score']);
  assert.equal((await resultOf(run.id, 'vendor/good-rater')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-rater')));
  assert.notEqual((await resultOf(run.id, 'vendor/bad-rater')).verdict, 'cleared');
});

test('a team the instruction lists, with no schema, is read as a choice from the answers', async () => {
  fair();
  const { run, plan } = await measured('route', { enabled: ['vendor/good-route'] });
  assert.equal(run.yardstick, 'quality');
  assert.deepEqual(plan.judging.choices, ['team']);
  assert.equal((await resultOf(run.id, 'vendor/good-route')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-route')));
});

test('a list of labels in another order is as good', async () => {
  fair();
  const { run, plan } = await measured('tags', { enabled: ['vendor/good-tagger'] });
  assert.equal(run.yardstick, 'quality');
  assert.deepEqual(plan.judging.choices, ['tags[]']);
  assert.equal((await resultOf(run.id, 'vendor/good-tagger')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-tagger')));
});

test('figures the customer\'s model reads two ways, in an answer with no choice, stay on "the same answer" as before: no judge, the right reading passes, a misreading fails, and the bar is one its own model passes', async () => {
  fair();
  const before = { ...counts };
  const { run, plan } = await measured('scan', { enabled: ['vendor/good-scanner', 'vendor/bad-scanner'] });
  assert.equal(run.yardstick, 'agreement', `${JSON.stringify(plan.judging)} noise ${run.noise_pct}`);
  assert.equal(plan.judging.reason, null);
  assert.deepEqual(plan.judging.choices, []);
  assert.ok(plan.judging.flips > 0, 'its own model did read some totals two ways');
  assert.equal(counts.jevBetter, before.jevBetter, 'no judge read a figure');
  assert.equal(counts.llmQuality, before.llmQuality);
  assert.equal(counts.tieQuality, before.tieQuality);
  assert.equal(plan.selfTest.verdict, 'cleared', JSON.stringify(plan.selfTest));
  assert.equal((await resultOf(run.id, 'vendor/good-scanner')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/good-scanner')));
  assert.notEqual((await resultOf(run.id, 'vendor/bad-scanner')).verdict, 'cleared');
});

test('a priority with a reason beside it: the priority is read by the three, the reason as writing is, and the judges are checked on planted priorities', async () => {
  fair();
  const { run, plan } = await measured('triage', { enabled: ['vendor/good-triager', 'vendor/bad-triager'] });
  assert.equal(run.yardstick, 'quality');
  assert.equal(plan.judging.reason, 'choices');
  assert.deepEqual(plan.judging.choices, ['priority'], 'a reason is written, never a choice');
  // planted on answers that differ only in their reason's wording, which is how this model's answers always differ
  const check = JSON.parse(run.judge_check_json);
  assert.equal(check.errors, 0, JSON.stringify(check));
  assert.ok(check.kinds.includes('not allowed') && check.kinds.includes('far choice'), JSON.stringify(check.kinds));
  const good = await resultOf(run.id, 'vendor/good-triager');
  assert.equal(good.verdict, 'cleared', said(good));
  assert.notEqual((await resultOf(run.id, 'vendor/bad-triager')).verdict, 'cleared');
  const rows = await replaysOf(run.id, 'vendor/good-triager');
  const panel = rows.filter((r) => String(r.judged_by).includes('-choices'));
  const worded = rows.filter((r) => r.judged_by && !String(r.judged_by).includes('-choices') && !['same', 'fields'].includes(r.judged_by));
  assert.ok(panel.length >= 5, `the borderline priorities went to the three: ${panel.length}`);
  assert.ok(worded.length >= 50, `the rest differ only in the reason, read as writing: ${worded.length} ${[...new Set(rows.map((r) => r.judged_by))]}`);
  for (const r of [...panel, ...worded]) assert.equal(Number(r.score), 0, `${r.judged_by} ${r.readings}`);
});

test('a long order: a wrong category on its thirty-sixth line is shown to the judges and fails; the other right category passes', async () => {
  fair();
  const { run, plan } = await measured('lines', { enabled: ['vendor/good-liner', 'vendor/late-slip'] });
  assert.equal(run.yardstick, 'quality', JSON.stringify(plan.judging));
  assert.deepEqual(plan.judging.choices, ['lines[].category']);
  const check = JSON.parse(run.judge_check_json);
  assert.deepEqual(check.kinds, ['not allowed'], 'categories have no order, so nothing is planted as far off');
  assert.equal(check.errors, 0, JSON.stringify(check));
  const good = await resultOf(run.id, 'vendor/good-liner');
  assert.equal(good.verdict, 'cleared', said(good));
  const slip = await resultOf(run.id, 'vendor/late-slip');
  assert.notEqual(slip.verdict, 'cleared', said(slip));
  const worse = (await replaysOf(run.id, 'vendor/late-slip')).filter((r) => Number(r.score) === 1);
  assert.ok(worse.length >= 5, `${worse.length}`);
  for (const r of worse) {
    assert.ok(String(r.judged_by).includes('-choices'), `read by the judges, not decided in code: ${r.judged_by}`);
    // Jev, which reads 2,500 characters of an answer, saw the line both ways round, so there was no tie to break
    const read = JSON.parse(r.readings);
    assert.deepEqual(read.jev?.picks, ['second', 'first'], r.readings);
    assert.equal(read.tie, undefined, r.readings);
  }
});

test('negative: one tool the request forces, with no allowed values, makes no choice: "the same answer", and no judge', async () => {
  fair();
  const before = { ...counts };
  const { run, plan } = await measured('lookup', { enabled: ['vendor/good-lookup'] });
  assert.equal(run.yardstick, 'agreement');
  assert.equal(plan.judging.reason, null);
  assert.deepEqual(plan.judging.choices, []);
  assert.equal(counts.jevBetter, before.jevBetter);
  assert.equal(counts.llmQuality, before.llmQuality);
  assert.equal(counts.tieQuality, before.tieQuality);
  assert.equal((await resultOf(run.id, 'vendor/good-lookup')).verdict, 'cleared');
});

test('the figures test: with a judged bar that has room to spare, a model that changes a stated amount still fails, its page says why, and so do the checks after a switch', async () => {
  fair();
  const margin = config.EVAL_QUALITY_MARGIN_PCT;
  config.EVAL_QUALITY_MARGIN_PCT = 40;
  let measuredRun;
  try {
    measuredRun = await measured('refund', { enabled: ['vendor/good-router', 'vendor/amount-slip'] });
  } finally {
    config.EVAL_QUALITY_MARGIN_PCT = margin;
  }
  const { workload, run, plan } = measuredRun;
  shared.figures = { workload, run };
  assert.equal(run.yardstick, 'quality');
  assert.ok(Number(run.floor_pct) >= 40, `${run.floor_pct}`);
  assert.equal(Number(plan.yardstick.exactBarPct), 3, JSON.stringify(plan.yardstick));
  const slip = await resultOf(run.id, 'vendor/amount-slip');
  const rank = JSON.parse(slip.rank_json);
  assert.ok(Number(slip.gap_hi) <= Number(run.floor_pct), `inside the judged bar on its own: ${said(slip)}, up to ${slip.gap_hi}%`);
  assert.equal(rank.heldBy, 'figures', slip.rank_json);
  assert.equal(slip.verdict, 'missed', said(slip));
  assert.equal((await resultOf(run.id, 'vendor/good-router')).verdict, 'cleared');
  const page = await runPageOf(workload, run);
  const row = page.cands.find((c) => c.key === 'vendor/amount-slip');
  assert.equal(row.verdict, 'Changed figures');
  assert.match(row.why, /^It changed a figure the original model gives the same way every time, such as an amount, a date or a code, on \d+(\.\d)?% of requests, where up to 3% is allowed\./);
  // no dash of either length, and no vertical line, in what the page says (the characters by code, so none is in this file)
  assert.doesNotMatch(row.why, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}|]`));
  // switched, and checked since: answers that changed the amount break the figures test, whatever the judged bar allows
  const armId = `arm_fig_${process.pid}`;
  await db.prepare('UPDATE workloads SET routed_arm_id = ?, promoted_at = ? WHERE id = ?').run(armId, now() - DAY, workload.id);
  forgetBar(workload.id);
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  try {
    for (let j = 0; j < 200; j += 1) {
      await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, judged_by, yardstick, cost_usd, status, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, 'quality', 0.001, 200, ?)`)
        .run(`ctl_fig_${process.pid}_${j}`, w.workspace_id, w.id, armId, j < 40 ? 1 : 0, j < 40 ? 'fields' : 'same', now());
    }
    const rec = await controlRecord(w);
    assert.equal(rec.figures.changed, 40);
    assert.equal(rec.figures.barPct, 3);
    assert.ok(rec.lo * 100 < rec.floorPct, 'the judged bar alone would let it be');
    assert.match(controlBreach(rec, REF), /of 200 of its answers, 40 changed a figure gpt-5\.4 gives the same way every time, or gave nothing usable \(20\.0%\), clearly past the 3\.0% its figures may change\./);
    // checks whose figures matched and whose other differences the judges left unsettled count among those compared
    for (let j = 0; j < 100; j += 1) {
      await db.prepare(`INSERT INTO control_checks (id, workspace_id, workload_id, arm_id, score, better, judged_by, yardstick, cost_usd, status, created_at)
          VALUES (?, ?, ?, ?, NULL, 0, 'unsettled', 'quality', 0.001, 200, ?)`).run(`ctl_fig_${process.pid}_u${j}`, w.workspace_id, w.id, armId, now());
    }
    const withUnsettled = await controlRecord(w);
    assert.equal(withUnsettled.n, 200, 'the judged rate reads only what was settled');
    assert.equal(withUnsettled.figures.compared, 300);
    assert.match(controlBreach(withUnsettled, REF), /of 300 of its answers, 40 changed a figure .* \(13\.3%\)/);
  } finally {
    await db.prepare(`DELETE FROM control_checks WHERE id LIKE 'ctl_fig_%'`).run();
    await db.prepare('UPDATE workloads SET routed_arm_id = NULL, promoted_at = NULL WHERE id = ?').run(workload.id);
    forgetBar(workload.id);
  }
});

test('answers the judges could not read: on more than one call in ten, what is left is not enough to switch on, and the page says so', async () => {
  mode.jev = 'only-clear';
  mode.llm = 'only-clear';
  mode.tie = 'only-clear';
  try {
    const { workload, run } = await measured('ticket', { enabled: ['vendor/wobbly'] });
    assert.equal(run.yardstick, 'quality');
    const check = JSON.parse(run.judge_check_json);
    assert.equal(check.errors, 0, 'the planted answers are clear-cut, so the judges read them all and are trusted');
    const r = await resultOf(run.id, 'vendor/wobbly');
    const rank = JSON.parse(r.rank_json);
    assert.ok(rank.unread > 0.1 * rank.answered, r.rank_json);
    assert.equal(rank.heldBy, 'unread', r.rank_json);
    assert.equal(r.verdict, 'review', said(r));
    assert.ok(Number(r.gap_pct) < 1, `the answers that were read were all as good: ${said(r)}`);
    const page = await runPageOf(workload, run);
    const row = page.cands.find((c) => c.key === 'vendor/wobbly');
    assert.equal(row.verdict, 'Too few read');
    assert.match(row.why, new RegExp(`^The judges could not read ${rank.unread} of its ${rank.answered} answers, more than 1 in 10, `));
    const kept = await db.prepare('SELECT COUNT(*) AS n FROM judge_cache WHERE score = 0.5').get();
    assert.equal(Number(kept.n), 0, 'nothing nobody read is kept');
  } finally {
    fair();
  }
});

test('negative: figures only, from a model that agrees with itself, stay on "the same answer", pay for no judge, and the same figure written another way is the same', async () => {
  fair();
  const before = { ...counts };
  const { run, plan } = await measured('invoice', { enabled: ['vendor/good-invoicer', 'vendor/locale-invoicer', 'vendor/currency-slip'] });
  assert.equal(run.yardstick, 'agreement');
  assert.equal(plan.judging.reason, null);
  assert.deepEqual(plan.judging.choices, [], 'a currency is copied from the invoice, not chosen');
  assert.equal(plan.judging.flips, 0);
  assert.equal(counts.jevBetter, before.jevBetter, 'no judge read anything');
  assert.equal(counts.llmQuality, before.llmQuality);
  assert.equal(counts.tieQuality, before.tieQuality);
  assert.ok(Math.abs(Number(run.floor_pct) - 3) < 1e-6, `the bar is as before: ${run.floor_pct}`);
  assert.equal((await resultOf(run.id, 'vendor/good-invoicer')).verdict, 'cleared');
  assert.equal((await resultOf(run.id, 'vendor/locale-invoicer')).verdict, 'cleared', said(await resultOf(run.id, 'vendor/locale-invoicer')));
  assert.notEqual((await resultOf(run.id, 'vendor/currency-slip')).verdict, 'cleared');
});

test('negative: a written workload is judged as it was, and reads no choice', async () => {
  fair();
  const before = { ...counts };
  const { run, plan } = await measured('echo', { enabled: ['vendor/echo'] });
  assert.equal(run.yardstick, 'agreement');
  assert.equal(plan.judging.choices, undefined);
  assert.equal(counts.tieQuality, before.tieQuality, 'the customer\'s model never judged');
  assert.equal((await resultOf(run.id, 'vendor/echo')).verdict, 'cleared');
});

test('the daily checks after a switch read a served priority the way the test did, by the three', async () => {
  fair();
  const { workload } = tickets.fair;
  forgetBar(workload.id);
  const bar = await barOf(workload);
  assert.equal(bar.yardstick, 'quality');
  assert.equal(bar.panel, true, 'read by the three, as its measurement was');
  assert.equal(bar.stable?.has('priority'), false, 'the priority is never held');
  const i = 9;
  assert.ok(borderline(i));
  const body = BODIES.ticket(i);
  const as = (x) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(x) } }] });
  const own = as({ priority: lv(i) });
  const again = async () => ({ json: own, cost: 0.002 });
  const how = { scope: workload.workspace_id, yardstick: 'quality', again, stable: bar.stable, tieBreaker: REF, judged: 'vendor/good-labeler', panel: bar.panel };
  const other = await scoreServed(body, as({ priority: next(lv(i)) }), own, 'enum', how);
  assert.equal(other.score, 0, JSON.stringify(other));
  assert.match(String(other.judgedBy), /-choices/, JSON.stringify(other));
  const clear = 10;
  assert.ok(!borderline(clear));
  const off = await scoreServed(BODIES.ticket(clear), as({ priority: farAway(clear) }), as({ priority: lv(clear) }), 'enum', how);
  assert.equal(off.score, 1, JSON.stringify(off));
  assert.match(String(off.judgedBy), /-choices/, JSON.stringify(off));
});

test('the daily checks read a bare label such as P2 as a choice for the judges, never as a figure that changed', async () => {
  fair();
  const { workload } = tickets.fair;
  const bare = (x) => ({ choices: [{ finish_reason: 'stop', message: { content: x } }] });
  let asked = 0;
  const again = async () => { asked += 1; return { json: bare('P2'), cost: 0.002 }; };
  const body = { model: REF, messages: [{ role: 'system', content: 'Answer with the priority only: P1, P2, P3 or P4.' },
    { role: 'user', content: 'Ticket #11: the customer writes about an order.' }] };
  const s = await scoreServed(body, bare('P3'), bare('P2'), 'enum', { scope: workload.workspace_id, yardstick: 'quality', again,
    stable: new Set(), tieBreaker: REF, judged: 'vendor/x', panel: true });
  assert.notEqual(s.judgedBy, 'numbers', JSON.stringify(s));
  assert.equal(asked, 0, 'the customer\'s model is not asked again to confirm a figure');
});

test('the quote counts the judges for a workload whose requests declare choices, before any test has run', async () => {
  fair();
  const { workload } = await seed('ticket', { enabled: ['vendor/good-labeler', 'vendor/copy'] });
  forgetProfile(workload.id);
  const withJudges = await planFor(workload, { canRoute: true });
  assert.equal(withJudges.choices, true);
  config.EVAL_JUDGE_CHOICES = false;
  try {
    forgetProfile(workload.id);
    const without = await planFor({ ...workload, updated_at: Number(workload.updated_at || 0) + 1 }, { canRoute: true });
    assert.equal(without.choices, false);
    assert.ok(withJudges.estimateUsd > without.estimateUsd, `${withJudges.estimateUsd} against ${without.estimateUsd}`);
  } finally {
    config.EVAL_JUDGE_CHOICES = true;
  }
});

test('the quote counts the readings of a reason written beside a choice, before any test has run', async () => {
  fair();
  const { workload: t } = await seed('ticket', { enabled: ['vendor/good-labeler'] });
  const { workload: g } = await seed('triage', { enabled: ['vendor/good-triager'] });
  forgetProfile(t.id);
  forgetProfile(g.id);
  const qt = await planFor(t, { canRoute: true });
  const qg = await planFor(g, { canRoute: true });
  assert.equal(qt.differs.written, 0);
  assert.equal(qg.differs.written, 1);
  assert.ok(qg.estimateUsd > qt.estimateUsd, `${qg.estimateUsd} against ${qt.estimateUsd}`);
});

const askOfTicket = (i) => `Ticket #${i}: the customer writes about an order, case ${i * 31}.`;

test('a small judged workload: a model that matches every figure clears on fewer requests than the figures bar alone could show', async () => {
  fair();
  const { run, plan } = await measured('refund', { n: 120, enabled: ['vendor/good-router', 'vendor/amount-slip'] });
  assert.equal(run.yardstick, 'quality', JSON.stringify(plan.judging));
  assert.ok(Number(run.sample_size) < 88, `${run.sample_size} requests, fewer than a 3% figures bar needs`);
  const good = await resultOf(run.id, 'vendor/good-router');
  const rank = JSON.parse(good.rank_json);
  assert.equal(rank.figures?.verdict, 'insufficient', good.rank_json);
  assert.equal(rank.heldBy, undefined, 'too few calls to show the figures bar never holds it back');
  assert.equal(good.verdict, 'cleared', said(good));
  assert.notEqual((await resultOf(run.id, 'vendor/amount-slip')).verdict, 'cleared');
});

test('a field whose own name reads as two fields ("Prio.") is planted, judged and passed by its keys', async () => {
  fair();
  const { run, plan } = await measured('dotted', { enabled: ['vendor/dotted-good'] });
  assert.equal(run.yardstick, 'quality', `${JSON.stringify(plan.judging)} ${run.judge_check_json}`);
  assert.deepEqual(plan.judging.choices, ['Prio.']);
  const check = JSON.parse(run.judge_check_json);
  assert.equal(check.errors, 0, `the planted answers changed "Prio." itself, which the judges saw: ${JSON.stringify(check)}`);
  assert.ok(check.kinds.includes('not allowed') && check.kinds.includes('far choice'), JSON.stringify(check.kinds));
  assert.equal((await resultOf(run.id, 'vendor/dotted-good')).verdict, 'cleared');
});

test("the tie-break keeps a request's own wish that nothing be kept, where its workspace turned that off", async () => {
  mode.jev = 'fair';
  mode.llm = 'lenient';
  mode.tie = 'fair';
  try {
    const { workspace } = await seed('ticket', { n: 4 });
    await db.prepare('UPDATE workspaces SET zdr_required = 0 WHERE id = ?').run(workspace.id);
    forgetWorkspace(workspace.id);
    const how = { scope: workspace.id, tieBreaker: REF, judged: 'vendor/step-slip' };
    // Jev reads a priority a step off a clear ticket as worse, the lenient judge as fine: the customer's model settles it
    tieProviders.length = 0;
    const asked = await judgeStructured(askOfTicket(3), { priority: stepAway(3) }, { priority: lv(3) }, 'enum',
      { ...how, body: { ...BODIES.ticket(3), provider: { zdr: true } } });
    assert.equal(asked.detail?.tie?.model, REF, JSON.stringify(asked));
    assert.ok(tieProviders.length === 2 && tieProviders.every((p) => p?.zdr === true), JSON.stringify(tieProviders));
    // a request that asked for nothing: the workspace's own choice holds
    tieProviders.length = 0;
    const plain = await judgeStructured(askOfTicket(7), { priority: stepAway(7) }, { priority: lv(7) }, 'enum', { ...how, body: BODIES.ticket(7) });
    assert.equal(plain.detail?.tie?.model, REF, JSON.stringify(plain));
    assert.ok(tieProviders.length === 2 && tieProviders.every((p) => !p?.zdr), JSON.stringify(tieProviders));
  } finally {
    fair();
  }
});

test("a difference no tested judge can read is left unread, never settled by the customer's model alone; one the tie-break settled is kept", async () => {
  fair();
  const { workspace } = await seed('ticket', { n: 4 });
  const ties = counts.tieQuality;
  // the language-model judge's own answer, with Jev found unreliable on this workload: nobody tested can read it
  const none = await judgeStructured(askOfTicket(3), { priority: stepAway(3) }, { priority: lv(3) }, 'enum',
    { scope: workspace.id, prefer: 'llm', tieBreaker: REF, judged: 'judge/small' });
  assert.equal(none.transient, true, JSON.stringify(none));
  assert.equal(counts.tieQuality, ties, "the customer's model was never asked to decide alone");
  // Jev cannot tell (it leans the same way both times), the language model gives no reading: the tie-break would have been
  // asked whatever that one said, so what it decides is kept
  mode.jev = 'leans';
  mode.llm = 'down';
  try {
    assert.ok(borderline(9));
    const how = { scope: workspace.id, tieBreaker: REF, judged: 'vendor/good-labeler' };
    const first = await judgeStructured(askOfTicket(9), { priority: next(lv(9)) }, { priority: lv(9) }, 'enum', how);
    assert.equal(first.detail?.tie?.model, REF, JSON.stringify(first));
    assert.equal(first.score, 0);
    assert.equal(first.once, undefined, 'kept, and read from what was kept next time');
    const before = counts.tieQuality;
    await judgeStructured(askOfTicket(9), { priority: next(lv(9)) }, { priority: lv(9) }, 'enum', how);
    assert.equal(counts.tieQuality, before);
  } finally {
    fair();
  }
});

test("its own failed answers count in its bar, as a candidate's do: a model as good, failing as often, passes", async () => {
  fair();
  const { run, plan } = await measured('flaky', { enabled: ['vendor/flaky-twin'] });
  assert.equal(run.yardstick, 'quality', JSON.stringify(plan.judging));
  assert.ok(Number(plan.yardstick.qualityNoisePct) > 0, `its own failures are in its noise: ${plan.yardstick.qualityNoisePct}`);
  assert.equal(plan.selfTest.verdict, 'cleared', JSON.stringify(plan.selfTest));
  const twin = await resultOf(run.id, 'vendor/flaky-twin');
  assert.equal(twin.verdict, 'cleared', said(twin));
});

test('a second look held back by its figures test says so in its own words, on the run page and the model page', async () => {
  const { workload, run } = shared.figures;
  const note = 'it changed a figure the original model gives the same way every time on 8.3% of them, where up to 3% is allowed';
  await db.prepare(`UPDATE eval_results SET confirm_verdict = 'missed', confirm_runs = 60, confirm_gap = 1.2, confirm_floor = 8, confirm_note = ?
      WHERE run_id = ? AND model_id = ?`).run(note, run.id, 'vendor/good-router');
  const page = await runPageOf(workload, run);
  const row = page.cands.find((c) => c.key === 'vendor/good-router');
  assert.match(row.why, /on 60 new requests it had never seen it changed a figure the original model gives the same way every time on 8\.3% of them, where up to 3% is allowed\. So it isn't switched to/);
  const answers = await runAnswersOf(workload, run, 'vendor/good-router', { per: 5 });
  assert.equal(answers.looks.heldBy, note);
});

test('a test whose judges failed their planted answers and so were not used is never tagged as held back by an unsure judge', async () => {
  const { workload, run } = shared.fallback;
  // a model inside the bar but not cleared, which is what that tag is for where the judges were used
  await db.prepare(`UPDATE eval_results SET verdict = 'review', gap_hi = 0 WHERE run_id = ? AND model_id = ?`).run(run.id, 'vendor/copy');
  const w = await db.prepare('SELECT * FROM workloads WHERE id = ?').get(workload.id);
  const listed = (await pageOf(w)).measurements.find((m) => m.id === run.id);
  assert.ok(listed, 'the test is listed');
  assert.notEqual(listed.tag.text, 'Passed, judge unsure', JSON.stringify(listed.tag));
});

test('with choice judging off, all of it is off: a workload judged for another reason is read whole as before, with no figures test and no tie-break', async () => {
  fair();
  const before = { ...counts };
  config.EVAL_JUDGE_CHOICES = false;
  try {
    const { run, plan } = await measured('varied', { enabled: ['vendor/varied-any'] });
    assert.equal(run.yardstick, 'quality');
    assert.equal(plan.judging.reason, 'varied');
    assert.equal(plan.yardstick.choices, undefined, 'the checks after a switch read it as before (barOf: no panel)');
    assert.equal(plan.yardstick.exactBarPct, undefined, 'no figures test');
    assert.equal(counts.tieQuality, before.tieQuality, "the customer's model breaks no tie");
    const rows = (await replaysOf(run.id, 'vendor/varied-any')).filter((r) => r.judged_by && r.judged_by !== 'same');
    assert.ok(rows.length >= 5, `${rows.length}`);
    assert.ok(rows.every((r) => !String(r.judged_by).includes('-choices')), [...new Set(rows.map((r) => r.judged_by))].join(', '));
    assert.equal((await resultOf(run.id, 'vendor/varied-any')).verdict, 'cleared');
  } finally {
    config.EVAL_JUDGE_CHOICES = true;
  }
  // and on: the same kind of workload read by the three, its code held to a figures test
  const { run: on, plan: planOn } = await measured('varied', { enabled: ['vendor/varied-any'] });
  assert.equal(on.yardstick, 'quality');
  assert.deepEqual(planOn.yardstick.choices, []);
  assert.ok(Number(planOn.yardstick.exactBarPct) > 0, JSON.stringify(planOn.yardstick));
  const onRows = (await replaysOf(on.id, 'vendor/varied-any')).filter((r) => String(r.judged_by).includes('-choices'));
  assert.ok(onRows.length >= 5, `${onRows.length}`);
});

test('a choice an earlier test saw its model flip stays judged while its requests offer it, so a sample that missed the flip does not swing back', async () => {
  fair();
  const first = await measured('steady', { n: 480, enabled: ['vendor/steady-copy'] });
  assert.equal(first.run.yardstick, 'agreement');
  // as if that test had seen the customer's model pick the priority two ways
  const earlier = planOf(first.run);
  earlier.judging.choices = ['priority'];
  await db.prepare('UPDATE eval_runs SET plan_json = ? WHERE id = ?').run(JSON.stringify(earlier), first.run.id);
  const out = await runEvaluation(first.workload.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const second = await runOf(out.runId);
  assert.deepEqual(planOf(second).judging.choices, ['priority'], second.plan_json);
  assert.equal(second.yardstick, 'quality');
});

test('the checks after a switch hold a steady choice exactly, and count only figures toward the figures test', async () => {
  fair();
  const { workload } = tickets.fair;
  const body = BODIES.refund(5);
  const as = (x) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(x) } }] });
  const ref = as({ department: dept(5), amount: amount(5) });
  const again = async () => ({ json: ref, cost: 0.002 });
  const how = { scope: workload.workspace_id, yardstick: 'quality', again, stable: new Set(['department', 'amount']), tieBreaker: REF,
    judged: 'vendor/x', panel: true, figures: new Set(['amount']) };
  const team = await scoreServed(body, as({ department: otherDept(5), amount: amount(5) }), ref, 'json', how);
  assert.equal(team.score, 1, JSON.stringify(team));
  assert.equal(team.judgedBy, 'held', 'a steady choice changed: held, but no figure');
  const sum = await scoreServed(body, as({ department: dept(5), amount: amount(5) + 1 }), ref, 'json', how);
  assert.equal(sum.judgedBy, 'fields', 'a figure changed');
});

test('the tie-break finds a model by the one its variant is of, and always leaves it room to answer', async () => {
  await db.prepare('UPDATE models_catalog SET reasoning_json = ? WHERE model_id = ?')
    .run(JSON.stringify({ supported_efforts: ['low', 'medium', 'high'] }), 'vendor/good-labeler');
  assert.deepEqual(await tieOptions('vendor/good-labeler:nitro'), { max_tokens: TIE_ROOM, reasoning: { effort: 'low' } });
  assert.deepEqual(await tieOptions('vendor/never-heard-of'), { max_tokens: TIE_ROOM });
});
