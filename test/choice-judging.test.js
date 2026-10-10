/* The pieces that judge a structured answer's choices, one at a time and with no network: which fields are choices (from
   what the requests declare, and where nothing does, from what the answers show), that a choice is never held exactly, the
   bar its own model can pass, and how two readings by one judge become its verdict. The whole measurement is in
   choice-judging.e2e.test.js. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';

const { declaredChoices, declaredOptions, observedChoices, choicePathsOf, stablePaths, fairBar, isChoicePath, normPath, verdictWith,
  floorFrom, scaleOf, focusOf, hasWrittenFields, FOCUS_CHARS, TOOL_PATH } = await import('../src/eval/compare.js');
const { choiceVerdict, rulesOf } = await import('../src/eval/judge.js');
const { ownTestOf } = await import('../src/workloadPage.js');
const { controlBreach } = await import('../src/learn/control.js');

const LEVELS = ['low', 'medium', 'high', 'urgent'];
const ticket = { messages: [{ role: 'system', content: 'Set the priority of the ticket.' }, { role: 'user', content: 'Ticket 1' }],
  response_format: { type: 'json_schema', json_schema: { name: 'p', schema: { type: 'object', properties: { priority: { type: 'string', enum: LEVELS } } } } } };

test('what a request declares: allowed values, a yes or no, a short whole-number scale, a list of allowed values; never a figure or a const', () => {
  assert.deepEqual([...declaredChoices(ticket, 'enum')].sort(), ['$', 'priority']);
  const body = { messages: [], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', properties: {
    total: { type: 'number' }, currency: { type: 'string' }, paid: { type: ['boolean', 'null'] }, stars: { type: 'integer', minimum: 1, maximum: 5 },
    quantity: { type: 'integer', minimum: 0, maximum: 100000 }, version: { const: 'v1' },
    kind: { oneOf: [{ const: 'invoice' }, { const: 'receipt' }] },
    lines: { type: 'array', items: { type: 'object', properties: { category: { anyOf: [{ type: 'string', enum: ['food', 'travel'] }, { type: 'null' }] }, amount: { type: 'number' } } } },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  } } } } };
  assert.deepEqual([...declaredChoices(body, 'json')].sort(), ['kind', 'lines[].category', 'paid', 'stars', 'tags[]']);
  // a json_object request declares nothing
  assert.equal(declaredChoices({ messages: [], response_format: { type: 'json_object' } }, 'json').size, 0);
  // written answers make no choices
  assert.equal(declaredChoices(ticket, 'free_text').size, 0);
  // a tool call: which tool, and each tool's arguments' allowed values
  const tools = { messages: [], tools: [
    { type: 'function', function: { name: 'set', parameters: { type: 'object', properties: { level: { type: 'string', enum: LEVELS }, note: { type: 'string' } } } } },
    { type: 'function', function: { name: 'flag', parameters: { type: 'object', properties: { urgent: { type: 'boolean' }, id: { type: 'string' } } } } },
  ] };
  assert.deepEqual([...declaredChoices(tools, 'tool_call')].sort(), ['[].level', '[].urgent', TOOL_PATH].sort());
  // the values each allows, in the order given, which a planted answer takes the far end of
  assert.deepEqual(declaredOptions(ticket, 'enum').get('priority'), LEVELS);
  assert.deepEqual(declaredOptions(body, 'json').get('kind'), ['invoice', 'receipt']);
  assert.deepEqual(declaredOptions(body, 'json').get('lines[].category'), ['food', 'travel']);
  assert.deepEqual(declaredOptions(tools, 'tool_call').get('[].level'), LEVELS);
});

test('a schema made from code, whose fields point to shared definitions, declares its choices too', () => {
  // as Pydantic writes it: the allowed values once, under $defs, and each field pointing there, directly or through allOf
  const schema = {
    $defs: { Priority: { type: 'string', enum: LEVELS }, Team: { enum: ['billing', 'bug'] }, Line: { type: 'object', properties: {
      kind: { $ref: '#/$defs/Team' }, amount: { type: 'number' } } } },
    type: 'object',
    properties: {
      priority: { $ref: '#/$defs/Priority' },
      team: { allOf: [{ $ref: '#/$defs/Team' }], description: 'who handles it' },
      lines: { type: 'array', items: { $ref: '#/$defs/Line' } },
      elsewhere: { $ref: 'https://example.com/schema#/Priority' },
      broken: { $ref: '#/$defs/Missing' },
    },
  };
  const body = { messages: [], response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } };
  assert.deepEqual([...declaredChoices(body, 'json')].sort(), ['lines[].kind', 'priority', 'team']);
  assert.deepEqual(declaredOptions(body, 'json').get('priority'), LEVELS);
  assert.deepEqual(declaredOptions(body, 'json').get('lines[].kind'), ['billing', 'bug']);
  // a schema that points at itself is read no deeper than it can be
  const loop = { $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' }, ok: { type: 'boolean' } } } }, $ref: '#/$defs/Node' };
  assert.ok(declaredChoices({ messages: [], response_format: { type: 'json_schema', json_schema: { schema: loop } } }, 'json').has('ok'));
});

test('where nothing is declared: every yes or no, and a short repeated value the instruction lists; never one it does not list', () => {
  const answers = [];
  const teams = ['billing', 'bug', 'other'];
  const currencies = ['EUR', 'USD', 'GBP'];
  for (let i = 0; i < 60; i += 1) {
    answers.push({ team: teams[i % 3], currency: currencies[i % 3], spam: i % 4 === 0, ref: `R-${i}`, note: 'The customer asks about the order and wants an update soon.' });
  }
  const got = observedChoices(answers, 'Route the message to one team: billing, bug or other.', 'json');
  assert.deepEqual([...got].sort(), ['spam', 'team'], 'the currency is copied from the request, a reference is unique, a note is written');
  // the same answers, with an instruction that lists nothing: only the yes or no
  assert.deepEqual([...observedChoices(answers, 'Read the message.', 'json')], ['spam']);
  // a value listed as part of another word is not listed ("bugfix" does not list "bug")
  assert.deepEqual([...observedChoices(answers, 'Route it: billing, bugfix, others.', 'json')], ['spam']);
  // too few answers to say
  assert.equal(observedChoices(answers.slice(0, 3), 'billing, bug or other', 'json').size, 0);
  // a tool call's arguments are read as a list of them
  const calls = Array.from({ length: 20 }, (_, i) => [{ name: 'route', args: { team: teams[i % 3] } }]);
  assert.deepEqual([...observedChoices(calls, 'Teams: billing, bug, other.', 'tool_call')], ['[].team']);
  // and the two together, never for written answers
  const choices = choicePathsOf({ bodies: [ticket, ticket], values: [{ priority: 'high' }, { priority: 'low' }], shapeKind: 'enum' });
  assert.deepEqual([...choices].sort(), ['$', 'priority']);
  assert.equal(choicePathsOf({ bodies: [ticket], values: ['some text'], shapeKind: 'free_text' }).size, 0);
  assert.equal(isChoicePath('lines[3].category', new Set(['lines[].category'])), true);
  assert.equal(isChoicePath('lines[3].amount', new Set(['lines[].category'])), false);
  assert.equal(normPath('a[1].b[22].c'), 'a[].b[].c');
});

test('a choice is never held exactly, however steadily the customer\'s model makes it; a figure still is', () => {
  const pairs = [];
  for (let i = 0; i < 117; i += 1) pairs.push([{ priority: 'high', total: i }, { priority: 'high', total: i }]);
  pairs.push([{ priority: 'high', total: 1 }, { priority: 'urgent', total: 1 }], [{ priority: 'medium', total: 2 }, { priority: 'high', total: 2 }],
    [{ priority: 'urgent', total: 3 }, { priority: 'high', total: 3 }]);
  // 117 of 120 the same: held, as the ticket-priority workload's priority was on 5 Oct 2026
  assert.deepEqual([...stablePaths(pairs, 'json')].sort(), ['priority', 'total']);
  assert.deepEqual([...stablePaths(pairs, 'json', { except: new Set(['priority']) })], ['total']);
  // the tool called, as a choice, is not held either
  const calls = Array.from({ length: 30 }, () => [[{ name: 'set', args: { id: 7 } }], [{ name: 'set', args: { id: 7 } }]]);
  assert.deepEqual([...stablePaths(calls, 'tool_call')].sort(), ['[0].id', TOOL_PATH].sort());
  assert.deepEqual([...stablePaths(calls, 'tool_call', { except: new Set([TOOL_PATH]) })], ['[0].id']);
});

test('a bar the customer\'s own model would fail is raised to where it passes, only where a sample this size can show a pass at all', () => {
  const ones = (k, n) => Array.from({ length: n }, (_, i) => (i < k ? 1 : 0));
  // the ticket-priority workload of 5 Oct 2026: 3 differences in 120, 1.25 times that a bar of 3.125%, which its own answers fail
  assert.equal(verdictWith(ones(3, 120), 3.125).verdict, 'review');
  const raised = fairBar(3.125, ones(3, 120));
  assert.equal(raised.raised, true);
  assert.ok(Math.abs(raised.bar - 6.09) < 0.01, `${raised.bar}`);
  assert.equal(raised.self.verdict, 'cleared');
  assert.equal(verdictWith(ones(3, 120), raised.bar).verdict, 'cleared', 'its own answers pass the raised bar');
  // a model that never differs from itself keeps its 3% floor
  const steady = fairBar(floorFrom(0, { multiple: 1.25, minPct: 3 }), ones(0, 120));
  assert.equal(steady.raised, false);
  assert.equal(steady.bar, 3);
  assert.equal(steady.self.verdict, 'cleared');
  // eleven requests can show nothing passes a 5% bar: left as it is, and too few to be sure, never a bar a handful clears
  const few = fairBar(5, ones(0, 11));
  assert.equal(few.raised, false);
  assert.equal(few.bar, 5);
  assert.equal(few.self.verdict, 'insufficient');
  // never past half plus the margin
  assert.ok(fairBar(52, ones(60, 120)).bar <= 55);
  // half scores count as they are read
  const halves = fairBar(3, [0.5, 0.5, ...ones(0, 118)]);
  assert.equal(halves.self.verdict, 'cleared');
  // nothing to read: the bar as it is
  assert.deepEqual(fairBar(4, []), { bar: 4, self: null, raised: false, rawPct: 4 });
});

test("one judge's two readings, the answer judged first and then second: worse, better, as good, or it cannot tell", () => {
  assert.equal(choiceVerdict(['second', 'first']), 'worse', "both read the original model's answer as better");
  assert.equal(choiceVerdict(['first', 'second']), 'better');
  assert.equal(choiceVerdict(['equal', 'equal']), 'fine');
  assert.equal(choiceVerdict(['first', 'equal']), 'fine', 'one reading prefers it, the other calls them even');
  // a judge leaning on where an answer sits, or one reading sure and the other not: it cannot tell
  assert.equal(choiceVerdict(['first', 'first']), 'unsure');
  assert.equal(choiceVerdict(['second', 'second']), 'unsure');
  assert.equal(choiceVerdict(['second', 'equal']), 'unsure');
  assert.equal(choiceVerdict([null, 'first']), null, 'a reading that did not come back is no verdict');
});

test("the page says the original model's own test in words", () => {
  const plan = (t) => ({ selfTest: t });
  const raised = ownTestOf(plan({ verdict: 'cleared', raised: true, rawPct: 3.125, barPct: 6.0938, n: 120 }), 'gpt-5.4');
  assert.match(raised.words, /your original model, gpt-5\.4, passes\. The usual pass mark would have been 3\.1%, which even it could not be shown to pass on these 120 requests, so the pass mark was set at 6\.1%, where it does/);
  assert.match(ownTestOf(plan({ verdict: 'cleared', raised: false, barPct: 5, n: 120 }), 'gpt-5.4').words, /passes the 5% pass mark\.$/);
  assert.match(ownTestOf(plan({ verdict: 'insufficient', raised: false, barPct: 5, n: 11 }), null).words, /on 11 requests no model can, so this test is too small/);
  assert.equal(ownTestOf({}, 'x'), null, 'a test from before it was kept says nothing');
  for (const w of [raised.words]) assert.doesNotMatch(w, /[\u2013\u2014|]/, 'no dashes and no vertical lines');
});

test('which tool to call is a choice only where there is one to make: never a single tool, nor one the request forces', () => {
  const set = { type: 'function', function: { name: 'set', parameters: { type: 'object', properties: { level: { type: 'string', enum: LEVELS } } } } };
  const flag = { type: 'function', function: { name: 'flag', parameters: { type: 'object', properties: { id: { type: 'string' } } } } };
  // one tool is called every time, by every model; its arguments' allowed values are still choices
  assert.deepEqual([...declaredChoices({ messages: [], tools: [set] }, 'tool_call')], ['[].level']);
  // two, with the one to call named by the request, the way OpenAI and Anthropic each name it
  for (const forced of [{ type: 'function', function: { name: 'set' } }, { type: 'tool', name: 'set' }]) {
    assert.equal(declaredChoices({ messages: [], tools: [set, flag], tool_choice: forced }, 'tool_call').has(TOOL_PATH), false, JSON.stringify(forced));
  }
  // two, left to the model, whether it has to call one or not
  for (const left of [undefined, 'auto', 'required', { type: 'any' }]) {
    const body = { messages: [], tools: [set, flag], ...(left ? { tool_choice: left } : {}) };
    assert.equal(declaredChoices(body, 'tool_call').has(TOOL_PATH), true, JSON.stringify(left));
  }
  // and read over a workload's requests, a forced lookup with no allowed values makes no choice at all
  const lookup = { messages: [{ role: 'system', content: 'Look the order up.' }], tools: [flag], tool_choice: { type: 'function', function: { name: 'flag' } } };
  const calls = Array.from({ length: 20 }, (_, i) => [{ name: 'flag', args: { id: `A-${i}` } }]);
  assert.equal(choicePathsOf({ bodies: [lookup, lookup], values: calls, shapeKind: 'tool_call' }).size, 0);
});

test('a figure written as text is never read as a choice, however a numbered instruction happens to list it', () => {
  const answers = Array.from({ length: 30 }, (_, i) => ({ step: ['1', '2', '3'][i % 3], code: `${10 + (i % 4)}` }));
  assert.equal(observedChoices(answers, '1. Read the order. 2. Find its step. 3. Answer with the step and its code, 10, 11, 12 or 13.', 'json').size, 0);
  // a label of letters the instruction lists still is
  const labels = Array.from({ length: 30 }, (_, i) => ({ step: ['draft', 'review', 'done'][i % 3] }));
  assert.deepEqual([...observedChoices(labels, 'Say whether it is draft, review or done.', 'json')], ['step']);
});

test('a scale is read from its values: numbers, levels with a letter before them, and the words that name levels; never a list of no order', () => {
  assert.deepEqual(scaleOf(LEVELS), [2, 3, 4, 6]);
  assert.deepEqual(scaleOf(['P1', 'P2', 'P3', 'P4']), [1, 2, 3, 4]);
  assert.deepEqual(scaleOf(['sev1', 'sev2', 'sev3']), [1, 2, 3]);
  assert.deepEqual(scaleOf([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.deepEqual(scaleOf(['Low', 'MEDIUM', 'very_high']), [2, 3, 5]);
  assert.equal(scaleOf(['billing', 'shipping', 'technical']), null, 'departments have no order, so none is far from another');
  assert.equal(scaleOf(['low', 'high']), null, 'two values have no far end');
  assert.equal(scaleOf(['low', 'medium', 'banana']), null);
  assert.equal(scaleOf(null), null);
});

test('a long answer is shown to the judges as the parts that differ, each under its place, so a difference late in it is never past what they read', () => {
  const lines = Array.from({ length: 40 }, (_, k) => ({ sku: `SKU-${1000 + k}`, category: k % 2 ? 'food' : 'travel', amount: 10 + k }));
  const a = { invoice: 'INV-7', currency: 'EUR', lines };
  assert.ok(JSON.stringify(a, null, 2).length > FOCUS_CHARS);
  const b = { ...a, lines: lines.map((l, k) => (k === 33 ? { ...l, category: 'travel' } : l)) };
  assert.deepEqual(focusOf(b, a, 'json'), [{ 'lines[33]': { sku: 'SKU-1033', category: 'travel', amount: 43 } },
    { 'lines[33]': { sku: 'SKU-1033', category: 'food', amount: 43 } }]);
  // a field outside any list under its own name, beside a line
  assert.deepEqual(Object.keys(focusOf({ ...b, invoice: 'INV-8' }, a, 'json')[0]).sort(), ['invoice', 'lines[33]']);
  // a line one answer has and the other does not
  assert.deepEqual(focusOf({ ...a, lines: lines.slice(0, 39) }, a, 'json'), [{ 'lines[39]': null }, { 'lines[39]': lines[39] }]);
  // short answers are read whole
  assert.equal(focusOf({ priority: 'low' }, { priority: 'high' }, 'json'), null);
  // long calls to different tools: which tools, side by side
  const long = 'x'.repeat(FOCUS_CHARS);
  assert.deepEqual(focusOf([{ name: 'escalate', args: { note: long } }], [{ name: 'set', args: { note: long } }], 'tool_call'),
    [{ 'the tools called': ['escalate'] }, { 'the tools called': ['set'] }]);
});

test('written fields are text with no list of allowed values, read through the definitions they point to; never a date or a const', () => {
  const body = (properties, extra = {}) => ({ messages: [], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', properties, ...extra } } } });
  assert.equal(hasWrittenFields(ticket, 'enum'), false);
  assert.equal(hasWrittenFields(body({ priority: { type: 'string', enum: LEVELS }, reason: { type: 'string' } }), 'json'), true);
  assert.equal(hasWrittenFields(body({ due: { type: 'string', format: 'date' }, kind: { const: 'x' }, n: { type: 'number' } }), 'json'), false);
  assert.equal(hasWrittenFields(body({ note: { $ref: '#/$defs/Note' } }, { $defs: { Note: { type: ['string', 'null'] } } }), 'json'), true);
  assert.equal(hasWrittenFields({ messages: [], response_format: { type: 'json_object' } }, 'json'), false, 'nothing declared, nothing counted');
  const reply = { type: 'function', function: { name: 'reply', parameters: { type: 'object', properties: { text: { type: 'string' } } } } };
  assert.equal(hasWrittenFields({ messages: [], tools: [reply] }, 'tool_call'), true);
});

test('a schema of many definitions that all point to each other is read nearest the top first, and never stalls', () => {
  const defs = {};
  for (let k = 0; k < 14; k += 1) {
    defs[`D${k}`] = { type: 'object', properties: {
      ...Object.fromEntries(Array.from({ length: 14 }, (_, j) => [`f${j}`, { $ref: `#/$defs/D${j}` }])),
      // declared after fourteen fields that each lead back into the whole schema, which has more paths than anything could read
      ...(k === 0 ? { level: { type: 'string', enum: LEVELS }, reason: { type: 'string' } } : {}),
    } };
  }
  const body = { messages: [], response_format: { type: 'json_schema', json_schema: { schema: { $defs: defs, $ref: '#/$defs/D0' } } } };
  const t0 = Date.now();
  assert.ok(declaredChoices(body, 'json').has('level'), 'the choice beside the deep part is still read');
  assert.deepEqual(declaredOptions(body, 'json').get('level'), LEVELS);
  assert.equal(hasWrittenFields(body, 'json'), true);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('the judges read what an answer must follow: the tools it may call or its schema, never more than 1,500 characters of it', () => {
  const tools = { messages: [], tools: [{ type: 'function', function: { name: 'escalate', description: 'Only for outages', parameters: { type: 'object', properties: {} } } }] };
  assert.match(rulesOf(tools), /^The tools it may call: .*"name":"escalate".*"description":"Only for outages"/);
  assert.match(rulesOf(ticket), /^The answer must follow this JSON schema: .*"enum":\["low","medium","high","urgent"\]/);
  const huge = { messages: [], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', description: 'x'.repeat(5000) } } } };
  assert.equal(rulesOf(huge).length, 1500);
  assert.ok(rulesOf(huge).endsWith('...'));
  assert.equal(rulesOf({ messages: [], response_format: { type: 'json_object' } }), '');
  assert.equal(rulesOf(null), '');
});

test('the checks after a switch fail a figure changed too often first, however the judges read the rest', () => {
  const rec = { enough: true, n: 200, worse: 4, rate: 0.02, lo: 0.005, hi: 0.04, floorPct: 6, yardstick: 'quality',
    figures: { changed: 16, rate: 0.08, lo: 0.045, barPct: 3 } };
  assert.match(controlBreach(rec, 'openai/gpt-5.4'), /of 200 of its answers, 16 changed a figure gpt-5\.4 gives the same way every time, or gave nothing usable \(8\.0%\), clearly past the 3\.0% its figures may change\./);
  // figures inside their bar, and judged answers inside theirs: nothing to say
  assert.equal(controlBreach({ ...rec, figures: { changed: 2, rate: 0.01, lo: 0, barPct: 3 } }, 'openai/gpt-5.4'), null);
  // judged answers past their pass mark, with no figures test set
  assert.match(controlBreach({ ...rec, worse: 30, rate: 0.15, lo: 0.1, figures: null }, 'openai/gpt-5.4'), /30 were worse \(15\.0%\), clearly past your 6\.0% pass mark/);
  // too few checks yet: never
  assert.equal(controlBreach({ ...rec, enough: false }, 'openai/gpt-5.4'), null);
});
