import express from 'express';
import { safeRouter } from './safe.js';
import { db, now, id } from './db/index.js';
import { reportCallFailure } from './alerts.js';
import config, { canRoute } from './config.js';
import { verifyKey, bearerOf } from './keys.js';
import { workloadFor, recordCall, addActivity } from './traffic.js';
import { chat, chatStream, priceCall, UpstreamError, reasonOf, hintApplies } from './openrouter.js';
import { gateRouting, chargeCall, grantStarterCredit, hold, release, worstCaseTokens, withFee } from './billing.js';
import { enqueue } from './jobs.js';
import { refOf } from './learn/threads.js';
import { workloadNameOf, pinnedOf } from './classify.js';
import { report } from './learn/outcomes.js';
import { chooseStrategy, served as noteServed } from './learn/choose.js';
import { serveWith, writeAsStream } from './learn/serve.js';
import { leadModel } from './learn/arms.js';
import { zdrFor, cacheHintFor } from './workspace.js';
import { featuresOf, predict } from './learn/router.js';

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

/* A model named the way its maker's own SDK names it ("gpt-4o", "claude-sonnet-5") is found in the
   catalogue under its maker ("openai/gpt-4o"), so pointing an existing client at Understudy needs only
   the address changed. Where several makers sell the same name, the one that made it comes first. */
const MAKERS = ['openai', 'anthropic', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'cohere', 'amazon'];
const canonical = new Map();
export async function canonicalModel(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('/')) return { model: name, known: true };
  const bare = name.trim();
  const hit = canonical.get(bare);
  if (hit && Date.now() - hit.at < 600000) return hit.v;
  const rows = await db.prepare(`SELECT model_id FROM models_catalog WHERE model_id LIKE ?`).all(`%/${bare.replace(/[\\%_]/g, '\\$&')}`);
  const any = Number((await db.prepare('SELECT COUNT(*) AS n FROM models_catalog').get())?.n ?? 0) > 0;
  let v;
  if (rows.length) {
    const rank = (id) => { const i = MAKERS.indexOf(id.split('/')[0]); return i < 0 ? MAKERS.length : i; };
    v = { model: rows.map((r) => r.model_id).sort((a, b) => rank(a) - rank(b))[0], known: true };
  } else {
    // with no catalogue read yet nothing can be said, so the name goes through as it came
    v = { model: bare, known: !any };
  }
  canonical.set(bare, { at: Date.now(), v });
  if (canonical.size > 2000) canonical.clear();
  return v;
}

/* Everything a routed call needs before it is sent, or the reason it cannot be, so the
   streaming path, the ordinary path and Connect's test call all answer the same way. */
async function prepare(wsId, body, { classify = true, name = null, pinned = false } = {}) {
  const no = (status, message, type) => ({ error: { status, json: { error: { message, type } } } });
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return no(400, '"messages" is required.', 'invalid_request_error');
  }
  if (!canRoute()) return no(503, 'Routing is not configured on this deployment yet.', 'not_configured');
  if (body.model) {
    const named = await canonicalModel(body.model);
    if (!named.known) {
      return no(400, `"${String(body.model).slice(0, 80)}" is not a model we know. Name it with its maker, `
        + 'for example openai/gpt-5.4; every model is listed at GET /v1/models.', 'model_not_found');
    }
    body.model = named.model;
  }
  await grantStarterCredit(wsId);
  const gate = await gateRouting(wsId);
  if (!gate.ok) return { error: { status: 402, json: { error: { message: gate.message, type: gate.code } } } };
  /* A test call is not the customer's traffic, so it is never fingerprinted into a
     workload: it would leave a one-call workload in their list that nothing produced. */
  const workload = classify ? await workloadFor(wsId, body, { name }) : null;
  const requested = body.model || workload?.reference_model || null;
  /* The strategy that serves this call: the one the workload was switched to (a model asked the
     way it was measured, or a cascade, or a pick made call by call), or, now and then and within
     the workload's limits, one being tried. None, and the call goes to the model it asked for. */
  // a pinned call is answered by the model it names: no switch, no experiment
  const strategy = workload && !pinned ? await chooseStrategy(workload, { body }) : null;
  const lead = strategy ? leadModel(strategy.spec) : null;
  const served = lead?.model || requested;
  if (!served) return no(400, '"model" is required.', 'invalid_request_error');
  const recipe = lead?.recipe ?? null;
  const zdr = await zdrFor(wsId);
  // whether a long instruction may be marked for caching on this call (see hintApplies)
  const cacheHint = workload ? await cacheHintFor(wsId, workload) : false;
  return { workload, requested, served, recipe, strategy, zdr, cacheHint };
}

