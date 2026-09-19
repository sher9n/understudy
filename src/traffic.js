import { db, id, now, round8 } from './db/index.js';
import { matchWorkload } from './workloads.js';
import { enqueue } from './jobs.js';
import { signatureOf, nameFor } from './classify.js';
import config from './config.js';

export async function addActivity(workspaceId, { kind, title, detail = null, workloadId = null, at = now() }) {
  await db.prepare(`INSERT INTO activity (id, workspace_id, workload_id, kind, title, detail, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id('act'), workspaceId, workloadId, kind, title, detail, at);
}

/** Find the workload this call belongs to, creating it the first time we see the shape. */
export async function workloadFor(workspaceId, body) {
  const workload = await matchWorkload(workspaceId, body);
  /* A workload is only worth telling somebody about once it has been seen enough times to
     be a real part of their traffic. Announcing every one-off call would fill the feed with
     things that never happen again. */
  if (workload.becameLive) {
    await addActivity(workspaceId, {
      kind: 'connect',
      title: `Found a new workload: ${workload.slug}`,
      detail: `${String(workload.shape_kind).replace('_', ' ')} requests${workload.reference_model ? `, currently on ${workload.reference_model}` : ''}`,
      workloadId: workload.id,
    });
    await enqueue('name_workload', { workloadId: workload.id }, { unique: true });
  }
  return workload;
}

/** One call, recorded. Everything the screens and the measurement need comes from here. */
export async function recordCall({
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
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model,
      status_code, prompt_tokens, completion_tokens, cost_usd, charged_usd, latency_ms,
      request_json, response_json, created_at)
      VALUES (@id, @workspace_id, @workload_id, @source, @requested_model, @served_model,
      @status_code, @prompt_tokens, @completion_tokens, @cost_usd, @charged_usd, @latency_ms,
      @request_json, @response_json, @created_at)`).run(row);
  if (workloadId) await db.prepare('UPDATE workloads SET updated_at = ? WHERE id = ?').run(now(), workloadId);
  return row.id;
}

const DAY = 86400000;

/** Calls and spend per workload over a window, which is what every screen is built from. */
export async function workloadStats(workspaceId, days = 30) {
  const since = now() - days * DAY;
  return await db.prepare(
    `SELECT w.*,
            (SELECT COUNT(*) FROM calls c WHERE c.workload_id = w.id AND c.created_at >= ?
                AND c.source NOT IN ('replay', 'test')) AS calls,
            (SELECT COALESCE(SUM(c.charged_usd), 0) FROM calls c
              WHERE c.workload_id = w.id AND c.created_at >= ? AND c.source NOT IN ('replay', 'test')) AS spend
       FROM workloads w WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL
      ORDER BY spend DESC, w.created_at`).all(since, since, workspaceId);
}

/** Daily spend, and what the same traffic would have cost on the customer's own models. */
export async function dailySpend(workspaceId, days = 30) {
  const since = now() - days * DAY;
  const rows = await db.prepare(
    `SELECT c.created_at, c.charged_usd, c.cost_usd, c.served_model, c.requested_model,
            c.prompt_tokens, c.completion_tokens
       FROM calls c WHERE c.workspace_id = ? AND c.created_at >= ? AND c.source NOT IN ('replay', 'test')`)
    .all(workspaceId, since);
  const price = new Map(await (await db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all())
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

/* The calls themselves, for the live feed.
 *
 * A developer who has just pointed their app at us has exactly one question, and it is not
 * "what is my spend": it is "is it working". The feed answered that with key changes and
 * plan events, which is everything EXCEPT the thing they are watching for. So the feed reads
 * the calls, and a call that arrives shows up as a line with the model, the job it was
 * grouped into and how long it took. Nothing extra is written to produce this: the rows are
 * already there, because every call is recorded anyway. */
export async function recentCalls(workspaceId, limit = 40) {
  return await db.prepare(
    `SELECT c.id, c.source, c.requested_model, c.served_model, c.status_code,
            c.latency_ms, c.cost_usd, c.charged_usd, c.created_at,
            w.slug AS workload
       FROM calls c
       LEFT JOIN workloads w ON w.id = c.workload_id
      WHERE c.workspace_id = ?
      ORDER BY c.created_at DESC LIMIT ?`).all(workspaceId, limit);
}

export async function recentActivity(workspaceId, limit = 8) {
  return await db.prepare(
    `SELECT kind, title, detail, created_at FROM activity
      WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit);
}
