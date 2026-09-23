import { db, id, now, round8 } from './db/index.js';
import { matchWorkload } from './workloads.js';
import { enqueue } from './jobs.js';
import { signatureOf, nameFor } from './classify.js';
import config from './config.js';
import { requestHash, beforeHash, afterHash, answerOf } from './learn/threads.js';
import { noteCall } from './learn/outcomes.js';

export async function addActivity(workspaceId, { kind, title, detail = null, workloadId = null, at = now() }) {
  await db.prepare(`INSERT INTO activity (id, workspace_id, workload_id, kind, title, detail, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id('act'), workspaceId, workloadId, kind, title, detail, at);
}

/** Find the workload this call belongs to, creating it the first time we see the shape. */
export async function workloadFor(workspaceId, body, { name = null } = {}) {
  const workload = await matchWorkload(workspaceId, body, { name });
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

/* Learning from a call happens after it is recorded and never holds up the answer. What is still
   being read is kept here, so a test (or a graceful stop) can wait for it to finish. */
const learning = new Set();
export async function learningSettled() {
  while (learning.size) await Promise.allSettled([...learning]);
}

/** Keep hold of some background learning, such as a background answer, until it settles. */
export function track(work, what = 'background learning') {
  const p = Promise.resolve(work)
    .catch((err) => { console.error(`${what} failed: ${err?.message || err}`); })
    .finally(() => { learning.delete(p); });
  learning.add(p);
  return p;
}

/** One call, recorded. Everything the screens and the measurement need comes from here. */
export async function recordCall({
  id: givenId = null, workspaceId, workloadId = null, source, requestedModel = null, servedModel = null,
  statusCode = null, promptTokens = 0, completionTokens = 0, costUsd = 0, chargedUsd = 0,
  latencyMs = null, ttftMs = null, request = null, response = null, ref = null,
  armId = null, propensity = null, explored = null, escalated = null, check = null,
}) {
  /* A call the customer made, routed or copied, carries its fingerprints: the request itself (the
     same request sent again is a retry), and the conversation before and after it (a follow-up
     call continues it, and becomes the next step of the same task). */
  const customer = source === 'routed' || source === 'trace';
  const answer = customer && statusCode === 200 ? answerOf(response) : null;
  const row = {
    id: givenId || id('call'), workspace_id: workspaceId, workload_id: workloadId, source,
    requested_model: requestedModel, served_model: servedModel, status_code: statusCode,
    prompt_tokens: promptTokens | 0, completion_tokens: completionTokens | 0,
    cost_usd: round8(costUsd), charged_usd: round8(chargedUsd), latency_ms: latencyMs, ttft_ms: ttftMs,
    request_json: request ? JSON.stringify(request) : null,
    response_json: response ? JSON.stringify(response) : null,
    created_at: now(),
    ref,
    request_hash: customer && request ? requestHash(request) : null,
    before_hash: customer && request ? beforeHash(request.messages) : null,
    after_hash: answer && request ? afterHash(request.messages, answer) : null,
    arm_id: armId, propensity, explored: explored === null ? null : (explored ? 1 : 0),
    escalated: escalated === null ? null : (escalated ? 1 : 0),
    check_json: check ? JSON.stringify(check) : null,
  };
  row.task_id = customer ? row.id : null;
  row.step = customer ? 1 : null;
  await db.prepare(`INSERT INTO calls (id, workspace_id, workload_id, source, requested_model, served_model,
      status_code, prompt_tokens, completion_tokens, cost_usd, charged_usd, latency_ms, ttft_ms,
      request_json, response_json, created_at, ref, request_hash, before_hash, after_hash, task_id, step,
      arm_id, propensity, explored, escalated, check_json)
      VALUES (@id, @workspace_id, @workload_id, @source, @requested_model, @served_model,
      @status_code, @prompt_tokens, @completion_tokens, @cost_usd, @charged_usd, @latency_ms, @ttft_ms,
      @request_json, @response_json, @created_at, @ref, @request_hash, @before_hash, @after_hash, @task_id, @step,
      @arm_id, @propensity, @explored, @escalated, @check_json)`).run(row);
  if (workloadId) await db.prepare('UPDATE workloads SET updated_at = ? WHERE id = ?').run(now(), workloadId);
  if (customer && workloadId) {
    const p = noteCall(row, { request, response })
      .catch((err) => { console.error(`learning from ${row.id} failed: ${err.message}`); })
      .finally(() => { learning.delete(p); });
    learning.add(p);
  }
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
              WHERE c.workload_id = w.id AND c.created_at >= ? AND c.source NOT IN ('replay', 'test')) AS spend,
            -- how its latest calls reach us: through us, or as copies (see carriesOf)
            (SELECT COUNT(*) FILTER (WHERE x.source = 'routed') FROM (SELECT source FROM calls c
               WHERE c.workload_id = w.id AND c.source IN ('routed', 'trace') ORDER BY c.created_at DESC LIMIT 100) x) AS recent_routed,
            (SELECT COUNT(*) FILTER (WHERE x.source = 'trace') FROM (SELECT source FROM calls c
               WHERE c.workload_id = w.id AND c.source IN ('routed', 'trace') ORDER BY c.created_at DESC LIMIT 100) x) AS recent_copies,
            (SELECT ws.mode FROM workspaces ws WHERE ws.id = w.workspace_id) AS ws_mode,
            (SELECT a.spec_json FROM arms a WHERE a.id = w.routed_arm_id) AS arm_spec
       FROM workloads w WHERE w.workspace_id = ? AND w.state = 'live' AND w.merged_into IS NULL
      ORDER BY spend DESC, w.created_at`).all(since, since, workspaceId);
}

