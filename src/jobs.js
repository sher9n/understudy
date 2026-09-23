import { AsyncLocalStorage } from 'node:async_hooks';
import { db, id, now, background } from './db/index.js';
import config from './config.js';

const handlers = new Map();
// the jobs this process is running now, by id, so a shutdown can hand its measurements over (releaseMine)
const mine = new Map();

/* Which job the code running now belongs to, so a job that books its own next run is not
   mistaken for that next run. Without this, every job that schedules itself (the catalogue,
   provider health, the leaderboard, the hourly re-check, the purge) found itself still
   claimed, booked nothing, and then finished: each ran once per restart and never again. */
const running = new AsyncLocalStorage();

/* A claim this old belongs to a process that has gone away, because every job but a measurement
   finishes well within it. It no longer counts as the open copy of its job, or one left behind
   by a crash would stop that job from ever being booked again. A measurement can run longer, and
   notices for itself when the process running it has gone (by its heartbeat), so its claim
   counts for as long as it lasts: two measurements of one workload must never run side by side. */
const CLAIM_STALE_MS = 30 * 60000;

/** Register what a kind of job actually does. Returns { snoozeMs } to try again later. */
export function handle(kind, fn) { handlers.set(kind, fn); }

export async function enqueue(kind, payload = {}, { runAfter = now(), unique = null, sooner = false } = {}) {
  const row = { id: id('job'), kind, payload: JSON.stringify(payload), run_after: runAfter, created_at: now() };
  const insert = (x) => x.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, run_after, created_at)
              VALUES (@id, @kind, @payload, 'queued', 0, @run_after, @created_at)`).run(row);
  if (!unique) {
    await insert(db);
    return row.id;
  }
  /* Looking for a copy and booking one used to be two separate steps, so two callers arriving together
     both found none and both booked: two charges finishing at once queued two automatic top ups, which
     then ran side by side on the same payment key. The two steps now run in one transaction behind a
     lock on this job's kind and payload, so the second caller waits and finds the first one's copy. */
  return db.tx(async (tx) => {
    await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`job:${kind}:${row.payload}`);
    const open = await tx.prepare(
      `SELECT id, status, run_after FROM jobs WHERE kind = ? AND payload = ? AND id <> ?
          AND (status = 'queued' OR (status = 'claimed' AND (kind = 'eval_run' OR claimed_at >= ?)))`)
      .get(kind, row.payload, running.getStore() ?? '', now() - CLAIM_STALE_MS);
    // asked for sooner than the copy already booked: that copy is brought forward instead
    if (open && sooner && open.status === 'queued' && open.run_after > runAfter) {
      await tx.prepare(`UPDATE jobs SET run_after = ? WHERE id = ? AND status = 'queued'`).run(runAfter, open.id);
    }
    if (open) return open.id;
    await insert(tx);
    return row.id;
  });
}

/** One row at a time, claimed atomically so a restart cannot run it twice. Kinds that are already
 *  running as many at once as they may are stepped over, so one kind cannot hold up the rest. */
async function claim(skipKinds = []) {
  /* SKIP LOCKED is why this is safe with more than one worker: a row another worker has
     already taken is stepped over rather than waited for, so two runners never collide on
     the same job and neither of them blocks. */
  const r = await db.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? AND NOT (kind = ANY(?))
                   ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`).run(now(), now(), skipKinds);
  return r.rows[0] || null;
}

export async function runOnce({ skipKinds = [] } = {}) {
  const job = await claim(skipKinds);
  if (!job) return false;
  mine.set(job.id, job.kind);
  try {
    await background.run(true, () => runJob(job));
  } finally {
    mine.delete(job.id);
  }
  return true;
}

async function runJob(job) {
  const fn = handlers.get(job.kind);
  if (!fn) {
    await db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ?`)
      .run(`no handler for ${job.kind}`, job.id);
    return true;
  }
  /* A job goes back in the queue only if it is still this runner's. One cancelled while it ran,
     because somebody stopped the measurement it was about to start, stays cancelled: putting
     it back would start the very thing they stopped, half an hour later, with nobody asking. */
  try {
    const out = await running.run(job.id, () => fn(JSON.parse(job.payload || '{}'), job));
    if (out && out.snoozeMs) {
      await db.prepare(`UPDATE jobs SET status = 'queued', run_after = ?, error = ? WHERE id = ? AND status = 'claimed'`)
        .run(now() + out.snoozeMs, out.note ?? null, job.id);
    } else {
      await db.prepare(`UPDATE jobs SET status = 'done', error = NULL WHERE id = ? AND status = 'claimed'`).run(job.id);
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).slice(0, 500);
    if (job.attempts < 5) {
      const backoff = Math.min(60000 * 2 ** job.attempts, 900000);
      await db.prepare(`UPDATE jobs SET status = 'queued', run_after = ?, error = ? WHERE id = ? AND status = 'claimed'`)
        .run(now() + backoff, msg, job.id);
    } else {
      await db.prepare(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ?`).run(msg, job.id);
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'job', job: job.kind, id: job.id, ok: false, error: msg.slice(0, 200) }));
  }
}

