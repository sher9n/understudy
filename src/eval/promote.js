import { db, id, now } from '../db/index.js';
import { addActivity } from '../traffic.js';
import { OUTCOME_OF, RECENT_CALLS, carriesOf } from './outcome.js';

const record = async (workload, row, x = db) =>
  await x.prepare(`INSERT INTO promotions (id, workload_id, action, from_model, to_model, reason, run_id,
              actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('prm'), workload.id, row.action, row.from_model ?? null, row.to_model ?? null,
         row.reason ?? null, row.run_id ?? null, row.actor_user_id ?? null, now());

/* How long a model switched back for something that can change waits before it can be tried
   again: a provider that was overloaded or slow this week, a price that went up, a provider that
   stopped keeping nothing. A model whose answers stopped matching, or that somebody switched back
   by hand, has said something lasting about itself, and stays out. */
export const WATCH_COOL_OFF_DAYS = 7;

/** A model that was switched back is not promoted automatically again: never, or for a while. */
export async function everReverted(workloadId, modelId) {
  return !!await db.prepare(
    `SELECT 1 FROM promotions WHERE workload_id = ? AND from_model = ?
      AND (action IN ('revert', 'auto_revert') OR (action = 'soft_revert' AND created_at >= ?))`)
    .get(workloadId, modelId, now() - WATCH_COOL_OFF_DAYS * 86400000);
}

/** How a workload's latest calls reach us, and whether switching it would change anything. */
export async function trafficOf(workload) {
  const ws = await db.prepare('SELECT mode FROM workspaces WHERE id = ?').get(workload.workspace_id);
  const r = await db.prepare(
    `SELECT COUNT(*) FILTER (WHERE source = 'routed') AS routed, COUNT(*) FILTER (WHERE source = 'trace') AS copies
       FROM (SELECT source FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace')
              ORDER BY created_at DESC LIMIT ?) x`).get(workload.id, RECENT_CALLS);
  const routed = Number(r?.routed ?? 0);
  const copies = Number(r?.copies ?? 0);
  return { routed, copies, observe: ws?.mode === 'observe', carries: carriesOf({ mode: ws?.mode, routed, copies }) };
}

export async function promote(workload, modelId, { runId = null, reason = 'cleared your bar', actorUserId = null, auto = false, recipe = undefined } = {}) {
  if (auto && await everReverted(workload.id, modelId)) {
    return { ok: false, code: 'previously_reverted' };
  }
  const from = workload.routed_model || workload.reference_model;
  if (from === modelId) return { ok: true, already: true };
  /* How the model was measured is how it is routed: one that cleared with its thinking switched
     off is sent every live call with its thinking switched off. When the caller does not say,
     it is read from the measurement the switch rests on. */
  let how = recipe;
  if (how === undefined) {
    /* The run named, when it measured this model; otherwise the newest run that did. A model
       approved from an older measurement than the latest was measured in that older one, and
       routing it without its recipe would route a different model from the one that cleared:
       one measured with its thinking off, sent live with it on, can spend a short answer cap
       thinking and answer nothing. */
    const row = (runId ? await db.prepare('SELECT recipe_json FROM eval_results WHERE run_id = ? AND model_id = ?')
      .get(runId, modelId) : null) || await db.prepare(
      `SELECT r.recipe_json FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
        WHERE e.workload_id = ? AND r.model_id = ? ORDER BY e.created_at DESC LIMIT 1`).get(workload.id, modelId);
    try { how = row?.recipe_json ? JSON.parse(row.recipe_json) : null; } catch { how = null; }
  }
  await db.tx(async (tx) => {
    await tx.prepare(`UPDATE workloads SET routed_model = ?, routed_recipe = ?, promoted_at = ?, promoted_run_id = ?,
                status = 'promoted', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(modelId, how ? JSON.stringify(how) : null, now(), runId, now(), workload.id);
    await record(workload, { action: 'promote', from_model: from, to_model: modelId, reason, run_id: runId, actor_user_id: actorUserId }, tx);
  });
  // said as it is for a workload whose calls arrive as copies: set up, and waiting for them
  const traffic = await trafficOf(workload);
  await addActivity(workload.workspace_id, {
    kind: 'ok',
    title: traffic.carries ? `${workload.slug} now runs on ${modelId}`
      : `${workload.slug} will run on ${modelId} once its calls come through Understudy`,
    detail: (auto
      ? 'Switched on its own, because this workload optimizes automatically.'
      : 'Switched because you approved it.')
      + (traffic.carries ? '' : ' Its calls reach us as copies, so the switch starts with the first one that comes through Understudy.'),
    workloadId: workload.id,
  });
  return { ok: true, from, to: modelId, waiting: !traffic.carries };
}