/* Every model one call could end up paying for: the one it is served by, the customer's own model,
   and whatever a strategy may send it on to. */
function modelsOf(ready) {
  const out = new Set([ready.served, ready.requested, ready.workload?.reference_model].filter(Boolean));
  for (const s of [ready.strategy, ready.strategy?.fallback]) {
    const spec = s?.spec;
    if (!spec) continue;
    if (spec.kind === 'cascade') { out.add(spec.first?.model); out.add(spec.fallback?.model); }
    else if (spec.kind === 'router') { out.add(spec.cheap?.model); out.add(spec.strong?.model); }
    else out.add(spec.model);
  }
  out.delete(undefined);
  return [...out];
}

/* Set aside what this call could cost before it is sent. The dearest model it could touch, at its
   list price times a margin (a provider that keeps nothing can charge more than the list), for the
   whole prompt and the longest answer it allows; twice that when a strategy can pay for two models
   on one call. A model with no known price is held at a fixed amount. */
async function holdFor(wsId, body, ready) {
  const { pin, pout } = worstCaseTokens(body);
  let worst = 0;
  for (const m of modelsOf(ready)) {
    const p = await priceCall(m, pin, pout);
    if (p !== null && p > worst) worst = p;
  }
  const est = worst > 0 ? worst * config.HOLD_PRICE_MULTIPLE : config.HOLD_UNPRICED_USD;
  const twice = [ready.strategy?.spec?.kind, ready.strategy?.fallback ? 'fallback' : null].some((k) => k === 'cascade' || k === 'fallback');
  return hold(wsId, withFee(est * (twice ? 2 : 1)), 'call');
}

const cannotCover = (h) => ({
  status: 402,
  json: { error: {
    message: h.inFlight > 0
      ? 'Your balance is set aside for calls still in flight and cannot cover this one. Add credit, or send fewer calls at once.'
      : 'Your balance is empty. Add credit in Settings and calls resume immediately.',
    type: 'no_balance',
  } },
});

/* What a call says about how it was decided, kept on its row: the strategy, the chance it had of
   being chosen, whether it was an experiment, and for a cascade whether it was sent on and why. */
const decisionOf = (strategy, out = null) => (strategy ? {
  armId: strategy.armId, propensity: strategy.propensity, explored: strategy.explored,
  escalated: out ? !!out.escalated : null, check: out?.check ?? null,
} : null);

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

/* What a strategy serves a call with, before anything reaches the customer. */
const leadOf = (strategy, ready) => {
  if (!strategy) return { served: ready.served, recipe: ready.recipe };
  const lead = leadModel(strategy.spec);
  return { served: lead.model, recipe: lead.recipe ?? null };
};
const failureOf = (err) => ({
  status: err instanceof UpstreamError ? err.status : 502,
  json: err instanceof UpstreamError ? err.body : { error: { message: 'The provider could not be reached.' } },
});

/* An experiment's call that the provider failed, kept as its own row so what learning reads about
   that strategy includes the failure, before the call is served the usual way instead. */
async function keepFailedTry({ wsId, workload, requested, served, started, body, ref, source, strategy, err, fellBack = false }) {
  const f = failureOf(err);
  await recordCall({
    workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested, servedModel: served,
    statusCode: f.status, latencyMs: Date.now() - started, request: body, ref, costUsd: Number(err?.spent) || 0,
    ...(decisionOf(strategy) || {}),
    // "fell back" is what the watch and the learning review count against what serves
    check: { by: fellBack ? 'fell back' : 'experiment failed', status: f.status, why: reasonOf(err).slice(0, 160) },
  }).catch(() => { /* never let bookkeeping stand in the way of the answer */ });
}

/* The strategies one call may be served by, in order: an experiment, then what serves, then the
   customer's own model. */
const chainOf = (strategy) => {
  const out = [];
  for (let s = strategy, n = 0; s && n < 4; s = s.fallback, n += 1) out.push(s);
  return out;
};

/* Whether the customer's own model would likely answer where what serves failed: the provider was
   down, busy or slow, the model has gone, or the call is longer or asks for more than this model
   takes. A request that is simply malformed would fail on their model too, and is answered as it is. */
export function worthFallback(err) {
  const st = err instanceof UpstreamError ? err.status : 502;
  if (st === 0 || st === 404 || st === 408 || st === 429 || st >= 500) return true;
  if (st === 400 || st === 413 || st === 422) {
    return /context|too long|too many tokens|maximum|max_tokens|token limit|length|not supported|unsupported|does not support|no endpoints|not available/i
      .test(reasonOf(err));
  }
  return false;
}

