import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import config from './config.js';

/* How many pages a PDF sent inline has, for the most a call reading it can cost (see callShape).

   Counted by a real parser, because a page can be a couple of hundred bytes and no count of bytes is a
   bound; and counted in a worker thread with a time limit and a memory limit, because a small file can
   be built to make a parser run for ever or unpack to gigabytes, and on the server's own thread that
   stalls every request. A file that cannot be counted in time, or within the memory allowed, answers
   { ok: false } and the call is refused; one the parser simply cannot read (damaged, or encrypted in a
   way it does not follow) is counted at a page per hundred bytes, which no real PDF comes near.

   Counting is shared fairly. Only COUNTERS_AT_ONCE files are counted at a time on the server, since each
   counter may use up to 256 MB; each workspace has one file counted at a time, its others waiting their
   own turn, so one workspace sending many files cannot hold every counter while others wait; and a
   workspace whose files failed to count REST_AFTER times in ten minutes is told to wait, without its
   files being parsed, until they are older than that. A file that waits longer than twice the time limit
   answers { ok: false, busy: true }, which the caller is told to send again shortly.

   A count is remembered, so a file sent again is not parsed again; a file that could not be counted is
   refused again for ten minutes without being parsed, then tried afresh, since a count that ran out of
   time under load may well fit on a quiet server. */

const COUNTERS_AT_ONCE = 2;
const FAILED_FOR_MS = 10 * 60000;
const REST_AFTER = 3;
const memo = new Map();
let active = 0;
const waiting = [];
// per workspace: the end of its line of files, how many of its files wait there, and when its files failed
const lines = new Map();
let held = 0;
const failures = new Map();

/** How many files are being counted, wait for a counter, and wait behind their own workspace's. */
export const pdfCounting = () => ({ active, waiting: waiting.length, held });

function turn(ms) {
  if (active < COUNTERS_AT_ONCE) {
    active += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      resolve(false);
    }, ms);
    waiting.push(entry);
  });
}

// a finished counter hands its place straight to the next file waiting, or gives it up
function done() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true);
  } else {
    active -= 1;
  }
}

/* A workspace's own turn: after the file ahead of it from the same workspace. Answers the function that
   ends the turn, or null when the wait ran past `ms` (its place is given up, so the files behind it are
   not held up by it). */
function ownTurn(owner, ms) {
  if (!owner) return Promise.resolve(() => {});
  const ahead = lines.get(owner) || Promise.resolve();
  let end;
  const mine = new Promise((r) => { end = r; });
  const tail = ahead.then(() => mine);
  lines.set(owner, tail);
  tail.then(() => { if (lines.get(owner) === tail) lines.delete(owner); });
  held += 1;
  return new Promise((resolve) => {
    let gaveUp = false;
    const timer = setTimeout(() => { gaveUp = true; held -= 1; end(); resolve(null); }, ms);
    ahead.then(() => {
      if (gaveUp) return;
      clearTimeout(timer);
      held -= 1;
      resolve(end);
    });
  });
}

const recentFailures = (owner) => {
  const list = (failures.get(owner) || []).filter((t) => Date.now() - t < FAILED_FOR_MS);
  if (list.length) failures.set(owner, list); else failures.delete(owner);
  return list.length;
};

function count(bytes, limitMs) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./pdf-pages-worker.js', import.meta.url), {
        workerData: { bytes: new Uint8Array(bytes) },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch {
      resolve({ ok: false, reason: 'could not start the counter' });
      return;
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'took too long to count' }), limitMs);
    worker.once('message', (m) => finish(m?.ok
      ? { ok: true, pages: Math.max(1, Number(m.pages) || 1) }
      // readable only as bytes: a page per hundred of them, far more than any real file has
      : { ok: true, pages: Math.max(1, Math.ceil(bytes.length / 100)), guessed: true }));
    worker.once('error', () => finish({ ok: false, reason: 'too large to count' }));
    worker.once('exit', (code) => { if (code !== 0) finish({ ok: false, reason: 'too large to count' }); });
  });
}

export async function pdfPages(dataUrl, { owner = null } = {}) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  const key = crypto.createHash('sha1').update(b64).digest('hex');
  const hit = memo.get(key);
  if (hit && (hit.out.ok || Date.now() - hit.at < FAILED_FOR_MS)) return hit.out;
  if (owner && recentFailures(owner) >= REST_AFTER) {
    return { ok: false, busy: true, reason: 'resting',
      message: 'Several PDFs from this workspace could not be counted in the last ten minutes, so PDFs are not read for it for a few minutes. Send the file as text, or try again later.' };
  }
  const limitMs = config.PDF_COUNT_MS;
  const endTurn = await ownTurn(owner, limitMs * 2);
  if (!endTurn) {
    return { ok: false, busy: true, reason: 'queued too long',
      message: 'This workspace is sending PDFs faster than they can be read. Send them a few at a time, or send this one again in a moment.' };
  }
  let out;
  try {
    // the same file, counted by the one ahead of it while it waited
    const now = memo.get(key);
    if (now && (now.out.ok || Date.now() - now.at < FAILED_FOR_MS)) return now.out;
    if (!(await turn(limitMs * 2))) {
      return { ok: false, busy: true, reason: 'counters busy',
        message: 'Too many PDFs are being read at once to work out what this call would cost. Send it again in a moment.' };
    }
    try {
      out = await count(Buffer.from(b64, 'base64'), limitMs);
    } finally {
      done();
    }
  } finally {
    endTurn();
  }
  if (!out.ok && owner) failures.set(owner, [...(failures.get(owner) || []), Date.now()]);
  if (failures.size > 10000) failures.clear();
  memo.set(key, { out, at: Date.now() });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return out;
}