/** Back to the customer's own model, from the next call onwards. */
export async function revert(workload, { reason = 'you asked for it', actorUserId = null, auto = false, soft = false } = {}) {
  if (!workload.routed_model) return { ok: true, already: true };
  const from = workload.routed_model;
  /* Only the model this was decided about. The row can be read a while before it is written, and
     a switch made in between, by a person or by a measurement finishing, must not be undone on
     the strength of evidence about the model before it. */
  let moved = false;
  await db.tx(async (tx) => {
    const r = await tx.prepare(`UPDATE workloads SET routed_model = NULL, routed_recipe = NULL, promoted_at = NULL,
                promoted_run_id = NULL, status = 'certified', updated_at = ? WHERE id = ? AND routed_model = ?`)
      .run(now(), workload.id, from);
    if (!r.changes) { moved = true; return; }
    await record(workload, {
      action: soft ? 'soft_revert' : auto ? 'auto_revert' : 'revert', from_model: from,
      to_model: workload.reference_model, reason, actor_user_id: actorUserId,
    }, tx);
  });
  if (moved) return { ok: false, code: 'moved' };
  await addActivity(workload.workspace_id, {
    kind: 'revert',
    title: `${workload.slug} is back on ${workload.reference_model}`,
    detail: reason,
    workloadId: workload.id,
  });
  return { ok: true, from, to: workload.reference_model };
}

/** The certificate a switch was made on: the run, its bar, and every model tried. */
export async function certificate(workloadId, runId = null) {
  /* The newest finished measurement that found something: it compared models, or it found the
     bar could not be set. One that ran out of balance before trying anything says nothing about
     any model, so it does not replace what the last real measurement found; it is still in the
     history for anybody who opens it. A row with no outcome is read from its error, the way
     the backfill reads it. */
  const run = runId
    ? await db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId)
    : await db.prepare(`SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'done'
                   AND ${OUTCOME_OF()} IN ('compared', 'unmeasurable', 'refused')
                   ORDER BY created_at DESC LIMIT 1`).get(workloadId);
  if (!run) return null;
  const results = await db.prepare(
    `SELECT * FROM eval_results WHERE run_id = ? ORDER BY cost_month_usd IS NULL, cost_month_usd`)
    .all(run.id);
  const runsTotal = await db.prepare(
    `SELECT model_id, SUM(runs) AS runs FROM eval_results
      WHERE run_id IN (SELECT id FROM eval_runs WHERE workload_id = ?) GROUP BY model_id`)
    .all(workloadId);
  const totals = new Map(runsTotal.map((r) => [r.model_id, r.runs]));
  const refCost = (await db.prepare(
    `SELECT cost_month_usd FROM eval_results WHERE run_id = ? AND model_id = ?`)
    .get(run.id, run.reference_model))?.cost_month_usd ?? null;
  return {
    run,
    referenceCostMonth: refCost,
    rounds: (await db.prepare(`SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ? AND status = 'done'`)
      .get(workloadId)).n,
    results: results.map((r) => ({ ...r, runs_total: totals.get(r.model_id) ?? r.runs })),
  };
}

/* Watching a switch after it is made.
 *
 * A measurement is a sample; live traffic is the real thing. After a switch, the switched-to
 * model's live calls are compared with the customer's own model's calls from the fortnight
 * before it. A model whose provider starts failing calls, or that answers slower than the
 * workload's speed setting allows, is switched back, and the activity feed says why in numbers.
 * Quality is re-checked by measuring again on the workspace's schedule; this is the part a
 * measurement cannot see, which is how the model behaves under the customer's own load.
 *
 * Both checks need real evidence, because a switch back costs the customer the saving. Failures
 * are read over the last day, since that is what the watch is for, and only count when there are
 * enough of them that chance would explain them less than one time in a hundred at the rate
 * the customer's own model failed at before (never taken as lower than one in a hundred). A
 * switch back by the watch keeps the model out for a week rather than for good: an overloaded
 * provider recovers, and the next measurement can find the model again once it has. */
