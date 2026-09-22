import express from 'express';
import { safeRouter } from './safe.js';
import { db, now, id } from './db/index.js';
import { reportCallFailure } from './alerts.js';
import config, { canRoute } from './config.js';
import { verifyKey, bearerOf } from './keys.js';
import { workloadFor, recordCall, addActivity } from './traffic.js';
import { chat, chatStream, priceCall, UpstreamError } from './openrouter.js';
import { gateRouting, chargeCall, grantStarterCredit } from './billing.js';
import { enqueue } from './jobs.js';
import { refOf } from './learn/threads.js';
import { report } from './learn/outcomes.js';

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
  /* A switched-to model is asked the way it was measured, which for a thinking model with a
     tight answer cap means with its thinking switched off. */
  let recipe = null;
  if (workload?.routed_model && served === workload.routed_model && workload.routed_recipe) {
    try { recipe = JSON.parse(workload.routed_recipe); } catch { recipe = null; }
  }
  return { workload, requested, served, recipe };
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

export async function routeOnce(wsId, body, { source = 'routed', classify = true, ref = null } = {}) {
  const ready = await prepare(wsId, body, { classify });
  if (ready.error) {
    if (source === 'routed') await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return { ok: false, status: ready.error.status, json: ready.error.json };
  }
  const { workload, requested, served, recipe } = ready;
  // made up front, so the answer can carry it and the customer can report how this call went
  const callId = id('call');
  const started = Date.now();
  try {
    const { json, latencyMs } = await chat(body, served, { recipe });
    await finish({ wsId, workload, requested, served, usage: json?.usage, started, body,
      response: json, status: 200, latencyMs, source, callId, ref });
    return { ok: true, status: 200, json, served, requested, callId,
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
      id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
      servedModel: served, statusCode: status, latencyMs: Date.now() - started, request: body, ref,
    });
    return { ok: false, status, json, served, requested, callId };
  }
}

/* The routed path. The customer's client is unchanged except for the base URL, and
   the model they name is the model we measure against, not necessarily the one we send. */
v1.post('/chat/completions', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const ref = refOf(req.headers, body);
  if (!body.stream) {
    const out = await routeOnce(wsId, body, { ref });
    if (out.callId) res.setHeader('x-understudy-call-id', out.callId);
    return res.status(out.status).json(out.json);
  }
  const ready = await prepare(wsId, body);
  if (ready.error) {
    await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return res.status(ready.error.status).json(ready.error.json);
  }
  const { workload, requested, served, recipe } = ready;
  const callId = id('call');
  const started = Date.now();
  try {
    const upstream = await chatStream(body, served, { recipe });
    res.status(200);
    res.setHeader('x-understudy-call-id', callId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let usage = null;
    /* The answer, put back together from the pieces it streamed in. It used to be thrown
       away, so a streamed call could be counted and charged but never read: the workload
       page could show what was asked and nothing of what came back. */
    let answer = '';
    const toolCalls = [];
    let finish_reason = null;
    let model = null;
    // when the first word reached the customer: what somebody watching a streamed answer waits for
    let firstAt = null;
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const read = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        // the last chunk carries usage, which is what the customer is charged on
        if (j.usage) usage = j.usage;
        if (j.model) model = j.model;
        const ch = j.choices?.[0];
        if (typeof ch?.delta?.content === 'string') answer += ch.delta.content;
        if (Array.isArray(ch?.delta?.tool_calls)) {
          for (const tc of ch.delta.tool_calls) {
            const at = Number.isInteger(tc.index) ? tc.index : toolCalls.length;
            const c = toolCalls[at] || (toolCalls[at] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.function.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') c.function.arguments += tc.function.arguments;
          }
        }
        if (firstAt === null && ((typeof ch?.delta?.content === 'string' && ch.delta.content)
          || (Array.isArray(ch?.delta?.tool_calls) && ch.delta.tool_calls.length))) firstAt = Date.now();
        if (ch?.finish_reason) finish_reason = ch.finish_reason;
      } catch { /* not a JSON line, which SSE comments and keep-alives are allowed to be */ }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      buf += text;
      /* Only lines that have ENDED are read. The last piece of a chunk may be half a line,
         and a half line that happens to be valid JSON on its own would otherwise be read
         now and again when it completes, doubling that part of the answer. */
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) read(line);
      res.write(text);
    }
    if (buf) read(buf);
    res.end();
    const calls = toolCalls.filter(Boolean);
    const response = {
      model, streamed: true, usage,
      choices: [{ index: 0, message: { role: 'assistant', content: answer, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason }],
    };
    await finish({ wsId, workload, requested, served, usage, started, body, response, status: 200,
      ttftMs: firstAt === null ? null : firstAt - started, callId, ref });
    return undefined;
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    const payload = err instanceof UpstreamError ? err.body : { error: { message: 'The provider could not be reached.' } };
    reportCallFailure({
      kind: 'streamed call', model: served, status, workspaceId: wsId,
      message: payload?.error?.message || err.message,
    });
    await recordCall({
      id: callId, workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: served, statusCode: status, latencyMs: Date.now() - started, request: body, ref,
    });
    if (!res.headersSent) res.status(status).json(payload);
    else res.end();
    return undefined;
  }
});

async function finish({ wsId, workload, requested, served, usage, started, body, response, status,
  latencyMs, ttftMs = null, source = 'routed', callId = null, ref = null, decision = null }) {
  const cost = Number(usage?.cost ?? 0);
  const note = workload ? `${workload.slug} on ${served}` : `Test call on ${served}`;
  const charged = cost > 0 ? await chargeCall(wsId, cost, note) : 0;
  await recordCall({
    id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
    servedModel: served, statusCode: status,
    promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
    costUsd: cost, chargedUsd: charged, latencyMs: latencyMs ?? Date.now() - started, ttftMs,
    request: body, response, ref, ...(decision || {}),
  });
  if (workload) await considerMeasuring(wsId, workload);
}

/** Once a workload has enough calls to be trusted, it measures itself without being asked. */
export async function considerMeasuring(wsId, workload) {
  if (workload.status !== 'new') return;
  /* A workload somebody stopped measuring is "new" again, but a person has answered it, and the
     very next call must not start it again behind their back: the schedule on Settings takes it
     from there. Only a stop counts. A run a restart interrupted, or one the balance cut short,
     was answered by nobody, and waiting a whole cadence for it would leave a new workload
     unmeasured for a month. */
  if (await db.prepare(`SELECT 1 FROM eval_runs WHERE workload_id = ? AND status = 'stopped' LIMIT 1`)
    .get(workload.id)) return;
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
      ref: t?.ref !== undefined && t?.ref !== null && t?.ref !== '' ? String(t.ref).slice(0, 200) : refOf(req.headers, request),
    });
    await considerMeasuring(wsId, workload);
    accepted += 1;
  }
  res.json({ accepted, rejected: list.length - accepted });
});

/* How calls turned out, told to us afterwards: a ticket resolved, an email answered, a form a
   person had to correct. Named by the call id each answer carries in x-understudy-call-id, or by
   the customer's own reference sent with the call (x-understudy-ref, or metadata.ref). One or
   many at once. */
v1.post('/outcomes', async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.outcomes) ? body.outcomes : Array.isArray(body) ? body : [body];
  if (!list.length) return res.status(400).json({ error: { message: 'Send an outcome, or a list of them under "outcomes".', type: 'invalid_request_error' } });
  if (list.length > 500) return res.status(400).json({ error: { message: 'Send at most 500 outcomes at a time.', type: 'too_many' } });
  const out = await report(req.key.workspace_id, list);
  return res.json(out);
});

export default v1;
