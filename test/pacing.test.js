import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* How measurement calls to one model are paced (takeSlot and giveBack in src/openrouter.js): a few out at once,
   no fixed gap, and a model that turns calls away for coming too fast slowed until it takes them again. It used
   to be a fixed 3.2 s between any two measurement calls to a model, the judge included, and a measurement of
   written answers took an hour. */

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'stand-in';
const { default: config } = await import('../src/config.js');
const { takeSlot, giveBack, paceNow, chat, streamCollect, UpstreamError, atLongestWait } = await import('../src/openrouter.js');

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

/* A provider that cannot keep up: a refusal while the model is already given the longest wait between calls is what a
   test holds against it (EVAL_KEEP_UP_REFUSALS, the owner's rule of 26 Sep 2026), so giveBack says which ones those are,
   and a call carries how many of its tries were, answered or not. */

test('a call counts as sent at the longest wait only once its model is already given it, read as the call is sent', async () => {
  const undo = set({ MODEL_MAX_IN_FLIGHT: 4, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 10, MODEL_BACKOFF_MAX_MS: 40, MODEL_BACKOFF_EASE_AFTER: 2 });
  try {
    const m = model();
    const sent = [];
    for (let k = 0; k < 5; k += 1) {
      const slot = await takeSlot(m, true);
      sent.push(atLongestWait(slot));
      giveBack(slot, { refused: true });
    }
    // the gap goes 10, 20, 40: only the calls sent once it is at 40 are sent at the longest wait
    assert.deepEqual(sent, [false, false, false, true, true]);
    assert.equal(atLongestWait(null), false, "a call that is never paced, such as a customer's own, never is");

    /* Two calls out at once, both sent while the gap was still growing: the first's refusal takes the gap to the longest
       wait while the second is still out, and the second was not sent at it, however its refusal comes back. */
    const n = model();
    giveBack(await takeSlot(n, true), { refused: true });
    giveBack(await takeSlot(n, true), { refused: true });
    assert.equal(paceNow(n).gap, 20);
    const c = await takeSlot(n, true);
    const d = await takeSlot(n, true);
    const [cSent, dSent] = [atLongestWait(c), atLongestWait(d)];
    giveBack(c, { refused: true });
    assert.equal(paceNow(n).gap, 40, "the first refusal brought the gap to the longest wait");
    giveBack(d, { refused: true });
    assert.deepEqual([cSent, dSent], [false, false], 'neither was sent at it, so neither refusal counts');
  } finally { undo(); }
});

test('a limit of none switches the longest wait off, and with it any count', () => {
  const undo = set({ MODEL_BACKOFF_MAX_MS: 0 });
  try {
    assert.equal(atLongestWait({ gap: 0 }), false, 'no longest wait to be sent at');
  } finally { undo(); }
});

// a provider that turns the first `refusals` calls away for coming too fast, then answers (or never does, with Infinity)
async function crowded(refusals) {
  let asked = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      asked += 1;
      if (asked <= refusals) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.001' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } }));
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { server, asked: () => asked };
}

test('a call says how many of its tries were turned away at the longest wait, whether it was answered in the end or not', async () => {
  const p = await crowded(3);
  // the longest wait is reached on the first refusal, so the second and third find it there
  const undo = set({ OPENROUTER_BASE: `http://127.0.0.1:${p.server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 5,
    MODEL_BACKOFF_MAX_MS: 5, MODEL_BACKOFF_EASE_AFTER: 20, UPSTREAM_RETRY_WAIT_MAX_MS: 5 });
  try {
    const out = await chat({ messages: [{ role: 'user', content: 'hello' }] }, model(), { pace: true, retries: 3 });
    assert.equal(out.json.choices[0].message.content, 'ok', 'answered on the fourth try');
    assert.equal(out.refusedAtLongest, 2, 'two of its refusals came at the longest wait');
  } finally {
    undo();
    await new Promise((r) => { p.server.close(r); });
  }
  const never = await crowded(Infinity);
  const undo2 = set({ OPENROUTER_BASE: `http://127.0.0.1:${never.server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 5,
    MODEL_BACKOFF_MAX_MS: 5, MODEL_BACKOFF_EASE_AFTER: 20, UPSTREAM_RETRY_WAIT_MAX_MS: 5 });
  try {
    const err = await chat({ messages: [{ role: 'user', content: 'hello' }] }, model(), { pace: true, retries: 2 }).then(() => null, (e) => e);
    assert.ok(err instanceof UpstreamError && err.status === 429, `turned away every time: ${err?.status}`);
    assert.equal(err.refusedAtLongest, 2, 'and the refusal it ends on carries the count too');
    // a customer's own call is never paced, so nothing it meets is held against the model
    const live = await chat({ messages: [{ role: 'user', content: 'hello' }] }, model(), { pace: false, retries: 1 }).then(() => null, (e) => e);
    assert.equal(live.refusedAtLongest, 0);
  } finally {
    undo2();
    await new Promise((r) => { never.server.close(r); });
  }
});

test("a test's streamed call carries the same count, answered in one piece or not answered at all", async () => {
  const p = await crowded(2);
  const undo = set({ OPENROUTER_BASE: `http://127.0.0.1:${p.server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 5,
    MODEL_BACKOFF_MAX_MS: 5, MODEL_BACKOFF_EASE_AFTER: 20, UPSTREAM_RETRY_WAIT_MAX_MS: 5 });
  try {
    const out = await streamCollect({ messages: [{ role: 'user', content: 'hello' }] }, model(), { retries: 3 });
    assert.equal(out.json.choices[0].message.content, 'ok', 'a provider that ignores streaming is read in one piece');
    assert.equal(out.refusedAtLongest, 1, 'one refusal came at the longest wait');
  } finally {
    undo();
    await new Promise((r) => { p.server.close(r); });
  }
  const never = await crowded(Infinity);
  const undo2 = set({ OPENROUTER_BASE: `http://127.0.0.1:${never.server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 5,
    MODEL_BACKOFF_MAX_MS: 5, MODEL_BACKOFF_EASE_AFTER: 20, UPSTREAM_RETRY_WAIT_MAX_MS: 5 });
  try {
    const err = await streamCollect({ messages: [{ role: 'user', content: 'hello' }] }, model(), { retries: 3 }).then(() => null, (e) => e);
    assert.ok(err instanceof UpstreamError && err.status === 429, `turned away every time: ${err?.status}`);
    assert.equal(err.refusedAtLongest, 3, 'three of its four refusals came at the longest wait');
  } finally {
    undo2();
    await new Promise((r) => { never.server.close(r); });
  }
});

test("a test's call answered as a stream after refusals carries its count through the stream", async () => {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      n += 1;
      if (n <= 3) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.001' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'gen-1', choices: [{ delta: { content: 'o' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'k' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const undo = set({ OPENROUTER_BASE: `http://127.0.0.1:${server.address().port}`, MODEL_MIN_GAP_MS: 0, MODEL_BACKOFF_START_MS: 5,
    MODEL_BACKOFF_MAX_MS: 5, MODEL_BACKOFF_EASE_AFTER: 20, UPSTREAM_RETRY_WAIT_MAX_MS: 5 });
  try {
    const out = await streamCollect({ messages: [{ role: 'user', content: 'hello' }] }, model(), { retries: 3 });
    assert.equal(out.json.choices[0].message.content, 'ok', 'the streamed answer is put back together');
    assert.equal(out.refusedAtLongest, 2, 'and two of the refusals before it came at the longest wait');
  } finally {
    undo();
    await new Promise((r) => { server.close(r); });
  }
});