const DAY = 86400000;
const providerFailed = (s) => s === 0 || s === 404 || s === 408 || s === 429 || s >= 500;
const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null;
};

/** The chance of k or more failures in n calls when each fails with chance p. */
export function tailAtLeast(k, n, p) {
  if (k <= 0 || p >= 1) return 1;
  if (k > n || p <= 0) return 0;
  let term = (1 - p) ** n; // P(X = 0)
  let below = 0;
  for (let i = 0; i < k; i += 1) {
    below += term;
    term = (term * (n - i) * p) / ((i + 1) * (1 - p));
  }
  return Math.max(0, 1 - below);
}

/** Whether k failed calls out of n, against a failure rate of `before`, is enough to act on. */
export function failingClearly(k, n, before) {
  const rate = n ? k / n : 0;
  const base = Math.max(before, 0.01);
  return k >= 5 && rate > 0.05 && rate > 2 * before && tailAtLeast(k, n, base) < 0.01;
}

export async function watchLive({ minCalls = 20, speedFactor = null } = {}) {
  const { default: config } = await import('../config.js');
  const { profileOf, speedRule } = await import('./profile.js');
  const rows = await db.prepare(
    'SELECT * FROM workloads WHERE routed_model IS NOT NULL AND promoted_at IS NOT NULL').all();
  let reverted = 0;
  for (const w of rows) {
    const since = Math.max(w.promoted_at, now() - DAY);
    const after = await db.prepare(
      `SELECT status_code, latency_ms, ttft_ms FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
          AND created_at >= ? ORDER BY created_at DESC LIMIT 500`).all(w.id, w.routed_model, since);
    if (after.length < minCalls) continue;
    const before = await db.prepare(
      `SELECT status_code, latency_ms, ttft_ms FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
          AND created_at < ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500`)
      .all(w.id, w.reference_model, w.promoted_at, w.promoted_at - 14 * DAY);
    const failed = (xs) => xs.filter((c) => providerFailed(c.status_code ?? 200)).length;
    const errAfter = after.length ? failed(after) / after.length : 0;
    const errBefore = before.length ? failed(before) / before.length : 0;
    if (failingClearly(failed(after), after.length, errBefore)) {
      const r = await revert(w, {
        auto: true,
        soft: true,
        reason: `${Math.round(errAfter * 100)}% of its live calls over the last day failed (${failed(after)} of `
          + `${after.length}), against ${Math.round(errBefore * 100)}% on ${w.reference_model} before the switch. `
          + `Switched back, and it can be tried again in ${WATCH_COOL_OFF_DAYS} days.`,
      });
      if (r.ok) reverted += 1;
      continue;
    }
    /* The workload's own speed rule, the one its measurements hold models to: streamed calls
       are timed to the first word, everything else to the whole answer. */
    const rule = speedRule(w, await profileOf(w), config);
    const factor = speedFactor ?? rule.factor;
    if (!factor) continue;
    const field = rule.metric === 'ttft' ? 'ttft_ms' : 'latency_ms';
    const ok = (xs) => xs.filter((c) => (c.status_code ?? 200) < 400 && c[field] > 0).map((c) => c[field]);
    const a = ok(after);
    const b = ok(before);
    if (a.length < minCalls || b.length < minCalls) continue;
    const a50 = pct(a, 0.5);
    const b50 = pct(b, 0.5);
    if (a50 && b50 && a50 > factor * b50 + config.SPEED_SLACK_MS) {
      const what = rule.metric === 'ttft' ? 'started answering in' : 'took';
      const r = await revert(w, {
        auto: true,
        soft: true,
        reason: `its typical live answer ${what} ${(a50 / 1000).toFixed(1)} s over the last day, against `
          + `${(b50 / 1000).toFixed(1)} s on ${w.reference_model} before the switch, more than your speed setting allows. `
          + `Switched back, and it can be tried again in ${WATCH_COOL_OFF_DAYS} days.`,
      });
      if (r.ok) reverted += 1;
    }
  }
  return reverted;
}
