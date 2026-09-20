import express from 'express';
import { safeRouter } from './safe.js';
import { db, now } from './db/index.js';
import { reportCallFailure } from './alerts.js';
import config, { canRoute } from './config.js';
import { verifyKey, bearerOf } from './keys.js';
import { workloadFor, recordCall, addActivity } from './traffic.js';
import { chat, chatStream, priceCall, UpstreamError } from './openrouter.js';
import { gateRouting, chargeCall, grantStarterCredit } from './billing.js';
import { enqueue } from './jobs.js';

export const v1 = safeRouter();

/** Every /v1 route is authenticated by the customer's own key, never by a session. */
async function auth(req, res, next) {
  const key = await verifyKey(bearerOf(req));
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
v1.get('/models', async (req, res) => {
  /* An empty list is a lie here. It reads as "there are no models", when what is true is
     that this deployment cannot reach a provider, so nothing has been priced or synced.
     Say that, in the same words /chat/completions uses. */
  if (!canRoute()) {
    return res.status(503).json({
      error: { message: 'Routing is not configured on this deployment yet.', type: 'not_configured' },
    });
  }
  const rows = await db.prepare(
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

/* Everything a routed call needs before it is sent, or the reason it cannot be, so the
   streaming path, the ordinary path and Connect's test call all answer the same way. */
async function prepare(wsId, body, { classify = true } = {}) {
  const no = (status, message, type) => ({ error: { status, json: { error: { message, type } } } });
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return no(400, '"messages" is required.', 'invalid_request_error');
  }
  if (!canRoute()) return no(503, 'Routing is not configured on this deployment yet.', 'not_configured');
  await grantStarterCredit(wsId);
  const gate = await gateRouting(wsId);
  if (!gate.ok) return { error: { status: 402, json: { error: { message: gate.message, type: gate.code } } } };
  /* A test call is not the customer's traffic, so it is never fingerprinted into a
     workload: it would leave a one-call workload in their list that nothing produced. */
  const workload = classify ? await workloadFor(wsId, body) : null;
  const requested = body.model || workload?.reference_model || null;
  const served = workload?.routed_model || requested;
  if (!served) return no(400, '"model" is required.', 'invalid_request_error');
  return { workload, requested, served };
}

/* One routed call, from the gate to the ledger. The proxy uses this for every ordinary
   call, and so does Connect's "Send a test call", which is the point: what the test
   proves is what a real call does, because it is the same path, the same gate, the same
   charge and the same row. */
/* A call we refused is still a call that arrived, and it is the only evidence the customer
   has that their wiring works. Refusing it silently was the worst of both: their integration
   was correct, nothing appeared anywhere, and the getting started guide sat waiting for a
   call that could never come. Recorded at most once a minute per workspace, so a client
   retrying in a loop leaves one line rather than ten thousand. */
const lastRefusal = new Map();
async function recordRefusal(wsId, body, status, json) {
  const last = lastRefusal.get(wsId) || 0;
  if (Date.now() - last < 60000) return;
  lastRefusal.set(wsId, Date.now());
  await recordCall({
    workspaceId: wsId, workloadId: null, source: 'routed',
    requestedModel: body?.model ?? null, servedModel: null,
    statusCode: status, latencyMs: 0, request: body,
    response: json ?? null,
  }).catch(() => { /* never let bookkeeping break the answer */ });
}

export async function routeOnce(wsId, body, { source = 'routed', classify = true } = {}) {
  const ready = await prepare(wsId, body, { classify });
  if (ready.error) {
    if (source === 'routed') await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return { ok: false, status: ready.error.status, json: ready.error.json };
  }
  const { workload, requested, served } = ready;
  const started = Date.now();
  try {
    const { json, latencyMs } = await chat(body, served);
    await finish({ wsId, workload, requested, served, usage: json?.usage, started, body,
      response: json, status: 200, latencyMs, source });
    return { ok: true, status: 200, json, served, requested,
      latencyMs: latencyMs ?? Date.now() - started, costUsd: Number(json?.usage?.cost ?? 0) };
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    const json = err instanceof UpstreamError ? err.body
      : { error: { message: 'The provider could not be reached.' } };
    reportCallFailure({
      kind: source === 'test' ? 'test call' : 'routed call',
      model: served, status, workspaceId: wsId,
      message: json?.error?.message || err.message,
    });
    await recordCall({
      workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
      servedModel: served, statusCode: status, latencyMs: Date.now() - started, request: body,
    });
    return { ok: false, status, json, served, requested };
  }
}

/* The routed path. The customer's client is unchanged except for the base URL, and
   the model they name is the model we measure against, not necessarily the one we send. */
v1.post('/chat/completions', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  if (!body.stream) {
    const out = await routeOnce(wsId, body);
    return res.status(out.status).json(out.json);
  }
  const ready = await prepare(wsId, body);
  if (ready.error) {
    await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return res.status(ready.error.status).json(ready.error.json);
  }
  const { workload, requested, served } = ready;
  const started = Date.now();
  try {
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
    await finish({ wsId, workload, requested, served, usage, started, body, response: null, status: 200 });
    return undefined;
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    const payload = err instanceof UpstreamError ? err.body : { error: { message: 'The provider could not be reached.' } };
    reportCallFailure({
      kind: 'streamed call', model: served, status, workspaceId: wsId,
      message: payload?.error?.message || err.message,
    });
    await recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: served, statusCode: status, latencyMs: Date.now() - started, request: body,
    });
    if (!res.headersSent) res.status(status).json(payload);
    else res.end();
    return undefined;
  }
});