/** Daily spend, and what the same traffic would have cost on the customer's own models. */
export async function dailySpend(workspaceId, days = 30) {
  const since = now() - days * DAY;
  const rows = await db.prepare(
    /* Only calls that came through us. A copy was paid to the customer's own provider and could
       not have been sent anywhere cheaper, so it is neither spend here nor a saving: counted, it
       read as paid nothing against what it would have cost, and every copy showed as saved in
       full ($6.60 on one workspace that had saved nothing). */
    `SELECT c.created_at, c.charged_usd, c.cost_usd, c.served_model, c.requested_model,
            c.prompt_tokens, c.completion_tokens
       FROM calls c WHERE c.workspace_id = ? AND c.created_at >= ? AND c.source = 'routed'`)
    .all(workspaceId, since);
  const price = new Map(await (await db.prepare('SELECT model_id, price_in, price_out FROM models_catalog').all())
    .map((m) => [m.model_id, m]));
  /* One clock for the whole calculation. now() was being read again for every bucket and
     once more for the anchor, so the anchor was always a fraction of a second later than the
     buckets it was supposed to line up with. */
  const t0 = now();
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push({ at: t0 - i * DAY, paid: 0, would: 0 });
  const first = t0 - (days - 1) * DAY;
  for (const c of rows) {
    /* Each bucket is labelled by the moment it ENDS, so a call belongs to the first bucket
       that ends at or after it: ceil, not floor. With floor, a call made seconds ago fell
       just short of the last bucket and was drawn on yesterday, which left today reading
       zero on every dashboard and every number one day out of place. */
    const bucket = Math.min(days - 1, Math.max(0, Math.ceil((c.created_at - first) / DAY)));
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
            c.latency_ms, c.cost_usd, c.charged_usd, c.created_at, c.escalated, c.explored, c.check_json,
            w.slug AS workload
       FROM calls c
       LEFT JOIN workloads w ON w.id = c.workload_id
      WHERE c.workspace_id = ?
      ORDER BY c.created_at DESC LIMIT ?`).all(workspaceId, limit);
}

export async function recentActivity(workspaceId, limit = 8) {
  /* The workload's name comes along, because an announcement froze whatever the workload
     was called at the moment it was written. A workload is named twice: on sight, from the
     words of its own instruction, and again once a model has read it properly. So the feed
     said "Found a new workload: poet-who-writes" above a list where that same workload was
     called something else entirely. */
  return await db.prepare(
    `SELECT a.kind, a.title, a.detail, a.created_at, w.slug AS workload
       FROM activity a LEFT JOIN workloads w ON w.id = a.workload_id
      WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT ?`).all(workspaceId, limit);
}
