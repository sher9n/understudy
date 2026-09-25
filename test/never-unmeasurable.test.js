/* The pieces that keep a written workload measurable, one at a time and with no network: reading a comparison
   both ways round, the margin bar, the instruction's checklist and the answers planted to test a judge, and the
   dates the workload page writes. The whole measurement is in never-unmeasurable.e2e.test.js. */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JOBS_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';

const { bothWays, looksEnglish } = await import('../src/eval/judge.js');
const { marginFloor, floorFrom } = await import('../src/eval/compare.js');
const { checkItem, brokenAgainst, breakOne, cleanItems, instructionOf } = await import('../src/eval/checklist.js');
const { sharedAsk } = await import('../src/eval/run.js');
const { timeIST, stampIST, dateIST, dayIST, weekdayIST, dayOf } = await import('../web/src/dates.js');

test('a comparison read both ways round: worse or better only where both readings agree, a split is a tie', () => {
  // the answer judged is first in the first reading and second in the second
  assert.deepEqual(bothWays(['second', 'first']), { score: 1, candBetter: false, split: false }, 'both preferred the reference');
  assert.deepEqual(bothWays(['first', 'second']), { score: 0, candBetter: true, split: false }, 'both preferred the answer');
  // a judge that always picks whichever it reads first sees no difference at all, which is right
  assert.deepEqual(bothWays(['first', 'first']), { score: 0, candBetter: false, split: true });
  assert.deepEqual(bothWays(['second', 'second']), { score: 0, candBetter: false, split: true });
  assert.deepEqual(bothWays(['equal', 'equal']), { score: 0, candBetter: false, split: false });
  // one reading sure, the other a tie: not clearly worse
  assert.equal(bothWays(['second', 'equal']).score, 0);
  assert.equal(bothWays(['equal', 'first']).score, 0);
});

test('the margin bar: as often clearly worse as the customer\'s own model, plus five points, with no rate it gives up at', () => {
  const m = { marginPct: 5, minPct: 3 };
  assert.equal(marginFloor(0, m), 5);
  assert.equal(marginFloor(4, m), 9);
  assert.equal(marginFloor(47, m), 52, 'the 24 Sep workload that could not be measured gets a bar');
  assert.equal(marginFloor(0, { marginPct: 1, minPct: 3 }), 3, 'never under the floor');
  // a model clearly worse than itself on more than half its calls is not one model's variation, and never makes a bar anything passes
  assert.equal(marginFloor(50, m), 55);
  assert.equal(marginFloor(100, m), 55);
  // the other yardstick keeps its multiple
  assert.equal(floorFrom(20, { multiple: 1.25, minPct: 3 }), 25);
});

test('checklist items checked in code: counts, text that must or must not appear, openings, shapes', () => {
  const t = 'The sea is wide. The waves are loud!\nIt ends here.'; // eleven words, three sentences, two lines
  assert.equal(checkItem({ kind: 'max_words', n: 11 }, t), true);
  assert.equal(checkItem({ kind: 'max_words', n: 10 }, t), false);
  assert.equal(checkItem({ kind: 'min_words', n: 12 }, t), false);
  assert.equal(checkItem({ kind: 'max_sentences', n: 3 }, t), true);
  assert.equal(checkItem({ kind: 'max_sentences', n: 2 }, t), false);
  // an abbreviation followed by a small letter does not end a sentence
  assert.equal(checkItem({ kind: 'max_sentences', n: 1 }, 'Bring a coat, e.g. the blue one.'), true);
  assert.equal(checkItem({ kind: 'max_lines', n: 1 }, t), false);
  assert.equal(checkItem({ kind: 'max_chars', n: 200 }, t), true);
  assert.equal(checkItem({ kind: 'includes', text: 'WAVES' }, t), true, 'text is matched whatever its case');
  assert.equal(checkItem({ kind: 'excludes', text: 'price' }, t), true);
  assert.equal(checkItem({ kind: 'excludes', text: 'sea' }, t), false);
  assert.equal(checkItem({ kind: 'starts_with', text: 'the sea' }, t), true);
  assert.equal(checkItem({ kind: 'format', value: 'one_line' }, t), false);
  assert.equal(checkItem({ kind: 'format', value: 'json' }, '```json\n{"a": 1}\n```'), true, 'a fenced JSON answer is JSON');
  assert.equal(checkItem({ kind: 'format', value: 'json' }, 'Here: {"a": 1}'), false);
  assert.equal(checkItem({ kind: 'format', value: 'bullets' }, '- one\n- two'), true);
  assert.equal(checkItem({ kind: 'format', value: 'bullets' }, '- only one'), false);
  assert.equal(checkItem({ kind: 'format', value: 'numbered' }, '1. one\n2) two'), true);
  assert.equal(checkItem({ kind: 'ask', say: 'Polite' }, t), null, 'only a reading can say');
});

