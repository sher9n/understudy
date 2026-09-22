import { db, id, now } from '../db/index.js';
import { addActivity } from '../traffic.js';
import { OUTCOME_OF } from './outcome.js';

const record = async (workload, row, x = db) =>
  await x.prepare(`INSERT INTO promotions (id, workload_id, action, from_model, to_model, reason, run_id,
              actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('prm'), workload.id, row.action, row.from_model ?? null, row.to_model ?? null,
         row.reason ?? null, row.run_id ?? null, row.actor_user_id ?? null, now());

/** A model that was reverted is never promoted automatically again. */
export async function everReverted(workloadId, modelId) {
  return !!await db.prepare(
    `SELECT 1 FROM promotions WHERE workload_id = ? AND from_model = ?
      AND action IN ('revert', 'auto_revert')`).get(workloadId, modelId);
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
    const row = runId ? await db.prepare('SELECT recipe_json FROM eval_results WHERE run_id = ? AND model_id = ?')
      .get(runId, modelId) : await db.prepare(
      `SELECT r.recipe_json FROM eval_results r JOIN eval_runs e ON e.id = r.run_id
        WHERE e.workload_id = ? AND r.model_id = ? ORDER BY e.created_at DESC LIMIT 1`).get(workload.id, modelId);
    how = row?.recipe_json ? JSON.parse(row.recipe_json) : null;
  }
  await db.tx(async (tx) => {
    await tx.prepare(`UPDATE workloads SET routed_model = ?, routed_recipe = ?, promoted_at = ?, promoted_run_id = ?,
                status = 'promoted', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(modelId, how ? JSON.stringify(how) : null, now(), runId, now(), workload.id);
    await record(workload, { action: 'promote', from_model: from, to_model: modelId, reason, run_id: runId, actor_user_id: actorUserId }, tx);
  });
  await addActivity(workload.workspace_id, {
    kind: 'ok',
    title: `${workload.slug} now runs on ${modelId}`,
    detail: auto
      ? 'Switched on its own, because this workload optimizes automatically.'
      : 'Switched because you approved it.',
    workloadId: workload.id,
  });
  return { ok: true, from, to: modelId };
}

/** Back to the customer's own model, from the next call onwards. */
export async function revert(workload, { reason = 'you asked for it', actorUserId = null, auto = false } = {}) {
  if (!workload.routed_model) return { ok: true, already: true };
  const from = workload.routed_model;
  await db.tx(async (tx) => {
    await tx.prepare(`UPDATE workloads SET routed_model = NULL, routed_recipe = NULL, promoted_at = NULL,
                promoted_run_id = NULL, status = 'certified', updated_at = ? WHERE id = ?`).run(now(), workload.id);
    await record(workload, {
      action: auto ? 'auto_revert' : 'revert', from_model: from,
      to_model: workload.reference_model, reason, actor_user_id: actorUserId,
    }, tx);
  });
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
 * before it. A model whose provider starts refusing calls, or that answers slower than the
 * workload's speed setting allows, is switched back, and the activity feed says why in numbers.
 * Quality is re-checked by measuring again on the workspace's schedule; this is the part a
 * measurement cannot see, which is how the model behaves under the customer's own load. */
const DAY = 86400000;
const providerFailed = (s) => s === 0 || s === 404 || s === 408 || s === 429 || s >= 500;
const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null;
};

export async function watchLive({ minCalls = 20, speedFactor = null } = {}) {
  const { default: config } = await import('../config.js');
  const rows = await db.prepare(
    'SELECT * FROM workloads WHERE routed_model IS NOT NULL AND promoted_at IS NOT NULL').all();
  let reverted = 0;
  for (const w of rows) {
    const after = await db.prepare(
      `SELECT status_code, latency_ms FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
          AND created_at >= ? ORDER BY created_at DESC LIMIT 300`).all(w.id, w.routed_model, w.promoted_at);
    if (after.length < minCalls) continue;
    const before = await db.prepare(
      `SELECT status_code, latency_ms FROM calls WHERE workload_id = ? AND source = 'routed' AND served_model = ?
          AND created_at < ? AND created_at >= ? ORDER BY created_at DESC LIMIT 300`)
      .all(w.id, w.reference_model, w.promoted_at, w.promoted_at - 14 * DAY);
    const rate = (xs) => (xs.length ? xs.filter((c) => providerFailed(c.status_code ?? 200)).length / xs.length : 0);
    const errAfter = rate(after);
    const errBefore = rate(before);
    if (errAfter > 0.05 && errAfter > 2 * errBefore) {
      await revert(w, {
        auto: true,
        reason: `${Math.round(errAfter * 100)}% of its live calls failed since the switch, against `
          + `${Math.round(errBefore * 100)}% on ${w.reference_model} before it. Switched back.`,
      });
      reverted += 1;
      continue;
    }
    const pref = w.speed_pref;
    if (pref === 'any' || before.length < minCalls) continue;
    const factor = speedFactor ?? (pref === 'same' ? config.SPEED_SAME : config.SPEED_SLOWER_OK);
    const ok = (xs) => xs.filter((c) => (c.status_code ?? 200) < 400 && c.latency_ms > 0).map((c) => c.latency_ms);
    const a50 = pct(ok(after), 0.5);
    const b50 = pct(ok(before), 0.5);
    if (a50 && b50 && a50 > factor * b50 + config.SPEED_SLACK_MS) {
      await revert(w, {
        auto: true,
        reason: `its typical live answer took ${(a50 / 1000).toFixed(1)} s since the switch, against `
          + `${(b50 / 1000).toFixed(1)} s on ${w.reference_model} before it, more than your speed setting allows. Switched back.`,
      });
      reverted += 1;
    }
  }
  return reverted;
}