/* How long a live call waits on a busy provider. A measurement can wait out a rate limit; somebody
   whose app is waiting on this call cannot, so a live call gets one short retry and then the next
   strategy in its chain, and an experiment gets none and a time limit. */
const liveOpts = (strategy) => (strategy?.explored
  ? { retries: 0, signal: AbortSignal.timeout(config.EXPERIMENT_TIMEOUT_MS) }
  : { retries: config.LIVE_RETRIES, maxWaitMs: config.LIVE_RETRY_WAIT_MAX_MS });

/* The bookkeeping after an answer, apart from the provider's part: a slip in it is logged, and never
   turns an answer the customer has already been sent, and paid for, into an error. */
async function settle(args) {
  try {
    await finish(args);
  } catch (err) {
    console.error(`bookkeeping for ${args.callId} failed: ${err?.message || err}`);
  }
}

export async function routeOnce(wsId, body, { source = 'routed', classify = true, ref = null, name = null, pinned = false } = {}) {
  const ready = await prepare(wsId, body, { classify, name, pinned });
  if (ready.error) {
    if (source === 'routed') await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return { ok: false, status: ready.error.status, json: ready.error.json };
  }
  const h = await holdFor(wsId, body, ready);
  if (!h.ok) {
    const f = cannotCover(h);
    if (source === 'routed') await recordRefusal(wsId, body, f.status, f.json);
    return { ok: false, status: f.status, json: f.json };
  }
  const { workload, requested } = ready;
  // made up front, so the answer can carry it and the customer can report how this call went
  const callId = id('call');
  const started = Date.now();
  // the strategy for this call, then what serves as usual, then the customer's own model
  const tries = chainOf(ready.strategy);
  if (!tries.length) tries.push(null);
  for (const [k, strategy] of tries.entries()) {
    const next = tries[k + 1];
    const { served, recipe } = leadOf(strategy, ready);
    let out;
    try {
      if (strategy && strategy.spec.kind !== 'model') {
        out = await serveWith(strategy.spec, body, { shape: workload.shape_kind, scope: wsId, zdr: ready.zdr });
      } else {
        const r = await chat(body, served, { recipe, zdr: ready.zdr, cacheHint: ready.cacheHint, ...liveOpts(strategy) });
        out = { json: r.json, served, cost: Number(r.json?.usage?.cost ?? 0), latencyMs: r.latencyMs ?? Date.now() - started };
      }
    } catch (err) {
      if (next && (!next.isFallback || worthFallback(err))) {
        await keepFailedTry({ wsId, workload, requested, served, started, body, ref, source, strategy, err, fellBack: !!next.isFallback });
        continue;
      }
      const f = failureOf(err);
      reportCallFailure({
        kind: source === 'test' ? 'test call' : 'routed call',
        model: served, status: f.status, workspaceId: wsId,
        message: f.json?.error?.message || err.message,
      });
      await recordCall({
        id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
        servedModel: served, statusCode: f.status, latencyMs: Date.now() - started, request: body, ref,
        // what a strategy had already spent on it before it failed, kept, though nobody is charged for it
        costUsd: Number(err?.spent) || 0, ...(decisionOf(strategy) || {}),
      }).catch(() => {});
      await release(h.holdId).catch(() => {});
      return { ok: false, status: f.status, json: f.json, served, requested, callId };
    }
    // charged for everything the strategy spent on it: a cascade's check, and a call it sent on
    await settle({ wsId, workload, requested, served: out.served, usage: { ...(out.json?.usage || {}), cost: out.cost },
      started, body, response: out.json, status: 200, latencyMs: out.latencyMs, source, callId, ref,
      decision: decisionOf(strategy, strategy && strategy.spec.kind !== 'model' ? out : null), holdId: h.holdId,
      cacheHint: ready.cacheHint && (!strategy || strategy.spec.kind === 'model') });
    return { ok: true, status: 200, json: out.json, served: out.served, requested, callId,
      latencyMs: out.latencyMs, costUsd: out.cost, workload: workload?.slug ?? null };
  }
  await release(h.holdId).catch(() => {});
  return { ok: false, status: 502, json: { error: { message: 'The provider could not be reached.' } }, callId };
}

/* The routed path. The customer's client is unchanged except for the base URL, and
   the model they name is the model we measure against, not necessarily the one we send. */