test('an answer is worse by the checklist only when it breaks what the reference keeps', () => {
  const items = [{ kind: 'max_words', n: 5, say: 'At most five words' }, { kind: 'includes', text: 'Acme', say: 'Signed Acme' },
    { kind: 'ask', say: 'Polite' }];
  assert.equal(brokenAgainst(items, 'one two three four five six Acme', 'short, Acme')?.say, 'At most five words');
  assert.equal(brokenAgainst(items, 'short answer', 'short, Acme')?.say, 'Signed Acme');
  // both break it: the checklist says nothing, and the reading decides
  assert.equal(brokenAgainst(items, 'one two three four five six Acme', 'six words here and there Acme'), null);
  // the reference breaks it and the answer keeps it: not worse
  assert.equal(brokenAgainst(items, 'short, Acme', 'one two three four five six'), null);
  // an item only a reading can settle is never decided in code
  assert.equal(brokenAgainst([{ kind: 'ask', say: 'Polite' }], 'rude', 'kind'), null);
  assert.equal(brokenAgainst([], 'a', 'b'), null);
  assert.equal(brokenAgainst(null, 'a', 'b'), null);
});

test('answers planted as ignoring the instruction break it plainly, or are not planted at all', () => {
  const poem = 'The sea is wide and blue tonight.\nThe waves come home to me.\n- Acme Poems';
  const longer = breakOne([{ kind: 'max_words', n: 20, say: 'At most 20 words' }], poem);
  assert.ok(longer && checkItem(longer.item, longer.text) === false && longer.text.includes(poem), 'repeated past its limit');
  const unsigned = breakOne([{ kind: 'includes', text: '- Acme Poems', say: 'Signed' }], poem);
  assert.ok(unsigned && !unsigned.text.includes('Acme Poems'), 'stripped of what it must include');
  const lines = breakOne([{ kind: 'format', value: 'one_line', say: 'One line' }], 'First. Second. Third.');
  assert.equal(lines.text, 'First.\nSecond.\nThird.');
  const flat = breakOne([{ kind: 'format', value: 'bullets', say: 'Bullets' }], '- one\n- two\n- three');
  assert.equal(flat.text, 'one two three');
  const prose = breakOne([{ kind: 'format', value: 'json', say: 'JSON' }], '{"total": 12}');
  assert.ok(prose && checkItem({ kind: 'format', value: 'json' }, prose.text) === false);
  // a limit only a pile of copies would pass is not a plain break, and neither is an opening
  assert.equal(breakOne([{ kind: 'max_words', n: 500, say: 'At most 500 words' }], poem), null);
  assert.equal(breakOne([{ kind: 'starts_with', text: 'The sea', say: 'Opens with the sea' }], poem), null);
  // an answer that already breaks the item cannot be broken into a worse one by it
  assert.equal(breakOne([{ kind: 'includes', text: 'Zebra', say: 'Mentions a zebra' }], poem), null);
  assert.equal(breakOne([], poem), null);
});