async function finish({ wsId, workload, requested, served, usage, started, body, response, status,
  latencyMs, source = 'routed' }) {
  const cost = Number(usage?.cost ?? 0);
  const note = workload ? `${workload.slug} on ${served}` : `Test call on ${served}`;
  const charged = cost > 0 ? await chargeCall(wsId, cost, note) : 0;
  await recordCall({
    workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
    servedModel: served, statusCode: status,
    promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
    costUsd: cost, chargedUsd: charged, latencyMs: latencyMs ?? Date.now() - started,
    request: body, response,
  });
  if (workload) await considerMeasuring(wsId, workload);
}

/** Once a workload has enough calls to be trusted, it measures itself without being asked. */
export async function considerMeasuring(wsId, workload) {
  if (workload.status !== 'new') return;
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?').get(workload.id)).n;
  if (n < config.EVAL_FIRST_RUN_MIN_CALLS) return;
  await db.prepare(`UPDATE workloads SET status = 'measuring', updated_at = ? WHERE id = ?`).run(now(), workload.id);
  await addActivity(wsId, {
    kind: 'run', title: `Measuring ${workload.slug}`,
    detail: `${config.EVAL_FIRST_RUN_MIN_CALLS} calls in, which is enough for a bar to mean something.`,
    workloadId: workload.id,
  });
  await enqueue('eval_run', { workloadId: workload.id }, { unique: true });
}

/* The observe path. Their provider answered; we get a copy afterwards. */
v1.post('/traces', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const list = Array.isArray(body.traces) ? body.traces : [body];
  if (list.length > 200) {
    return res.status(400).json({ error: { message: 'Send at most 200 traces at a time.', type: 'too_many' } });
  }
  await grantStarterCredit(wsId);
  let accepted = 0;
  for (const t of list) {
    const request = t?.request;
    if (!request || !Array.isArray(request.messages)) continue;
    const workload = await workloadFor(wsId, request);
    const usage = t?.response?.usage || {};
    const served = t?.response?.model || request.model || null;
    // we do not bill a traced call, but we do price it, because it is what their traffic costs today
    const own = served ? await priceCall(served, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0) : null;
    await recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'trace',
      requestedModel: request.model || null, servedModel: served,
      statusCode: 200,
      promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
      /* Priced, not charged. A copy is a call the customer already paid their own provider
         for; we take nothing for it. Recording it as charged put their provider's bill into
         "what you paid us", so a customer who only sends copies appeared to be paying us and
         the two lines on the spend chart were the same line drawn twice. */
      costUsd: own ?? 0, chargedUsd: 0,
      latencyMs: Number.isFinite(t?.latency_ms) ? t.latency_ms : null,
      request, response: t?.response ?? null,
    });
    await considerMeasuring(wsId, workload);
    accepted += 1;
  }
  res.json({ accepted, rejected: list.length - accepted });
});

export default v1;
