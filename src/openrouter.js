import config, { canRoute } from './config.js';
import { db, now } from './db/index.js';

/* One account, one key. Every call states that it will only accept a provider that
   retains nothing, and every call reports its own cost so nothing is estimated. */

const lastCallAt = new Map();

const waitForSlot = async (model) => {
  const gap = config.MODEL_MIN_GAP_MS;
  if (!gap) return;
  const last = lastCallAt.get(model) || 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(model, Date.now());
};

export class UpstreamError extends Error {
  constructor(status, body) {
    super(`upstream ${status}`);
    this.status = status;
    this.body = body;
  }
}

function headers() {
  return {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.PUBLIC_URL,
    'X-Title': 'Understudy',
  };
}

/** The request the proxy and every replay both send, so a certificate tests the real thing. */
export function buildUpstream(body, model) {
  const out = { ...body, model };
  delete out.stream_options;
  if (config.ZDR_ONLY) out.provider = { ...(out.provider || {}), zdr: true, data_collection: 'deny' };
  return out;
}

export async function chat(body, model, { signal, retries = 3 } = {}) {
  if (!canRoute()) throw new UpstreamError(503, { error: { message: 'No OPENROUTER_API_KEY is set.' } });
  const payload = buildUpstream(body, model);
  for (let attempt = 0; ; attempt += 1) {
    await waitForSlot(model);
    const started = Date.now();
    const res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
      method: 'POST', headers: headers(), body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* upstream sent something unparseable */ }
    if (res.status === 429 && attempt < retries) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after : 2000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new UpstreamError(res.status, json ?? { error: { message: text.slice(0, 400) } });
    return { json, latencyMs: Date.now() - started };
  }
}

/** Streaming passes straight through; the final chunk carries usage, which is what we bill on. */
export async function chatStream(body, model, { signal } = {}) {
  if (!canRoute()) throw new UpstreamError(503, { error: { message: 'No OPENROUTER_API_KEY is set.' } });
  const payload = buildUpstream(body, model);
  payload.stream = true;
  payload.stream_options = { include_usage: true };
  await waitForSlot(model);
  const res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
    method: 'POST', headers: headers(), body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    throw new UpstreamError(res.status, json ?? { error: { message: text.slice(0, 400) } });
  }
  return res;
}

/* OpenRouter's own routing products. They are not models: they choose one for you at call
   time, and they are listed at a price of zero, so they sort to the front of every "cheapest"
   query and would quietly become the default. A certificate has to name the exact model it
   measured, and a thing that picks a different model each call can never be that. */
const isRouter = (id) => id.startsWith('openrouter/');

/** The live model list, priced. Routers, aliases, batch-only and rate-capped ids are left out. */
export async function fetchModels() {
  const res = await fetch(`${config.OPENROUTER_BASE}/models`);
  if (!res.ok) throw new UpstreamError(res.status, { error: { message: 'model list unavailable' } });
  const { data } = await res.json();
  return (data || [])
    .filter((m) => typeof m.id === 'string')
    .filter((m) => !m.id.startsWith('~') && !m.id.endsWith(':batch') && !m.id.endsWith(':free'))
    .filter((m) => !isRouter(m.id))
    /* A model with no price cannot be compared on cost, which is the whole product. */
    .filter((m) => Number(m.pricing?.prompt || 0) > 0 || Number(m.pricing?.completion || 0) > 0)
    .map((m) => ({
      model_id: m.id,
      name: m.name || m.id,
      context_len: m.context_length || null,
      price_in: Number(m.pricing?.prompt || 0),
      price_out: Number(m.pricing?.completion || 0),
      open_weights: /^(mistralai|deepseek|meta-llama|qwen|google\/gemma|nousresearch|microsoft\/phi)/.test(m.id) ? 1 : 0,
      zdr: 0,
    }));
}

export async function saveCatalog(models) {
  const at = now();
  /* The whole catalogue lands at once. A half-written catalogue would price some models
     and not others, and every cost figure on every screen reads from this table. */
  await db.tx(async (tx) => {
    const stmt = tx.prepare(
      `INSERT INTO models_catalog (model_id, name, context_len, price_in, price_out, open_weights, zdr, synced_at)
       VALUES (@model_id, @name, @context_len, @price_in, @price_out, @open_weights, @zdr, @synced_at)
       ON CONFLICT(model_id) DO UPDATE SET name = excluded.name, context_len = excluded.context_len,
         price_in = excluded.price_in, price_out = excluded.price_out,
         open_weights = excluded.open_weights, synced_at = excluded.synced_at`);
    for (const m of models) await stmt.run({ ...m, synced_at: at });
  });
  return models.length;
}

/** What one call's tokens cost on a given model, from the synced catalogue only. */
export async function priceCall(modelId, promptTokens, completionTokens) {
  const m = await db.prepare('SELECT price_in, price_out FROM models_catalog WHERE model_id = ?').get(modelId);
  if (!m) return null;
  return m.price_in * promptTokens + m.price_out * completionTokens;
}
