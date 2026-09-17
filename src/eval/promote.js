import { db, id, now } from '../db/index.js';
import { addActivity } from '../traffic.js';

const record = (workload, row) =>
  db.prepare(`INSERT INTO promotions (id, workload_id, action, from_model, to_model, reason, run_id,
              actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('prm'), workload.id, row.action, row.from_model ?? null, row.to_model ?? null,
         row.reason ?? null, row.run_id ?? null, row.actor_user_id ?? null, now());

/** A model that was reverted is never promoted automatically again. */
export function everReverted(workloadId, modelId) {
  return !!db.prepare(
    `SELECT 1 FROM promotions WHERE workload_id = ? AND from_model = ?
      AND action IN ('revert', 'auto_revert')`).get(workloadId, modelId);
}

export function promote(workload, modelId, { runId = null, reason = 'cleared your bar', actorUserId = null, auto = false } = {}) {
  if (auto && everReverted(workload.id, modelId)) {
    return { ok: false, code: 'previously_reverted' };
  }
  const from = workload.routed_model || workload.reference_model;
  if (from === modelId) return { ok: true, already: true };
  db.transaction(() => {
    db.prepare(`UPDATE workloads SET routed_model = ?, promoted_at = ?, promoted_run_id = ?,
                status = 'promoted', status_note = NULL, updated_at = ? WHERE id = ?`)
      .run(modelId, now(), runId, now(), workload.id);
    record(workload, { action: 'promote', from_model: from, to_model: modelId, reason, run_id: runId, actor_user_id: actorUserId });
  })();
  addActivity(workload.workspace_id, {
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
export function revert(workload, { reason = 'you asked for it', actorUserId = null, auto = false } = {}) {
  if (!workload.routed_model) return { ok: true, already: true };
  const from = workload.routed_model;
  db.transaction(() => {
    db.prepare(`UPDATE workloads SET routed_model = NULL, promoted_at = NULL, promoted_run_id = NULL,
                status = 'certified', updated_at = ? WHERE id = ?`).run(now(), workload.id);
    record(workload, {
      action: auto ? 'auto_revert' : 'revert', from_model: from,
      to_model: workload.reference_model, reason, actor_user_id: actorUserId,
    });
  })();
  addActivity(workload.workspace_id, {
    kind: 'revert',
    title: `${workload.slug} is back on ${workload.reference_model}`,
    detail: reason,
    workloadId: workload.id,
  });
  return { ok: true, from, to: workload.reference_model };
}

/** The certificate a switch was made on: the run, its bar, and every model tried. */
export function certificate(workloadId, runId = null) {
  const run = runId
    ? db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(runId)
    : db.prepare(`SELECT * FROM eval_runs WHERE workload_id = ? AND status = 'done'
                   ORDER BY created_at DESC LIMIT 1`).get(workloadId);
  if (!run) return null;
  const results = db.prepare(
    `SELECT * FROM eval_results WHERE run_id = ? ORDER BY cost_month_usd IS NULL, cost_month_usd`)
    .all(run.id);
  const runsTotal = db.prepare(
    `SELECT model_id, SUM(runs) AS runs FROM eval_results
      WHERE run_id IN (SELECT id FROM eval_runs WHERE workload_id = ?) GROUP BY model_id`)
    .all(workloadId);
  const totals = new Map(runsTotal.map((r) => [r.model_id, r.runs]));
  return {
    run,
    rounds: db.prepare(`SELECT COUNT(*) AS n FROM eval_runs WHERE workload_id = ? AND status = 'done'`)
      .get(workloadId).n,
    results: results.map((r) => ({ ...r, runs_total: totals.get(r.model_id) ?? r.runs })),
  };
}