test('the checklist keeps only what code can check or a reading can settle, and no more than it should', () => {
  const items = cleanItems({ items: [
    { kind: 'max_words', n: '50', say: 'At most 50 words' },
    { kind: 'max_words', n: -3 },
    { kind: 'includes', text: '' },
    { kind: 'includes', text: 'x'.repeat(81) },
    { kind: 'format', value: 'haiku' },
    { kind: 'format', value: 'bullets' },
    { kind: 'language', value: 'de' },
    { kind: 'language', value: 'xx' },
    { kind: 'invented', say: 'Something' },
    { kind: 'ask', say: '' },
    { kind: 'ask', say: 'Addresses the customer by name' },
    { kind: 'ask', say: 'Polite' },
    { kind: 'ask', say: 'One too many questions' },
  ] });
  assert.deepEqual(items.map((x) => x.kind), ['max_words', 'format', 'ask', 'ask', 'ask']);
  assert.equal(items[0].n, 50);
  assert.equal(items[1].say, 'Written as bullets');
  assert.equal(items[2].say, 'Written in German', 'a language becomes a question for a reader');
  assert.equal(items.filter((x) => x.kind === 'ask').length, 3, 'at most three questions');
  const many = cleanItems({ items: Array.from({ length: 12 }, (_, i) => ({ kind: 'excludes', text: `word${i}` })) });
  assert.equal(many.length, 8, 'at most eight items');
  assert.deepEqual(cleanItems('nonsense'), []);
  assert.deepEqual(cleanItems(null), []);
});

test('the instruction is what the requests share: the commonest system message, or several copies of it', () => {
  const body = (system, user = 'hello') => ({ messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }] });
  const steady = 'You are a support agent for Acme. Answer in at most 80 words.';
  assert.deepEqual(instructionOf([body(steady), body(steady), body('You are something else entirely, for once.')]), [steady]);
  // one copy per request, a name in each: three copies, so what they share can be read from them
  const named = ['Ann', 'Bo', 'Cy', 'Di'].map((n) => body(`You write to ${n}. Always sign off as Acme Support.`));
  assert.equal(instructionOf(named).length, 3);
  // none, or too short to say anything
  assert.equal(instructionOf([body(null), body(null)]), null);
  assert.equal(instructionOf([body('Be brief.')]), null);
  // an instruction given in parts, as the content blocks some clients send
  const parts = { messages: [{ role: 'system', content: [{ type: 'text', text: 'Answer in German,' }, { type: 'text', text: 'politely.' }] }] };
  assert.deepEqual(instructionOf([parts]), ['Answer in German, politely.']);
});

test('English is told from German, and a text too short says nothing', () => {
  assert.equal(looksEnglish('The sea is wide and the waves are loud tonight, and I am home.'), true);
  assert.equal(looksEnglish('Das Meer ist weit und die Wellen sind heute Nacht laut.'), false);
  assert.equal(looksEnglish('Hello there'), false);
});

test('two requests ask the same thing when they share most of their words, whatever number is in them', () => {
  assert.ok(sharedAsk('Write a poem about the sea, #3', 'Write a poem about the sea, #4') >= 0.5);
  assert.ok(sharedAsk('Summarise: the council met on Tuesday to discuss the new bridge budget.',
    'Summarise: our quarterly revenue grew in Asia while European sales fell sharply.') < 0.5);
  assert.equal(sharedAsk('', 'anything'), 1, 'nothing written reads as the same ask, so nothing is planted from it');
});

test('dates as India tells them, the month always in three letters', () => {
  const at = Date.UTC(2026, 8, 24, 20, 16); // 01:46 on 25 September in India
  assert.equal(timeIST(at), '25 Sep, 01:46');
  assert.equal(stampIST(at), '25 Sep 2026, 01:46 IST');
  assert.equal(dateIST(at), '25 Sep 2026');
  assert.equal(dayIST(at), '25 Sep');
  assert.equal(weekdayIST(at), 'Fri, 25 Sep 2026');
  assert.equal(dayOf(Math.floor(Date.UTC(2026, 8, 24) / 86400000)), '24 Sep');
  assert.equal(timeIST(Date.UTC(2026, 0, 1, 0, 5)), '1 Jan, 05:35');
  for (const bad of [null, undefined, '', 'soon', NaN]) assert.equal(timeIST(bad), '', `${bad} is no moment`);
});
