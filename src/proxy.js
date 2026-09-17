import express from 'express';
import { db, now } from './db/index.js';
import config, { canRoute } from './config.js';
import { verifyKey, bearerOf } from './keys.js';
import { workloadFor, recordCall, addActivity } from './traffic.js';
import { chat, chatStream, priceCall, UpstreamError } from './openrouter.js';
import { gateRouting, chargeCall, grantStarterCredit } from './billing.js';
import { enqueue } from './jobs.js';

export const v1 = express.Router();

/** Every /v1 route is authenticated by the customer's own key, never by a session. */
function auth(req, res, next) {
  const key = verifyKey(bearerOf(req));
  if (!key) {
    return res.status(401).json({
      error: { message: 'Send your Understudy key as "Authorization: Bearer us_live_...".', type: 'invalid_api_key' },
    });
  }
  req.key = key;
  next();
}

v1.use(express.json({ limit: '8mb' }));
v1.use(auth);

/** What this workspace can ask for. The customer's own model ids keep working. */
v1.get('/models', (req, res) => {
  const rows = db.prepare(
    `SELECT c.model_id, c.name, c.context_len, c.price_in, c.price_out, c.open_weights
       FROM models_catalog c
       LEFT JOIN workspace_models wm ON wm.model_id = c.model_id AND wm.workspace_id = ?
      WHERE COALESCE(wm.enabled, 1) = 1
      ORDER BY c.model_id`).all(req.key.workspace_id);
  res.json({
    object: 'list',
    data: rows.map((m) => ({
      id: m.model_id, object: 'model', owned_by: m.model_id.split('/')[0],
      context_length: m.context_len,
      pricing: { prompt: String(m.price_in), completion: String(m.price_out) },
      open_weights: !!m.open_weights,
    })),
  });
});

/* The routed path. The customer's client is unchanged except for the base URL, and
   the model they name is the model we measure against, not necessarily the one we send. */
v1.post('/chat/completions', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: { message: '"messages" is required.', type: 'invalid_request_error' } });
  }
  if (!canRoute()) {
    return res.status(503).json({
      error: { message: 'Routing is not configured on this deployment yet.', type: 'not_configured' },
    });
  }
  grantStarterCredit(wsId);
  const gate = gateRouting(wsId);
  if (!gate.ok) return res.status(402).json({ error: { message: gate.message, type: gate.code } });

  const workload = workloadFor(wsId, body);
  const requested = body.model || workload.reference_model || null;
  const served = workload.routed_model || requested;
  if (!served) {
    return res.status(400).json({ error: { message: '"model" is required.', type: 'invalid_request_error' } });
  }

  const started = Date.now();
  try {
    if (body.stream) {
      const upstream = await chatStream(body, served);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      let usage = null;
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        buf += text;
        // the last chunk carries usage, which is what the customer is charged on
        for (const line of buf.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try { const j = JSON.parse(payload); if (j.usage) usage = j.usage; } catch { /* partial */ }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
        res.write(text);
      }
      res.end();
      finish({ wsId, workload, requested, served, usage, started, body, response: null, status: 200 });
      return undefined;
    }

    const { json, latencyMs } = await chat(body, served);
    res.status(200).json(json);
    finish({ wsId, workload, requested, served, usage: json?.usage, started, body, response: json, status: 200, latencyMs });
    return undefined;
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    const payload = err instanceof UpstreamError ? err.body : { error: { message: 'The provider could not be reached.' } };
    recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: served, statusCode: status, latencyMs: Date.now() - started, request: body,
    });
    if (!res.headersSent) res.status(status).json(payload);
    else res.end();
    return undefined;
  }
});

function finish({ wsId, workload, requested, served, usage, started, body, response, status, latencyMs }) {
  const cost = Number(usage?.cost ?? 0);
  const charged = cost > 0 ? chargeCall(wsId, cost, `${workload.slug} on ${served}`) : 0;
  recordCall({
    workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
    servedModel: served, statusCode: status,
    promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
    costUsd: cost, chargedUsd: charged, latencyMs: latencyMs ?? Date.now() - started,
    request: body, response,
  });
  considerMeasuring(wsId, workload);
}

/** Once a workload has enough calls to be trusted, it measures itself without being asked. */
export function considerMeasuring(wsId, workload) {
  if (workload.status !== 'new') return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?').get(workload.id).n;
  if (n < config.EVAL_FIRST_RUN_MIN_CALLS) return;
  db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), workload.id);
  addActivity(wsId, {
    kind: 'run', title: `Measuring ${workload.slug}`,
    detail: `${config.EVAL_FIRST_RUN_MIN_CALLS} calls in, which is enough for a bar to mean something.`,
    workloadId: workload.id,
  });
  enqueue('eval_run', { workloadId: workload.id }, { unique: true });
}

/* The observe path. Their provider answered; we get a copy afterwards. */
v1.post('/traces', (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const list = Array.isArray(body.traces) ? body.traces : [body];
  if (list.length > 200) {
    return res.status(400).json({ error: { message: 'Send at most 200 traces at a time.', type: 'too_many' } });
  }
  let accepted = 0;
  for (const t of list) {
    const request = t?.request;
    if (!request || !Array.isArray(request.messages)) continue;
    const workload = workloadFor(wsId, request);
    const usage = t?.response?.usage || {};
    const served = t?.response?.model || request.model || null;
    // we do not bill a traced call, but we do price it, because it is what their traffic costs today
    const own = served ? priceCall(served, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0) : null;
    recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'trace',
      requestedModel: request.model || null, servedModel: served,
      statusCode: 200,
      promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
      costUsd: own ?? 0, chargedUsd: own ?? 0,
      latencyMs: Number.isFinite(t?.latency_ms) ? t.latency_ms : null,
      request, response: t?.response ?? null,
    });
    considerMeasuring(wsId, workload);
    accepted += 1;
  }
  res.json({ accepted, rejected: list.length - accepted });
});

export default v1;