let timer = null;
let stopping = false;

/* One scheduler, a fixed number of jobs at once, and at most EVAL_CONCURRENCY measurements among them.
   A tick used to start a whole new runner every five seconds while earlier ones were still busy, so a
   queue of measurements all ran side by side, sharing one per-model pace and the connections live
   calls use. */
let active = 0;
const activeByKind = new Map();
const limitOf = (kind) => (kind === 'eval_run' ? config.EVAL_CONCURRENCY : config.JOBS_CONCURRENCY);
let pumping = false;
async function pump() {
  if (pumping || stopping) return;
  pumping = true;
  try {
    while (!stopping && active < config.JOBS_CONCURRENCY) {
      const full = [...activeByKind.entries()].filter(([k, n]) => n >= limitOf(k)).map(([k]) => k);
      let job;
      try { job = await claim(full); } catch { break; }
      if (!job) break;
      active += 1;
      activeByKind.set(job.kind, (activeByKind.get(job.kind) || 0) + 1);
      mine.set(job.id, job.kind);
      const t0 = Date.now();
      background.run(true, () => runJob(job))
        .catch(() => { /* runJob records its own failures; the loop must not die */ })
        .finally(() => {
          mine.delete(job.id);
          active -= 1;
          activeByKind.set(job.kind, Math.max(0, (activeByKind.get(job.kind) || 1) - 1));
          if (job.kind !== 'learn' || Date.now() - t0 > 1000) {
            console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'job', job: job.kind, id: job.id, ms: Date.now() - t0 }));
          }
          void pump();
        });
    }
  } finally {
    pumping = false;
  }
}

export function startJobs() {
  if (!config.JOBS_ENABLED || timer) return;
  timer = setInterval(() => { void pump(); }, config.JOBS_TICK_MS);
  if (timer.unref) timer.unref();
  void pump();
}

export async function stopJobs() {
  stopping = true;
  if (timer) { clearInterval(timer); timer = null; }
}

/* A process being stopped (a deploy, a restart) hands its measurements over rather than leaving them
   saying "running" for EVAL_STALE_MIN minutes with nothing behind them. Their runs are marked as
   nothing running them (a heartbeat of zero, which reads as long gone), so the next process closes
   them as interrupted at once, and their jobs go back in the queue, so the measurement starts again
   there. One a person stopped is left alone: its job ends, as a stop should. */
export async function releaseMine() {
  const ids = [...mine].filter(([, kind]) => kind === 'eval_run').map(([jobId]) => jobId);
  if (!ids.length) return 0;
  await db.prepare(
    `UPDATE eval_runs SET heartbeat_at = 0
      WHERE status = 'running' AND stop_requested_at IS NULL AND job_id = ANY(?::text[])`).run(ids);
  return (await db.prepare(
    `UPDATE jobs SET status = 'queued', run_after = ?, error = 'handed over: a new version was starting'
      WHERE status = 'claimed' AND id = ANY(?::text[])
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id AND r.stop_requested_at IS NOT NULL)`)
    .run(now(), ids)).changes;
}

/* Anything claimed when the process died goes back in the queue at boot, with two exceptions for
   measurements. One a person stopped is not started again: its job ends here, where putting it back
   used to start a fresh measurement of the same workload over the Stop that had been pressed. And one
   something may still be running (its run wrote a heartbeat within EVAL_STALE_MIN, as the process a
   deploy is replacing still can) is left alone, so two measurements of one workload never run side by
   side; once its heartbeat is old, closeAbandoned closes it and lets its job go. */
export async function requeueStale() {
  const stale = now() - 600000;
  await db.prepare(
    `UPDATE jobs SET status = 'cancelled', error = 'stopped by you'
      WHERE kind = 'eval_run' AND status = 'claimed' AND claimed_at < ?
        AND EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id
                     AND (r.stop_requested_at IS NOT NULL OR r.status = 'stopped'))`).run(stale);
  return (await db.prepare(
    `UPDATE jobs SET status = 'queued' WHERE status = 'claimed' AND claimed_at < ?
        AND NOT (kind = 'eval_run' AND EXISTS (SELECT 1 FROM eval_runs r WHERE r.job_id = jobs.id
                   AND r.status = 'running' AND r.heartbeat_at >= ?))`)
    .run(stale, now() - config.EVAL_STALE_MIN * 60000)).changes;
}
