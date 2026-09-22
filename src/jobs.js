import { db, id, now } from './db/index.js';
import config from './config.js';

const handlers = new Map();

/** Register what a kind of job actually does. Returns { snoozeMs } to try again later. */
export function handle(kind, fn) { handlers.set(kind, fn); }

export async function enqueue(kind, payload = {}, { runAfter = now(), unique = null } = {}) {
  if (unique) {
    const open = await db.prepare(
      `SELECT id FROM jobs WHERE kind = ? AND status IN ('queued','claimed') AND payload = ?`)
      .get(kind, JSON.stringify(payload));
    if (open) return open.id;
  }
  const row = { id: id('job'), kind, payload: JSON.stringify(payload), run_after: runAfter, created_at: now() };
  await db.prepare(`INSERT INTO jobs (id, kind, payload, status, attempts, run_after, created_at)
              VALUES (@id, @kind, @payload, 'queued', 0, @run_after, @created_at)`).run(row);
  return row.id;
}

/** One row at a time, claimed atomically so a restart cannot run it twice. */
async function claim() {
  /* SKIP LOCKED is why this is safe with more than one worker: a row another worker has
     already taken is stepped over rather than waited for, so two runners never collide on
     the same job and neither of them blocks. */
  const r = await db.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_at = ?, attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ?
                   ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`).run(now(), now());
  return r.rows[0] || null;
}

export async function runOnce() {
  const job = await claim();
  if (!job) return false;
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
    const out = await fn(JSON.parse(job.payload || '{}'), job);
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
  }
  return true;
}

let timer = null;
let stopping = false;

export function startJobs() {
  if (!config.JOBS_ENABLED || timer) return;
  const tick = async () => {
    if (stopping) return;
    try { while (await runOnce()) { if (stopping) break; } } catch { /* the loop must not die */ }
  };
  timer = setInterval(tick, config.JOBS_TICK_MS);
  if (timer.unref) timer.unref();
  tick();
}

export async function stopJobs() {
  stopping = true;
  if (timer) { clearInterval(timer); timer = null; }
}

/** Anything claimed when the process died goes back in the queue at boot. */
export async function requeueStale() {
  return (await db.prepare(
    `UPDATE jobs SET status = 'queued' WHERE status = 'claimed' AND claimed_at < ?`)
    .run(now() - 600000)).changes;
}