v1.post('/chat/completions', async (req, res) => {
  const wsId = req.key.workspace_id;
  const body = req.body || {};
  const ref = refOf(req.headers, body);
  // the workload the customer says this call is, if they name their jobs
  const name = workloadNameOf(req.headers, body);
  // and whether it must be answered by the model it names
  const pinned = pinnedOf(req.headers, body);
  if (!body.stream) {
    const out = await routeOnce(wsId, body, { ref, name, pinned });
    if (out.callId) res.setHeader('x-understudy-call-id', out.callId);
    // which model answered, and which workload the call joined, for the customer's own logs
    if (out.served) res.setHeader('x-understudy-served-model', out.served);
    if (out.workload) res.setHeader('x-understudy-workload', out.workload);
    return res.status(out.status).json(out.json);
  }
  const ready = await prepare(wsId, body, { name, pinned });
  if (ready.error) {
    await recordRefusal(wsId, body, ready.error.status, ready.error.json);
    return res.status(ready.error.status).json(ready.error.json);
  }
  const h = await holdFor(wsId, body, ready);
  if (!h.ok) {
    const f = cannotCover(h);
    await recordRefusal(wsId, body, f.status, f.json);
    return res.status(f.status).json(f.json);
  }
  const { workload, requested } = ready;
  const callId = id('call');
  const started = Date.now();
  const tries = chainOf(ready.strategy);
  if (!tries.length) tries.push(null);
  for (const [k, strategy] of tries.entries()) {
    const next = tries[k + 1];
    const r = await streamWith({ res, wsId, workload, requested, body, ref, callId, started, strategy, ready, holdId: h.holdId });
    // an answer that failed part way was never charged, so what it set aside goes back
    if (r.sent) await release(h.holdId).catch(() => {});
    if (r.ok || r.sent) return undefined;
    // nothing has reached the customer yet: a failure is kept, and the call served the next way
    if (next && (!next.isFallback || worthFallback(r.err))) {
      await keepFailedTry({ wsId, workload, requested, served: r.served, started, body, ref, source: 'routed', strategy, err: r.err, fellBack: !!next.isFallback });
      continue;
    }
    const f = failureOf(r.err);
    reportCallFailure({ kind: 'streamed call', model: r.served, status: f.status, workspaceId: wsId,
      message: f.json?.error?.message || r.err?.message });
    await recordCall({
      id: callId, workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: r.served, statusCode: f.status, latencyMs: Date.now() - started, request: body, ref,
      costUsd: Number(r.err?.spent) || 0, ...(decisionOf(strategy) || {}),
    }).catch(() => {});
    await release(h.holdId).catch(() => {});
    return res.status(f.status).json(f.json);
  }
  await release(h.holdId).catch(() => {});
  return undefined;
});

/* One streamed call on one strategy. Answers { ok } once the whole answer has gone out; { sent } when
   the provider failed part way, after the answer had started, which is ended as it stands; or the
   failure, with nothing sent yet, so the caller can try again or say so. */
