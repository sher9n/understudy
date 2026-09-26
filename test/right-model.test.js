/* The pieces that keep Understudy picking the right model (26 Sep 2026), one at a time and with no network: a structured
   answer held to "at least as good" keeps the fields its customer's model gives the same way twice (heldFieldChanged), and
   a judge always sees the question being answered (askOf, cutMiddle, requestText). The whole measurement is in
   right-model.e2e.test.js. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';

const { heldFieldChanged, stablePaths, numbersOf, numbersDiffer } = await import('../src/eval/compare.js');
const judge = await import('../src/eval/judge.js');
const { askOf, cutMiddle, ASK_MAX } = await import('../src/eval/ask.js');
const { requestText } = await import('../src/learn/check.js');

const A = { invoice: 'INV-7', total: 1234.5, currency: 'EUR', note: 'Paid by card on the 4th, ahead of the due date as agreed.' };
const B = { invoice: 'INV-7', total: '1,234.50', currency: 'eur', note: 'Settled by card on the 4th, before the due date, as agreed.' };

test('a structured answer held to "at least as good" keeps every field its customer model gives the same way twice', () => {
  // the same facts, the written field worded another way: nothing held changed, and the judge reads the rest
  assert.equal(heldFieldChanged({ ...A, note: 'Card payment on the 4th, early, as agreed with them.' }, A, B, 'json'), null);
  // a changed total is worse, whatever a judge would read of it
  const total = heldFieldChanged({ ...A, total: 1243.5 }, A, B, 'json');
  assert.equal(total?.path, 'total');
  assert.equal(total.want, 1234.5);
  assert.equal(total.got, 1243.5);
  // numbers by value, and a one-word label whatever its case, as "the same answer" compares them
  assert.equal(heldFieldChanged({ ...A, total: '1234.50', currency: 'Eur' }, A, B, 'json'), null);
  // a held field left out is a changed one
  const { invoice, ...noInvoice } = A;
  assert.equal(invoice, 'INV-7');
  assert.equal(heldFieldChanged(noInvoice, A, B, 'json')?.path, 'invoice');
  // a field the customer's model itself gave two ways is left to the judge
  assert.equal(heldFieldChanged({ ...A, total: 99 }, A, { ...B, total: 1300 }, 'json'), null);
  // a written field keeps its figures, where both of the customer's answers state the same ones
  assert.equal(heldFieldChanged({ ...A, note: 'Paid by card on the 5th, ahead of the due date as agreed.' }, A, B, 'json')?.path, 'note');
  // and its figures only: the same figures in other words are left to the judge
  assert.equal(heldFieldChanged({ ...A, note: 'The 4th saw it paid, by card, ahead of when it was due.' }, A, B, 'json'), null);
  // items in a list are held one by one: a missing line is a changed answer
  const lines = { items: [{ sku: 'X1', qty: 2 }, { sku: 'Y4', qty: 1 }] };
  assert.equal(heldFieldChanged({ items: [{ sku: 'X1', qty: 2 }] }, lines, lines, 'json')?.path, 'items[1].sku');
  // with one answer from the customer's model nothing is known to be held
  assert.equal(heldFieldChanged({ ...A, total: 1 }, A, null, 'json'), null);
});

test('a tool call and a label are held the same way', () => {
  const a = [{ name: 'refund', args: { order: 'A-19', amount: 30 } }];
  const b = [{ name: 'refund', args: { order: 'A-19', amount: '30.00' } }];
  assert.equal(heldFieldChanged([{ name: 'refund', args: { order: 'A-19', amount: 30 } }], a, b, 'tool_call'), null);
  assert.equal(heldFieldChanged([{ name: 'escalate', args: {} }], a, b, 'tool_call')?.path, 'the tool called');
  assert.equal(heldFieldChanged([{ name: 'refund', args: { order: 'A-19', amount: 300 } }], a, b, 'tool_call')?.path, '[0].amount');
  // the customer's model called another tool the second time: nothing lines up, so the judge reads it
  assert.equal(heldFieldChanged([{ name: 'escalate', args: {} }], a, [{ name: 'escalate', args: {} }], 'tool_call'), null);
  // a label on its own
  assert.equal(heldFieldChanged('high', 'high', 'High', 'enum'), null);
  assert.equal(heldFieldChanged('low', 'high', 'high', 'enum')?.path, 'the answer');
  assert.equal(heldFieldChanged({ priority: 'low' }, { priority: 'high' }, { priority: 'high' }, 'enum')?.path, 'priority');
});

test('a field is held only where the customer model gives it the same way on nearly every call, never by chance', () => {
  // a category picked afresh from three on every answer agrees a third of the time: its own variation, never held
  const pick = (k) => ['travel', 'food', 'office'][(k * 7 + 3) % 3];
  const pairs = Array.from({ length: 60 }, (_, i) => [
    { category: pick(i), total: 100 + i, currency: 'EUR', note: `Paid on the ${i % 28 + 1}th, as the invoice asks for it.` },
    { category: pick(i + 1 + (i % 2)), total: `${100 + i}.00`, currency: 'eur', note: `Settled on the ${i % 28 + 1}th, as the invoice asks for it.` },
  ]);
  const stable = stablePaths(pairs, 'json');
  assert.deepEqual([...stable].sort(), ['currency', 'note', 'total']);
  // held to those alone: a category that differs, where the two answers to this call happened to agree on it, is the judge's
  const a = pairs[0][0];
  const agreeing = { ...pairs[0][1], category: a.category };
  assert.equal(heldFieldChanged({ ...a, category: 'office' === a.category ? 'food' : 'office' }, a, agreeing, 'json', { only: stable }), null);
  assert.equal(heldFieldChanged({ ...a, currency: 'USD' }, a, agreeing, 'json', { only: stable })?.path, 'currency');
  // an empty set holds nothing at all
  assert.equal(heldFieldChanged({ ...a, total: 1 }, a, agreeing, 'json', { only: new Set() }), null);
  // too few calls to say either way: nothing is stable yet
  assert.equal(stablePaths(pairs.slice(0, 9), 'json').size, 0);
  // a field the model slips on now and then is still its own (95% of the calls), and one it gets wrong a tenth of the time is not
  const slips = Array.from({ length: 100 }, (_, i) => [{ total: 100 + i, id: `A${i}` }, { total: i % 25 === 0 ? 1 : 100 + i, id: i % 10 === 0 ? 'x' : `A${i}` }]);
  assert.deepEqual([...stablePaths(slips, 'json')].sort(), ['total']);
  // a tool's name, when it is called the same way nearly always, and its arguments
  const calls = Array.from({ length: 20 }, (_, i) => [[{ name: 'refund', args: { order: `A-${i}`, amount: i } }], [{ name: 'refund', args: { order: `A-${i}`, amount: i } }]]);
  assert.deepEqual([...stablePaths(calls, 'tool_call')].sort(), ['[0].amount', '[0].order', 'the tool called']);
});

test('read strictly against one answer (a background answer), only figures are held', () => {
  assert.equal(heldFieldChanged({ ...A, currency: 'USD', invoice: 'INV-8' }, A, A, 'json', { figuresOnly: true }), null);
  assert.equal(heldFieldChanged({ ...A, total: 1 }, A, A, 'json', { figuresOnly: true })?.path, 'total');
  assert.equal(heldFieldChanged({ ...A, note: 'Paid by card on the 9th, ahead of the due date as agreed.' }, A, A, 'json', { figuresOnly: true })?.path, 'note');
});

test('the figure checks moved with the comparisons and read the same from the judge', () => {
  assert.equal(judge.numbersOf, numbersOf);
  assert.equal(judge.numbersDiffer, numbersDiffer);
  assert.deepEqual(numbersOf('Total 1,234.50 on 4 March'), ['1234.5', '4']);
  assert.equal(numbersDiffer('The total is $1,234.50', 'The total is $1,243.50'), true);
  assert.equal(numbersDiffer('4 March 2026', '2026-03-04'), false);
});

test('a judge always sees the question being answered, however long the instructions', () => {
  const long = `You are a support assistant. ${'Follow the refund policy carefully. '.repeat(300)}`;
  const body = { messages: [{ role: 'system', content: long }, { role: 'user', content: 'Can I return shoes I wore once? Order A-19.' }] };
  const t = askOf(body);
  assert.ok(t.length <= ASK_MAX, `${t.length} characters`);
  assert.ok(t.endsWith('user: Can I return shoes I wore once? Order A-19.'), t.slice(-80));
  assert.ok(t.startsWith('system: You are a support assistant.'), t.slice(0, 60));
  assert.match(t, /the middle left out/);
  // a short one reads exactly as it always did
  assert.equal(askOf({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] }), 'system: Be brief.\nuser: Hi');
  // a long document to summarise keeps the request's start, where the question is, and its end
  const doc = { messages: [{ role: 'user', content: `Summarise this contract in three lines.\n${'Clause text. '.repeat(800)}\nSigned in Colombo.` }] };
  const d = askOf(doc);
  assert.ok(d.length <= ASK_MAX, `${d.length} characters`);
  assert.match(d, /^user: Summarise this contract in three lines\./);
  assert.match(d, /Signed in Colombo\.$/);
});

test('a picture, a file and a tool call are named where they were, not dropped', () => {
  const m = askOf({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is on this receipt?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'file', file: { filename: 'r.pdf' } }] },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'lookup', arguments: '{"sku":"X1"}' } }] },
    { role: 'tool', content: 'X1 is a lamp' },
  ] });
  assert.match(m, /user: What is on this receipt\? \[a picture\] \[a file\]/);
  assert.match(m, /assistant: \[called lookup with \{"sku":"X1"\}\]/);
  assert.match(m, /tool: X1 is a lamp$/);
});

test('a long conversation keeps the instructions, the newest turn whole, and the newest turns before it', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'words '.repeat(40)}` }));
  const c = askOf({ messages: [{ role: 'system', content: 'Answer as a travel agent.' }, ...turns, { role: 'user', content: 'So which flight is cheapest?' }] });
  assert.ok(c.length <= ASK_MAX, `${c.length} characters`);
  assert.match(c, /^system: Answer as a travel agent\.\n\[\d+ earlier messages left out\]/);
  assert.match(c, /user: So which flight is cheapest\?$/);
  assert.match(c, /turn 29 /, 'the newest earlier turn is kept');
  assert.doesNotMatch(c, /turn 0 /, 'and the oldest is the one left out');
});

test('a cut from the middle keeps both ends and says how long the whole was', () => {
  assert.equal(cutMiddle('short', 10), 'short');
  const cut = cutMiddle(`INSTRUCTIONS ${'x'.repeat(5000)} THE QUESTION`, 2500);
  assert.ok(cut.length <= 2500, `${cut.length}`);
  assert.match(cut, /^INSTRUCTIONS/);
  assert.match(cut, /THE QUESTION$/);
  // 13 + 5000 + 13 characters
  assert.match(cut, /5026 characters, the middle left out/);
});

test('what Jev reads of a request keeps its end as well as its start', () => {
  const t = requestText({ messages: [
    { role: 'system', content: `Rules: ${'be exact. '.repeat(400)}Always answer in French.` },
    { role: 'user', content: `${'Background. '.repeat(300)}Question: what is the total?` },
  ] });
  assert.match(t, /^Instructions: Rules: be exact\./);
  assert.match(t, /Always answer in French\./);
  assert.match(t, /Question: what is the total\?$/);
});
