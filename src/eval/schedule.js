import { db, now } from '../db/index.js';
import config from '../config.js';
import { FOUND, OUTCOME_OF, cheaperCleared, confirmed } from './outcome.js';
import { wouldTry, usableCalls, unseenCalls } from './plan.js';
import { callsToClear } from './compare.js';
import { optimizeFor } from './score.js';
import { HANDED_OVER, enqueue, wakeJobs } from '../jobs.js';
import { gateEval, skipNeedUsd } from '../billing.js';

/* When a workload is next measured by itself.
 *
 * A re-check that keeps finding what it found last time is paying for the same answer again, so each
 * one that changes nothing spaces the next one out, doubling up to EVAL_BACKOFF_MAX_DOUBLINGS times
 * the workspace's own rhythm. One that changed something (a switch, a switch back, a new candidate, a
 * candidate that needs a look) goes back to that rhythm. And something that could matter to a
 * workload, a model a measurement of it would try or a price that moved, brings its next check
 * forward: never sooner than the workspace's rhythm after its last measurement, which Settings
 * promises is "at most this often", and never sooner than EVAL_NUDGE_MIN_DAYS. A catalogue that
 * changes every week would otherwise measure everything every week. Whether a measurement nobody
 * asked for then actually runs is the plan's decision: only when what it can be expected to find pays
 * for it (see worthOf).
 *
 * Every measurement that runs by itself moves this booking when it ends, however it ends: the hourly
 * pass starts one for any workload whose booking has come due, so a measurement that ended without
 * moving it was started again within the hour. */

const DAY = 86400000;
const HOUR = 3600000;
/* The least a measurement that failed waits before it is tried again by itself, doubled each time it
   fails again. The job that ran it retries a few times on its own first, half an hour apart, which is
   what a passing outage needs; this is what follows once those are spent. */
const RETRY_HOURS = 6;

/** How often a workspace measures by itself, in days; zero means never. */
export async function cadenceOf(workspaceId) {
  const ws = await db.prepare('SELECT measure_every_days FROM workspaces WHERE id = ?').get(workspaceId);
  const d = ws?.measure_every_days === null || ws?.measure_every_days === undefined
    ? config.MEASURE_EVERY_DAYS : Number(ws.measure_every_days);
  return d > 0 ? d : 0;
}

