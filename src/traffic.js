import { db, id, now, round8 } from './db/index.js';
import { signatureOf, nameFor } from './classify.js';
import config from './config.js';

export function addActivity(workspaceId, { kind, title, detail = null, workloadId = null, at = now() }) {
  db.prepare(`INSERT INTO activity (id, workspace_id, workload_id, kind, title, detail, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id('act'), workspaceId, workloadId, kind, title, detail, at);
}

/** Find the workload this call belongs to, creating it the first time we see the shape. */
export function workloadFor(workspaceId, body) {
  const sig = signatureOf(body);
  const found = db.prepare('SELECT * FROM workloads WHERE workspace_id = ? AND fingerprint = ?')
    .get(workspaceId, sig.fingerprint);
  if (found) return found;

  let slug = nameFor(sig);
  const taken = db.prepare('SELECT 1 FROM workloads WHERE workspace_id = ? AND slug = ?');
  let n = 2;
  while (taken.get(workspaceId, slug)) slug = `${nameFor(sig)}-${n++}`;

  const row = {
    id: id('wl'), workspace_id: workspaceId, slug, fingerprint: sig.fingerprint,
    shape_kind: sig.shapeKind, reference_model: body?.model || null, routed_model: null,
    optimize_mode: 'auto', status: 'new', status_note: null, floor_pct: null,
    promoted_at: null, promoted_run_id: null,
    sample_prompt: sig.systemSample, tool_names: JSON.stringify(sig.toolNames),
    created_at: now(), updated_at: now(),
  };
  db.prepare(`INSERT INTO workloads
      (id, workspace_id, slug, fingerprint, shape_kind, reference_model, routed_model, optimize_mode,
       status, status_note, floor_pct, promoted_at, promoted_run_id, sample_prompt, tool_names,
       created_at, updated_at)
      VALUES (@id, @workspace_id, @slug, @fingerprint, @shape_kind, @reference_model, @routed_model,
       @optimize_mode, @status, @status_note, @floor_pct, @promoted_at, @promoted_run_id,
       @sample_prompt, @tool_names, @created_at, @updated_at)`).run(row);

  addActivity(workspaceId, {
    kind: 'connect',
    title: `Found a new workload: ${slug}`,
    detail: `${sig.shapeKind.replace('_', ' ')} requests${body?.model ? `, currently on ${body.model}` : ''}`,
    workloadId: row.id,
  });
  return row;
}

/** One call, recorded. Everything the screens and the measurement need comes from here. */
export function recordCall({
  workspaceId, workloadId = null, source, requestedModel = null, servedModel = null,
  statusCode = null, promptTokens = 0, completionTokens = 0, costUsd = 0, chargedUsd = 0,
  latencyMs = null, request = null, response = null,
}) {
  const row = {
    id: id('call'), workspace_id: workspaceId, workload_id: workloadId, source,
    requested_model: requestedModel, served_model: servedModel, status_code: statusCode,
    prompt_tokens: promptTokens | 0, completion_tokens: completionTokens | 0,
    cost_usd: round8(costUsd), charged_usd: round8(chargedUsd), latency_ms: latencyMs,
    request_json: request ? JSON.stringify(request) : null,
    response_json: response ? JSON.stringify(response) : null,
    created_at: now(),
  };
  db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model,
      status_code, prompt_tokens, completion_tokens, cost_usd, charged_usd, latency_ms,
      request_json, response_json, created_at)
      VALUES (@id, @workspace_id, @workload_id, @source, @requested_model, @served_model,
      @status_code, @prompt_tokens, @completion_tokens, @cost_usd, @charged_usd, @latency_ms,
      @request_json, @response_json, @created_at)`).run(row);
  if (workloadId) db.prepare('UPDATE workloads SET updated_at = ? WHERE id = ?').run(now(), workloadId);
  return row.id;
}

const DAY = 86400000;

/** Calls and spend per workload over a window, which is what every screen is built from. */
export function workloadStats(workspaceId, days = 30) {
  const since = now() - days * DAY;
  return db.prepare(
    `SELECT w.*,
            (SELECT COUNT(*) FROM calls c WHERE c.workload_id = w.id AND c.created_at >= ?
                AND c.source NOT IN ('replay', 'test')) AS calls,
            (SELECT COALESCE(SUM(c.charged_usd), 0) FROM calls c
              WHERE c.workload_id = w.id AND c.created_at >= ? AND c.source NOT IN ('replay', 'test')) AS spend
       FROM workloads w WHERE w.workspace_id = ?
      ORDER BY spend DESC, w.created_at`).all(since, since, workspaceId);
}

/** Daily spend, and what the same traffic would have cost on the customer's own models. */
export function dailySpend(workspaceId, days = 30) {
  const since = now() - days * DAY;
  const rows = db.prepare(
    `SELECT c.created_at, c.charged_usd, c.cost_usd, c.served_model, c.requested_model,
            c.prompt_tokens, c.completion_tokens
       FROM calls c WHERE c.workspace_id = ? AND c.created_at >= ? AND c.source NOT IN ('replay', 'test')`)
    .all(workspaceId, since);
  const price = new Map(db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all()
    .map((m) => [m.model_id, m]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const end = now() - i * DAY;
    out.push({ at: end, paid: 0, would: 0 });
  }
  const first = now() - (days - 1) * DAY;
  for (const c of rows) {
    const bucket = Math.min(days - 1, Math.max(0, Math.floor((c.created_at - first) / DAY) + 0));
    const slot = out[bucket];
    if (!slot) continue;
    slot.paid = round8(slot.paid + c.charged_usd);
    // what the customer's own model would have charged for the same tokens
    const own = price.get(c.requested_model);
    const wouldCost = own
      ? own.price_in * c.prompt_tokens + own.price_out * c.completion_tokens
      : c.charged_usd;
    slot.would = round8(slot.would + wouldCost * (1 + config.ROUTING_FEE_PCT / 100));
  }
  return out;
}

export function recentActivity(workspaceId, limit = 8) {
  return db.prepare(
    `SELECT kind, title, detail, created_at FROM activity
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit);
}
