import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* How measurement calls to one model are paced (takeSlot and giveBack in src/openrouter.js): a few out at once,
   no fixed gap, and a model that turns calls away for coming too fast slowed until it takes them again. It used
   to be a fixed 3.2 s between any two measurement calls to a model, the judge included, and a measurement of
   written answers took an hour. */

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'stand-in';
const { default: config } = await import('../src/config.js');
const { takeSlot, giveBack, paceNow, chat } = await import('../src/openrouter.js');

let seq = 0;
const model = () => `pace/model-${process.pid}-${(seq += 1)}`;
const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => { setTimeout(() => r(false), 30); })]);
const set = (values) => {
  const was = {};
  for (const [k, v] of Object.entries(values)) { was[k] = config[k]; config[k] = v; }
  return () => Object.assign(config, was);
};

test('a few of a model\'s measurement calls are out at once, and the next goes the moment one comes back', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 2, MODEL_MIN_GAP_MS: 0 });
  try {
    const m = model();
    const a = await takeSlot(m, true);
    const b = await takeSlot(m, true);
    const third = takeSlot(m, true);
    assert.equal(await settled(third), false, 'two out: the third waits');
    assert.deepEqual(paceNow(m), { out: 2, gap: 0, waiting: 1 });
    // another model is never held up by this one
    const other = await takeSlot(model(), true);
    assert.ok(other, 'another model goes at once');
    giveBack(a);
    assert.equal(await settled(third), true, 'one came back: the third goes');
    giveBack(b);
    giveBack(await third);
    giveBack(other);
    assert.equal(paceNow(m).out, 0);
  } finally { undo(); }
});

test('a customer\'s own call is never paced, however busy the model is', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 1, MODEL_MIN_GAP_MS: 0 });
  try {
    const m = model();
    const held = await takeSlot(m, true);
    assert.equal(await takeSlot(m, false), null, 'not paced: no turn to wait for');
    giveBack(held);
  } finally { undo(); }
});

test('calls waiting for a model go in the order they asked', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 1, MODEL_MIN_GAP_MS: 0 });
  try {
    const m = model();
    const first = await takeSlot(m, true);
    const order = [];
    const waits = [1, 2, 3].map((n) => takeSlot(m, true).then((slot) => { order.push(n); return slot; }));
    giveBack(first);
    for (const w of waits) giveBack(await w);
    assert.deepEqual(order, [1, 2, 3]);
  } finally { undo(); }
});

test('a model that turns calls away for coming too fast is slowed, and eases off again as it takes them', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 4, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 120, MODEL_BACKOFF_MAX_MS: 480, MODEL_BACKOFF_EASE_AFTER: 2 });
  try {
    const m = model();
    giveBack(await takeSlot(m, true), { refused: true });
    assert.equal(paceNow(m).gap, 120, 'turned away once: its calls are spaced out');
    const t0 = Date.now();
    const next = await takeSlot(m, true);
    assert.ok(Date.now() - t0 >= 100, `and the next waits for the gap: ${Date.now() - t0} ms`);
    giveBack(next, { refused: true });
    assert.equal(paceNow(m).gap, 240, 'turned away again: the gap doubles');
    giveBack(await takeSlot(m, true), { refused: true });
    giveBack(await takeSlot(m, true), { refused: true });
    assert.equal(paceNow(m).gap, 480, 'never past the most it may be slowed');
    // taken again: it eases off by half every two in a row, and to none once under half where it started
    const gaps = [];
    for (let k = 0; k < 9; k += 1) {
      giveBack(await takeSlot(m, true));
      gaps.push(paceNow(m).gap);
    }
    assert.deepEqual(gaps, [480, 240, 240, 120, 120, 60, 60, 0, 0]);
  } finally { undo(); }
});

test('a fixed gap can still be set, and spaces the calls it paces', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 4, MODEL_MIN_GAP_MS: 150 });
  try {
    const m = model();
    const t0 = Date.now();
    const a = await takeSlot(m, true);
    const b = await takeSlot(m, true);
    assert.ok(Date.now() - t0 >= 130, `the second a gap after the first: ${Date.now() - t0} ms`);
    giveBack(a);
    giveBack(b);
  } finally { undo(); }
});

test('a measurement call turned away for coming too fast is tried again, and slows that model', async () => {
  let asked = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      asked += 1;
      if (asked === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.05' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } }));
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const undo = set({ OPENROUTER_BASE: `http://127.0.0.1:${server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 60, MODEL_BACKOFF_EASE_AFTER: 20 });
  try {
    const m = model();
    const out = await chat({ messages: [{ role: 'user', content: 'hello' }] }, m, { pace: true, retries: 2 });
    assert.equal(out.json.choices[0].message.content, 'ok', 'answered on the second try');
    assert.equal(asked, 2);
    assert.equal(paceNow(m).gap, 60, 'and the model it was sent to is now spaced out');
    assert.equal(paceNow(m).out, 0, 'with its turn given back');
  } finally {
    undo();
    await new Promise((r) => { server.close(r); });
  }
});
