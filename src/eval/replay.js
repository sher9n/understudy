import crypto from 'node:crypto';
import config from '../config.js';
import { db, now } from '../db/index.js';
import { chat, streamCollect, UpstreamError, reasonOf } from '../openrouter.js';
import { recordCall } from '../traffic.js';

/* Replaying one of a workload's calls on one model, remembering what was paid for.
 *
 * The same call, sent to the same model the same way, costs the same again and says nothing
 * new. So every answer is kept, and a later measurement that needs it uses the kept one instead
 * of buying it twice: the customer's own model answering each sampled call twice to set the bar
 * is exactly the work two measurements a week apart would otherwise both pay for.
 *
 * An answer is only reused while it is recent, because what is true about a model today is not
 * true for ever: providers change, and a model is retrained under the same name. A refusal is
 * kept for far less time than an answer, because a missing provider can appear within the day.
 * A failure that was only the provider being busy is never kept at all. */

const DAY = 86400000;
const HOUR = 3600000;

/* The parts of a request that change nothing about the answer. */
const VOLATILE = ['stream', 'stream_options', 'user', 'metadata', 'store', 'model'];

const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};

/* One workspace's answers are never used for another's, even for a word-for-word identical
   request: what one customer paid for is theirs, and each customer's data stays their own. */
export function replayKey(workspaceId, body, model, recipe = null, slot = 0) {
  const b = { ...body };
  for (const k of VOLATILE) delete b[k];
  return crypto.createHash('sha256')
    .update(canonical({ v: 1, ws: workspaceId, model, slot, recipe: recipe || null, body: b }))
    .digest('hex');
}

/* Refusals that will be refused again: the model cannot be reached this way, or the request is
   one it will not take. Being busy, rate limited or timing out is not one of them. */
const lasting = (status) => [400, 403, 404, 405, 413, 422].includes(status);

/* Not about the model at all: our own account with the provider needs attention, a key it no
   longer takes or credit that has run out. That is true of every model at once and passes the
   moment it is fixed, so it is never remembered against a model, and a measurement that meets it
   stops rather than marking one model after another as refusing. */
export const accountLevel = (status) => status === 401 || status === 402;

const fromRow = (r) => ({
  json: r.response_json ? JSON.parse(r.response_json) : null,
  ok: r.status === 200,
  status: r.status,
  error: r.error,
  latencyMs: r.latency_ms,
  ttftMs: r.ttft_ms,
  completionTokens: r.completion_tokens,
  reasoningTokens: r.reasoning_tokens,
  provider: r.provider,
  originalCost: r.cost_usd,
});

async function remember(key, row) {
  await db.prepare(
    `INSERT INTO replay_cache (key, model_id, call_id, slot, status, error, response_json, latency_ms, ttft_ms,
            prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, provider, created_at)
     VALUES (@key, @model_id, @call_id, @slot, @status, @error, @response_json, @latency_ms, @ttft_ms,
            @prompt_tokens, @completion_tokens, @reasoning_tokens, @cost_usd, @provider, @created_at)
     ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error,
            response_json = excluded.response_json, latency_ms = excluded.latency_ms, ttft_ms = excluded.ttft_ms,
            prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
            reasoning_tokens = excluded.reasoning_tokens, cost_usd = excluded.cost_usd,
            provider = excluded.provider, created_at = excluded.created_at`).run({ key, ...row, created_at: now() });
}

/**
 * One replay. Answers { json, ok, status, error, latencyMs, ttftMs, cost, reused, savedUsd, key,
 * completionTokens, reasoningTokens, provider, transient }. `cost` is what this call spent now,
 * which is nothing when an earlier answer was reused; `savedUsd` is what reusing it saved.
 */
export async function replayOnce({ body, callId = null, model, recipe = null, slot = 0, workload, reuse = true }) {
  const key = replayKey(workload.workspace_id, body, model, recipe, slot);
  if (reuse) {
    const hit = await db.prepare('SELECT * FROM replay_cache WHERE key = ?').get(key);
    if (hit) {
      const life = hit.status === 200 ? config.REPLAY_REUSE_DAYS * DAY : config.REPLAY_FAILURE_REUSE_HOURS * HOUR;
      if (now() - hit.created_at < life) {
        const r = fromRow(hit);
        return { ...r, cost: 0, reused: true, savedUsd: r.ok ? Number(hit.cost_usd || 0) : 0, key, transient: false, account: false };
      }
    }
  }

  const clean = { ...body };
  delete clean.stream;
  let out;
  try {
    let got;
    try {
      got = await streamCollect(clean, model, { recipe });
    } catch (err) {
      /* A stream that broke for a reason of its own, rather than a refusal, is asked once more
         without streaming. The answer is what matters; its first-word time is then unknown. One
         that ran out of time is not asked again: the model was too slow, and a second paid
         answer would only say so twice. */
      if (err instanceof UpstreamError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
      const plain = await chat(clean, model, { recipe, pace: true });
      got = { json: plain.json, latencyMs: plain.latencyMs, ttftMs: null };
    }
    const usage = got.json?.usage || {};
    out = {
      json: got.json,
      ok: true,
      status: 200,
      error: null,
      latencyMs: got.latencyMs,
      ttftMs: got.ttftMs,
      cost: Number(usage.cost ?? 0),
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      provider: got.json?.provider ?? null,
      promptTokens: usage.prompt_tokens ?? null,
    };
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 0;
    out = {
      json: null, ok: false, status, error: err instanceof UpstreamError ? reasonOf(err) : String(err?.message || err),
      latencyMs: null, ttftMs: null, cost: 0, completionTokens: null, reasoningTokens: null, provider: null,
      promptTokens: null,
    };
  }

  if (out.ok || lasting(out.status)) {
    await remember(key, {
      model_id: model, call_id: callId, slot, status: out.status, error: out.error,
      response_json: out.json ? JSON.stringify(out.json) : null,
      latency_ms: out.latencyMs, ttft_ms: out.ttftMs, prompt_tokens: out.promptTokens,
      completion_tokens: out.completionTokens, reasoning_tokens: out.reasoningTokens,
      cost_usd: out.cost, provider: out.provider,
    });
  }
  await recordCall({
    workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
    requestedModel: workload.reference_model, servedModel: model, statusCode: out.status || 502,
    promptTokens: out.promptTokens ?? 0, completionTokens: out.completionTokens ?? 0,
    costUsd: out.cost, chargedUsd: 0, latencyMs: out.latencyMs,
  });
  const account = !out.ok && accountLevel(out.status);
  return { ...out, reused: false, savedUsd: 0, key, transient: !out.ok && !lasting(out.status) && !account, account };
}