/** After a measurement: when the next is due, and the streak of ones that changed nothing. */
export async function scheduleNext(workloadId, { changed }) {
  const w = await db.prepare('SELECT workspace_id, recheck_streak FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = await cadenceOf(w.workspace_id);
  const streak = changed ? 0 : Math.min(config.EVAL_BACKOFF_MAX_DOUBLINGS, Number(w.recheck_streak || 0) + 1);
  // whole milliseconds: the column is a bigint, and a fraction of one is refused
  const at = cadence ? Math.round(now() + cadence * DAY * 2 ** streak) : null;
  // and whatever it was waiting for, it has had: a measurement books its own next one
  await db.prepare('UPDATE workloads SET recheck_after = ?, recheck_streak = ?, measure_at_calls = NULL WHERE id = ?')
    .run(at, streak, workloadId);
  return at;
}

/* A measurement nobody asked for that the plan turned down only because the workload had too few calls to show
   anything waits for the calls, not for a time. It keeps how many usable calls it needs, and every call that
   arrives looks at that count (measureWhenReady in src/proxy.js): the one that reaches it starts the measurement.
   It used to be booked for when they were guessed to arrive, from the pace so far and never sooner than six
   hours, and a new workload that had them within the hour waited the six. It is booked a whole rhythm out as
   well, so the hourly pass still looks at one whose calls stop coming. Where it already has a booking that a test made
   (`keepBooking`: the end of a test, which has just made it, and waitToLookAgain in src/proxy.js), that booking is kept as
   the fallback: made again a single rhythm out, it threw away the doubling after re-checks that changed nothing, and on a
   steady workload, whose count of calls stays level and may never reach what it waits for, the fallback came every
   rhythm instead of backing off; nor may waiting for calls push a test later than it was booked. */
export async function waitForCalls(workloadId, calls, { keepBooking = false } = {}) {
  const w = await db.prepare('SELECT workspace_id, recheck_after FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = (await cadenceOf(w.workspace_id)) || 7;
  const had = w.recheck_after === null || w.recheck_after === undefined ? null : Number(w.recheck_after);
  const at = keepBooking && had !== null ? had : Math.round(now() + cadence * DAY);
  await db.prepare('UPDATE workloads SET measure_at_calls = ?, recheck_after = ? WHERE id = ?').run(Math.round(calls), at, workloadId);
  return at;
}

/** The newest measurement of a workload that compared models: what a second look and a sharper test are read from. */
export async function latestCompared(workloadId) {
  return (await db.prepare(
    `SELECT id, created_at, finished_at, sample_size, floor_pct, choice_json, trigger FROM eval_runs
      WHERE workload_id = ? AND status = 'done' AND ${OUTCOME_OF()} = 'compared'
      ORDER BY created_at DESC LIMIT 1`).get(workloadId)) || null;
}

/* How a second look can end without the model having been found wanting, so that it is still owed one: there were too few
   calls it had never seen ('insufficient'), or the test never reached it ('not_reached': past the EVAL_CONFIRM_TRIES a
   test looks at twice, or the test was cut short). Not a row with nothing written: the setup serving a workload is never
   looked at twice and keeps none, and read as owed it was looked at again as a candidate once it was switched back. */
export const OWED_LOOKS = ['insufficient', 'not_reached'];

/* What is owed a second look: in the newest measurement that compared anything, what it would still offer (cheaperCleared:
   priced, cheaper, never found wanting on a second look) whose second look never came (OWED_LOOKS). However the test
   ended: it used to be owed only when the first second look it took was short of calls, so one whose first look found the
   first in line wanting, and never reached the five behind it that had matched every answer, left them for a whole rhythm
   (an invoice workload on 25 Sep 2026). Nothing is owed once one of them passed both looks: that one is offered, or was
   switched to. What a second-look run then races is everything owed, the ones the looks never reached included: its
   results are what the page offers from then on, and racing only the ones found short dropped the rest off the page. Only
   for a workload still on its customer's own model: one switched is re-checked, with what serves it, by the usual
   measurement. Answers { runId, keys, models, sampled } or null: the rows by name, the setups a second-look run races by
   the name each one's result carries (a strategy's by its parts, rebuilt by the run as usual), and the calls that
   measurement drew, which the second-look run's first look draws again, answered from what it already bought. */
export async function pendingSecondLook(workloadId) {
  const w = await db.prepare('SELECT routed_model FROM workloads WHERE id = ?').get(workloadId);
  if (!w || w.routed_model) return null;
  const last = await latestCompared(workloadId);
  if (!last) return null;
  /* Nor from a test taken while a setup served the workload and held up there (the run's choice: holding, servingKept):
     the looks stop at what serves, so what stood behind it was never reached for want of a look, and a switch back
     afterwards (the live watch) is no reason to look at them again before the next test. */
  let choice = null;
  try { choice = JSON.parse(last.choice_json || 'null'); } catch { choice = null; }
  if (choice?.holding || choice?.servingKept) return null;
  const results = await db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(last.id);
  const offered = cheaperCleared(results);
  if (offered.some((r) => confirmed(r))) return null;
  const waiting = offered.filter((r) => OWED_LOOKS.includes(r.confirm_verdict ?? null));
  if (!waiting.length) return null;
  const models = new Set();
  for (const r of waiting) {
    let spec = null;
    try { spec = r.arm_json ? JSON.parse(r.arm_json) : null; } catch { spec = null; }
    const parts = spec?.kind === 'cascade' ? [spec.first]
      : spec?.kind === 'router' ? (Array.isArray(spec.options) ? spec.options : [spec.cheap, spec.strong]) : [];
    if (parts.length) { for (const p of parts) if (p?.model) models.add(p.key || p.model); } else models.add(r.model_id);
  }
  const sampled = new Set((await db.prepare('SELECT call_id FROM eval_samples WHERE run_id = ?').all(last.id)).map((x) => x.call_id));
  return { runId: last.id, keys: waiting.map((r) => r.model_id), models, sampled };
}

/* After a measurement whose second look found too few new calls: booked to look again the moment enough have arrived, as a
   second-look run (trigger 'second_look'), rather than at the next measurement a whole rhythm out. A whole new measurement
   drew its own first look from the new calls first and left its second look short again, so a workload with little
   traffic never switched: on 26 Sep 2026 an invoice workload had nine models matching every answer, none ever looked at
   twice. `least` is how many calls a second look needs that no measurement has drawn: it is booked for that many of them
   (measure_at_calls), and counted against the calls no measurement has drawn (unseenCalls), which only grow while calls
   arrive. Booked against every usable call instead, a steady workload whose old calls leave the thirty days as new ones
   come never reached it. Only where the workspace measures by itself. Answers when it is booked for, or null. */
export async function bookSecondLook(workload, { least, keepBooking = false }) {
  if (!(await cadenceOf(workload.workspace_id))) return null;
  if (!(await pendingSecondLook(workload.id))) return null;
  const need = Math.max(1, Math.ceil(least));
  if (need > config.EVAL_POOL_MAX) return null;
  return waitForCalls(workload.id, need, { keepBooking });
}

/* The fewest calls no measurement has drawn that a second look at a `floorPct` bar needs, as the run that takes it counts
   them (lookAgain in src/eval/run.js): a perfect run's, held to a one-sided 97.5% bound for a workload optimizing for
   quality and 95% otherwise. */
export async function secondLookLeast(workload, floorPct) {
  const ws = await db.prepare('SELECT default_routing_mode FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const z = optimizeFor(workload, ws, config.ROUTING_MODE_DEFAULT) === 'quality' ? config.CAUTIOUS_Z : undefined;
  return callsToClear(Number(floorPct), z);
}

/* A test that could have said more with more calls: it found nothing to switch to, and something came close. A model
   straddled the bar ('review', "Close to clearing"), passed once and came close on its second look without passing there
   ('review' again, "passed once, but not on new requests"), or passed and was left out as not sure enough by a workload
   optimizing for quality. On a sample smaller than a test can take (EVAL_SAMPLE_MAX), a test on twice as many calls reads
   each model's rate far more closely, so the next one waits for the calls that give it that sample rather than for a
   whole rhythm: a summary workload on 26 Sep 2026 was close on 27 calls, had 154 four days later, and was booked a month
   out. Every test takes half the calls there are (sampleSizeFor in src/eval/plan.js), so a sample of S needs 2S of them.
   Answers { calls, sample }, how many usable calls to wait for and the sample they give, or null: none when something is
   offered (a second look, or a person's yes, answers that), when the sample was already as big as a test takes, and when
   nothing came close (one found clearly worse, too slow or unable to keep up is not read more closely by more calls).
   Only one that would save anything counts as close: one priced at or above the customer's own model, our fee
   included, could never be offered however closely it was read (the price rule of cheaperCleared). */
export function sharperNeed(run, results) {
  const sample = Number(run?.sample_size) || 0;
  if (!(sample > 0) || sample >= config.EVAL_SAMPLE_MAX) return null;
  if (cheaperCleared(results).length) return null;
  const refCost = results.find((r) => r.verdict === 'reference')?.cost_month_usd;
  const ceiling = 1 / (1 + (Number(config.ROUTING_FEE_PCT) || 0) / 100);
  const cheaper = (r) => r.cost_month_usd != null && refCost != null && Number(r.cost_month_usd) < Number(refCost)
    && (r.cost_ratio == null || Number(r.cost_ratio) < ceiling);
  const close = results.some((r) => cheaper(r) && (r.verdict === 'review'
    || (r.verdict === 'cleared' && (r.confirm_verdict === 'review' || r.confirm_verdict === 'left_out'))));
  if (!close) return null;
  const target = Math.min(config.EVAL_SAMPLE_MAX, 2 * sample);
  const calls = Math.ceil(target / config.EVAL_SAMPLE_SHARE);
  return calls <= config.EVAL_POOL_MAX ? { calls, sample: target } : null;
}

/* What a workload waiting for calls waits for, and has: calls no measurement has drawn for a second look (bookSecondLook),
   and otherwise calls a measurement can use. Read by what starts it (startIfReady in src/proxy.js) and by what shows it
   (the workload page and the approval card). Null when it waits for none. */
export async function waitOf(workload) {
  const need = Number(workload?.measure_at_calls);
  if (!(need > 0)) return null;
  const second = workload.status !== 'new' && !!(await pendingSecondLook(workload.id));
  return { need, have: second ? await unseenCalls(workload) : await usableCalls(workload), secondLook: second };
}

/* A measurement nobody asked for that the plan turned down for any other reason: looked at again later,
   rather than at every hourly pass. After one of the workspace's own periods when it would cost more than a test may
   spend without asking, which waits for a person to start it (a week when it measures only when asked, for the page's
   sake), or after `waitMs`. */
export async function deferAutomatic(workloadId, { waitMs = null } = {}) {
  const w = await db.prepare('SELECT workspace_id FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = (await cadenceOf(w.workspace_id)) || 7;
  const wait = waitMs !== null && Number.isFinite(waitMs)
    ? Math.max(6 * HOUR, Math.min(cadence * DAY, waitMs)) : cadence * DAY;
  const at = Math.round(now() + wait);
  await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(at, workloadId);
  return at;
}

/* Credit has just landed (src/stripe-webhook.js): every test that was waiting for it, its last look turned down for want of
   balance (noteSkip in src/eval/run.js), that the balance now covers by the rule that turned it down (gateEval), is due now
   and queued at once, rather than at its next look up to six hours later, so "add credit to continue running tests" means
   what it says. Only in a workspace that tests by itself, and never one being tested or already queued. Answers the
   workloads it queued. */
export async function resumeAfterCredit(workspaceId) {
  if (!(await cadenceOf(workspaceId))) return [];
  const rows = await db.prepare(
    `SELECT w.id, w.test_skip_json FROM workloads w
      WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL AND w.test_skip_json LIKE '%"reason":"balance"%'
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'eval_run' AND j.status IN ('queued', 'claimed')
                          AND (j.payload::jsonb ->> 'workloadId') = w.id)`).all(workspaceId);
  const queued = [];
  for (const w of rows) {
    if (!(await gateEval(workspaceId, { estimatedUsd: skipNeedUsd(w.test_skip_json) ?? 0.01 })).ok) continue;
    await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(now(), w.id);
    await enqueue('eval_run', { workloadId: w.id, trigger: 'automatic' }, { unique: true });
    queued.push(w.id);
  }
  if (queued.length) wakeJobs();
  return queued;
}

/* Moved later, never earlier: a booking already further out (a backoff after re-checks that found
   nothing new) is left where it is. Answers when the next one is due. */
async function putOff(workloadId, at) {
  const r = await db.prepare(
    `UPDATE workloads SET recheck_after = GREATEST(COALESCE(recheck_after, 0), ?::bigint)
      WHERE id = ? RETURNING recheck_after`).run(Math.round(at), workloadId);
  return r.rows[0] ? Number(r.rows[0].recheck_after) : null;
}

/* A second look that did not run, because nothing waited for it any more or what it waited for could no longer be
   tested: the booking the workload had is kept (the call that started it no longer brings it in, see startIfReady in
   src/proxy.js), and is at least SECOND_LOOK_RETRY_HOURS out, so no whole test follows within the hour. It used to be booked
   a whole rhythm from now, which put the workload's next test later than it had been booked for. */
const SECOND_LOOK_RETRY_HOURS = 6;
export async function deferSecondLook(workloadId) {
  return putOff(workloadId, now() + SECOND_LOOK_RETRY_HOURS * HOUR);
}

/* A person stopped a measurement, or took one out of the queue before it started. The next one
   nobody asks for waits a whole rhythm from now. Stopping one used to be answered by the hourly pass
   starting another within the hour, because the booking the first was made from had come due: a new
   workload's first measurement is booked an hour ahead, so stopping it did not stick. A workspace
   that measures only when asked has nothing booked to move. */
export async function deferAfterStop(workloadId) {
  const w = await db.prepare('SELECT workspace_id FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = await cadenceOf(w.workspace_id);
  if (!cadence) return null;
  return await putOff(workloadId, now() + cadence * DAY);
}

/* A measurement that ended without finding anything, for a reason that is nobody's verdict: the
   provider was too busy, our own account with it needed attention, the balance ran out, or something
   broke here. The next one nobody asks for waits RETRY_HOURS, twice as long for each one in a row
   that ended the same way, and never longer than the workspace's rhythm. The hourly pass used to
   start it again every hour, and every attempt paid for a bar of its own. */
export async function deferAfterFailure(workloadId) {
  const w = await db.prepare('SELECT workspace_id FROM workloads WHERE id = ?').get(workloadId);
  if (!w) return null;
  const cadence = await cadenceOf(w.workspace_id);
  if (!cadence) return null;
  /* the ones in a row that ended this way, since the last that found anything, this one included; never one handed over
     by a process that was going (src/jobs.js HANDED_OVER), which started again at once and failed at nothing */
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM eval_runs r
      WHERE r.workload_id = ? AND (r.status = 'failed' OR (r.status = 'done' AND ${OUTCOME_OF('r.')} = 'no_balance'))
        AND COALESCE(r.error, '') NOT LIKE ?
        AND r.created_at >= COALESCE((SELECT MAX(x.created_at) FROM eval_runs x WHERE x.workload_id = ? AND ${FOUND('x.')}), 0)`)
    .get(workloadId, `${HANDED_OVER}%`, workloadId);
  const inRow = Math.max(1, Number(row?.n || 0));
  const wait = Math.min(cadence * DAY, RETRY_HOURS * HOUR * 2 ** Math.min(10, inRow - 1));
  return await putOff(workloadId, now() + wait);
}

/* Which of a workspace's workloads the hourly pass measures again now: due by their own booking where they have
   one (spaced out while re-checks keep confirming, brought forward by a change that could matter), otherwise by
   the workspace's rhythm of `days`. Never one being measured, or one already waiting in the queue: that
   measurement answers the pass. A booking can come due while its measurement is still going, because a new
   workload's is held only an hour for it to start, and a measurement can take longer than that, or wait its turn
   behind two others first. Queued again then, it waited behind the two and started over the moment the first
   ended: on 24 Sep two workloads were measured twice back to back that way. Answers their ids. */
export async function dueForRecheck(workspaceId, days) {
  return db.prepare(
    `SELECT w.id FROM workloads w
      WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL
        AND ((w.recheck_after IS NOT NULL AND w.recheck_after <= ?)
          OR (w.recheck_after IS NULL
              AND COALESCE((SELECT MAX(r.created_at) FROM eval_runs r WHERE r.workload_id = w.id), 0) < ?))
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'eval_run' AND j.status IN ('queued', 'claimed')
                          AND (j.payload::jsonb ->> 'workloadId') = w.id)`)
    .all(workspaceId, now(), now() - days * DAY);
}

/* The workspace chose another rhythm in Settings: every workload tested before is booked again from its last test, as the
   end of that test would have booked it had the new rhythm been in place (scheduleNext: the rhythm, doubled for each
   re-check in a row that changed nothing). A booking already made was kept as it was, so "Every 5 days" left a workload
   tested three weeks ago waiting out the month it had been given. A shorter rhythm never books one later than it was: a
   retry after a failure, a wait for calls or a nudge that comes sooner keeps its time. A longer one never books one sooner
   than the new rhythm allows, since Settings promises tests at most that often, except a retry after a test that failed
   or ran out of balance, which keeps its time: it retries what the rhythm had already allowed. One never tested is left to
   its first calls, and one being tested, or waiting in the queue, to the end of that test, which books its own. "Only
   when I ask" changes no booking: nothing starts by itself then, and choosing a rhythm again books every one afresh.
   Answers how many moved. */
export async function rebookForRhythm(workspaceId, fromDays, toDays) {
  if (!(toDays > 0) || Number(fromDays) === Number(toDays)) return 0;
  const rows = await db.prepare(
    `SELECT w.id, w.recheck_after, w.recheck_streak, w.measure_at_calls,
            (SELECT MAX(COALESCE(r.finished_at, r.created_at)) FROM eval_runs r
              WHERE r.workload_id = w.id AND r.status <> 'running') AS last,
            (SELECT CASE WHEN r.status = 'failed' OR ${OUTCOME_OF('r.')} = 'no_balance' THEN 1 ELSE 0 END FROM eval_runs r
              WHERE r.workload_id = w.id AND r.status <> 'running' ORDER BY r.created_at DESC LIMIT 1) AS failed
       FROM workloads w
      WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL
        AND NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.workload_id = w.id AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'eval_run' AND j.status IN ('queued', 'claimed')
                          AND (j.payload::jsonb ->> 'workloadId') = w.id)`).all(workspaceId);
  let moved = 0;
  for (const w of rows) {
    if (w.last === null || w.last === undefined) continue;
    const streak = Math.min(config.EVAL_BACKOFF_MAX_DOUBLINGS, Number(w.recheck_streak || 0));
    /* One waiting for calls (a second look's, or a closer test's) has its booking only as the fallback, a whole rhythm
       out: made due at once by a shorter rhythm, a whole test ran first and drew the very calls the look waited for. */
    const waiting = w.measure_at_calls !== null && w.measure_at_calls !== undefined;
    const due = Math.round(Math.max(Number(w.last) + toDays * DAY * 2 ** streak, waiting ? now() + toDays * DAY : -Infinity));
    const had = w.recheck_after === null || w.recheck_after === undefined ? null : Number(w.recheck_after);
    let at = had;
    if (had === null || !(Number(fromDays) > 0)) at = due;
    else if (toDays < fromDays) at = Math.min(had, due);
    else if (!Number(w.failed)) at = Math.max(had, due);
    if (at === had) continue;
    moved += (await db.prepare('UPDATE workloads SET recheck_after = ? WHERE id = ?').run(at, w.id)).changes;
  }
  return moved;
}

/* Something changed that could matter: the next measurement of these workloads comes forward to
   within EVAL_NUDGE_HOURS, but never to sooner than the workspace's rhythm after the last
   measurement of it (nor EVAL_NUDGE_MIN_DAYS), and only in a workspace that measures by itself.
   A nudge brings one check forward; it does not erase the backoff, so the streak of re-checks that
   found nothing new is kept. It used to be set back to nothing, and with a new cheap model in the
   catalogue most weeks, workloads were measured every week whatever their workspace had chosen.
   Answers how many moved. */
export async function nudge(workloadIds) {
  let moved = 0;
  for (const id of new Set(workloadIds)) {
    const w = await db.prepare(
      `SELECT w.workspace_id, (SELECT MAX(r.created_at) FROM eval_runs r WHERE r.workload_id = w.id) AS last
         FROM workloads w WHERE w.id = ?`).get(id);
    if (!w) continue;
    const cadence = await cadenceOf(w.workspace_id);
    if (!cadence) continue;
    const last = w.last === null || w.last === undefined ? null : Number(w.last);
    const earliest = last === null ? 0 : last + Math.max(config.EVAL_NUDGE_MIN_DAYS, cadence) * DAY;
    const at = Math.round(Math.max(now() + config.EVAL_NUDGE_HOURS * HOUR, earliest));
    /* Only ever earlier. A workload never measured and with nothing booked is booked now; one measured
       before and with nothing booked is already due by its rhythm, which is no later than this. */
    moved += (await db.prepare(
      `UPDATE workloads SET recheck_after = ?
        WHERE id = ? AND (recheck_after > ? OR (recheck_after IS NULL AND ?::boolean))`)
      .run(at, id, at, last === null)).changes;
  }
  return moved;
}

const blend = (m) => Number(m.price_in || 0) + Number(m.price_out || 0);

/* What moved in the catalogue between two readings, and which workloads it could matter to:
     a model that serves a workload got dearer, so its saving may be gone;
     the customer's own model got cheaper under a switch, so the switch may no longer save;
     a model new to the catalogue, or much cheaper than it was, costs a good deal less than what a
     workload runs on now, and a measurement of that workload would actually try it: switched on in
     its workspace, able to do what its calls ask (their length, tools, structured answers, keeping
     nothing when the workspace requires that), cheaper at the price that would really be paid, and
     not switched back before. The cheapest model anywhere in the catalogue used to nudge every
     workload dearer than it, whether or not its workspace could ever use it.
   A workspace that measures only when asked is never nudged: zero days means never. `pick` answers
   which of some models a measurement of a workload would try (see wouldTry). */
export async function nudgeForCatalog(before, after, { pick = wouldTry } = {}) {
  const was = new Map(before.map((m) => [m.model_id, m]));
  const added = [];
  const cheaper = [];
  const dearer = new Set();
  const droppedPrice = new Set();
  for (const m of after) {
    const old = was.get(m.model_id);
    if (!old) { added.push(m); continue; }
    const a = blend(old);
    const b = blend(m);
    if (a > 0 && b < a * 0.9) { cheaper.push(m); droppedPrice.add(m.model_id); }
    if (a > 0 && b > a * 1.1) dearer.add(m.model_id);
  }
  const tryable = [...added, ...cheaper].filter((m) => blend(m) > 0);
  if (!tryable.length && !dearer.size && !droppedPrice.size) return { added: added.length, cheaper: cheaper.length, dearer: dearer.size, nudged: 0 };
  const priceOf = new Map(after.map((m) => [m.model_id, blend(m)]));
  const live = await db.prepare(
    `SELECT w.*, s.measure_every_days AS cadence FROM workloads w JOIN workspaces s ON s.id = w.workspace_id
      WHERE w.state = 'live' AND w.merged_into IS NULL`).all();
  const ids = [];
  for (const w of live) {
    const days = w.cadence === null || w.cadence === undefined ? config.MEASURE_EVERY_DAYS : Number(w.cadence);
    if (!(days > 0)) continue;
    if (w.routed_model && dearer.has(w.routed_model)) { ids.push(w.id); continue; }
    if (w.routed_model && droppedPrice.has(w.reference_model)) { ids.push(w.id); continue; }
    const serving = priceOf.get(w.routed_model || w.reference_model);
    if (!serving) continue;
    const worth = tryable.filter((m) => blend(m) * 1.25 < serving).map((m) => m.model_id);
    if (!worth.length) continue;
    if ((await pick(w, worth)).length) ids.push(w.id);
  }
  const nudged = ids.length ? await nudge(ids) : 0;
  return { added: added.length, cheaper: cheaper.length, dearer: dearer.size, nudged };
}