async function streamWith({ res, wsId, workload, requested, body, ref, callId, started, strategy, ready, holdId = null }) {
  let { served, recipe } = leadOf(strategy, ready);
  let decision = decisionOf(strategy);
  if (strategy && strategy.spec.kind === 'cascade') {
    /* A cascade cannot stream its first answer before the check has read it, so the answer is
       worked out whole and then sent as a stream. The first word arrives when the whole answer
       would have; a measurement holds a cascade to the workload's speed setting on exactly that. */
    let out;
    try {
      out = await serveWith(strategy.spec, body, { shape: workload.shape_kind, scope: wsId, zdr: ready.zdr });
    } catch (err) {
      return { ok: false, err, served };
    }
    res.status(200);
    res.setHeader('x-understudy-call-id', callId);
    res.setHeader('x-understudy-served-model', out.served);
    if (workload?.slug) res.setHeader('x-understudy-workload', workload.slug);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    writeAsStream(res, out.json);
    res.end();
    await settle({ wsId, workload, requested, served: out.served, usage: { ...(out.json?.usage || {}), cost: out.cost },
      started, body, response: out.json, status: 200, latencyMs: out.latencyMs, ttftMs: out.latencyMs, callId, ref,
      decision: decisionOf(strategy, out), holdId });
    return { ok: true };
  }
  if (strategy && strategy.spec.kind === 'router') {
    // picked before anything is sent, from what can be seen of the call, so it streams as ever
    const p = predict(strategy.spec, featuresOf(body));
    const use = p >= strategy.spec.threshold ? strategy.spec.cheap : strategy.spec.strong;
    served = use.model;
    recipe = use.recipe ?? null;
    decision = { ...decision, escalated: use === strategy.spec.strong, check: { by: 'router', p: Math.round(p * 1000) / 1000 } };
  }
  let upstream;
  try {
    upstream = await chatStream(body, served, { recipe, zdr: ready.zdr, cacheHint: ready.cacheHint });
  } catch (err) {
    return { ok: false, err, served };
  }
  res.status(200);
  res.setHeader('x-understudy-call-id', callId);
  res.setHeader('x-understudy-served-model', served);
  if (workload?.slug) res.setHeader('x-understudy-workload', workload.slug);
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
  try {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
  } catch (err) {
    // the answer had started, so it cannot be tried again: it is ended where it stands
    reportCallFailure({ kind: 'streamed call', model: served, status: 502, workspaceId: wsId, message: err?.message });
    await recordCall({
      id: callId, workspaceId: wsId, workloadId: workload.id, source: 'routed', requestedModel: requested,
      servedModel: served, statusCode: 502, latencyMs: Date.now() - started, request: body, ref, ...(decision || {}),
    }).catch(() => {});
    res.end();
    return { ok: false, sent: true };
  }
  const calls = toolCalls.filter(Boolean);
  const response = {
    model, streamed: true, usage,
    choices: [{ index: 0, message: { role: 'assistant', content: answer, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason }],
  };
  await settle({ wsId, workload, requested, served, usage, started, body, response, status: 200,
    ttftMs: firstAt === null ? null : firstAt - started, callId, ref, decision, holdId, cacheHint: ready.cacheHint });
  return { ok: true };
}

async function finish({ wsId, workload, requested, served, usage, started, body, response, status,
  latencyMs, ttftMs = null, source = 'routed', callId = null, ref = null, decision = null, holdId = null, cacheHint = false }) {
  const cost = Number(usage?.cost ?? 0);
  const note = workload ? `${workload.slug} on ${served}` : `Test call on ${served}`;
  // charged, and what the call set aside given back, in one step
  const charged = await chargeCall(wsId, cost, note, { holdId });
  await recordCall({
    id: callId, workspaceId: wsId, workloadId: workload?.id ?? null, source, requestedModel: requested,
    servedModel: served, statusCode: status,
    promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    // whether we marked its instruction for caching, so what that saved is counted as ours
    hinted: !!(cacheHint && hintApplies(body, served)),
    costUsd: cost, chargedUsd: charged, latencyMs: latencyMs ?? Date.now() - started, ttftMs,
    request: body, response, ref, ...(decision || {}),
  });
  if (workload) await considerMeasuring(wsId, workload);
  // a customer's answered call, which the learning layer may answer again in the background
  if (workload && source === 'routed' && status === 200) noteServed({ workload, body, response, callId, decision, costUsd: cost });
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
  if (workload.recheck_after && Number(workload.recheck_after) > now()) return;
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE workload_id = ?').get(workload.id)).n;
  if (n < config.EVAL_FIRST_RUN_MIN_CALLS) return;
  /* Booked, not announced: the measurement decides whether it can show anything yet, and says so when
     it starts. The booking is claimed in one statement, so the calls that follow do not book it again
     while it decides, and one it turns down is looked at again when it is due, not on every call. */
  const claimed = (await db.prepare(
    `UPDATE workloads SET recheck_after = ? WHERE id = ? AND status = 'new'
        AND (recheck_after IS NULL OR recheck_after <= ?)`).run(now() + 3600000, workload.id, now())).changes;
  if (!claimed) return;
  await enqueue('eval_run', { workloadId: workload.id, trigger: 'first' }, { unique: true });
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
    // a copy names its model however the customer's SDK did; it is priced and grouped under the catalogue's name
    if (request.model) request.model = (await canonicalModel(request.model)).model;
    if (t?.response?.model && !String(t.response.model).includes('/')) {
      const named = await canonicalModel(t.response.model);
      if (named.model.includes('/')) t.response.model = named.model;
    }
    const named = typeof t?.workload === 'string' && t.workload.trim() ? t.workload.trim().slice(0, 80) : workloadNameOf(req.headers, request);
    const workload = await workloadFor(wsId, request, { name: named });
    const usage = t?.response?.usage || {};
    const served = t?.response?.model || request.model || null;
    // we do not bill a traced call, but we do price it, because it is what their traffic costs today
    const own = served ? await priceCall(served, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0) : null;
    await recordCall({
      workspaceId: wsId, workloadId: workload.id, source: 'trace',
      requestedModel: request.model || null, servedModel: served,
      statusCode: 200,
      promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
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
