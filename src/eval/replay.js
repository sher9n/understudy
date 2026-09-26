import crypto from 'node:crypto';
import config from '../config.js';
import { db, now } from '../db/index.js';
import { chat, streamCollect, UpstreamError, reasonOf, priceCall } from '../openrouter.js';
import { recordCall } from '../traffic.js';
import { zdrFor } from '../workspace.js';

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

const lengthOf = (v) => (typeof v === 'string' ? v.length : v === null || v === undefined ? 0 : JSON.stringify(v).length);
// what a request said, and what an answer said, in characters
const askedChars = (body) => (Array.isArray(body?.messages)
  ? body.messages.reduce((a, m) => a + lengthOf(m?.content), 0) : lengthOf(body));
const answeredChars = (json) => {
  const m = json?.choices?.[0]?.message;
  if (!m) return 0;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return m.tool_calls.reduce((a, c) => a + lengthOf(c?.function?.arguments), 0);
  return lengthOf(m.content);
};

/**
 * What one model call a measurement made cost. The provider's own figure when the answer carries
 * one. Otherwise its tokens at the model's catalogue price: the answer's own count of them, or,
 * with no usage on it at all, its text at three characters a token. A model the catalogue does not
 * list is priced at what its calls have cost in this workspace, and failing that at a typical
 * catalogue price. Never nothing for a call that was made: read as `usage.cost ?? 0`, an answer that
 * came back without a cost on it was recorded, and charged to the customer's optimizing, as free.
 */
export async function costOfCall({ json, model, request = null, workspaceId = null }) {
  const usage = json?.usage || null;
  const said = Number(usage?.cost);
  if (usage && usage.cost !== null && usage.cost !== undefined && Number.isFinite(said)) return Math.max(0, said);
  const tokensIn = Number(usage?.prompt_tokens) > 0 ? Number(usage.prompt_tokens) : Math.ceil(askedChars(request) / 3);
  const tokensOut = Number(usage?.completion_tokens) > 0 ? Number(usage.completion_tokens) : Math.ceil(answeredChars(json) / 3);
  const listed = await priceCall(model, tokensIn, tokensOut);
  if (listed !== null && Number.isFinite(listed)) return Math.max(0, listed);
  if (workspaceId) {
    const had = await db.prepare(
      `SELECT SUM(cost_usd) AS cost, SUM(prompt_tokens + completion_tokens) AS tokens FROM calls
        WHERE workspace_id = ? AND served_model = ? AND cost_usd > 0 AND source IN ('routed', 'trace') AND created_at >= ?`)
      .get(workspaceId, model, now() - 30 * DAY);
    if (Number(had?.tokens) > 0) return (Number(had.cost) / Number(had.tokens)) * (tokensIn + tokensOut);
  }
  const typical = await db.prepare(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_in) AS pin, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_out) AS pout
       FROM models_catalog WHERE price_in > 0 OR price_out > 0`).get();
  return Math.max(0, Number(typical?.pin || 0) * tokensIn + Number(typical?.pout || 0) * tokensOut);
}

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
   one it will not take. Being busy, rate limited or timing out is not one of them. A test counts
   only these against a model's answers, which is how a page reads them back (runAnswersOf in
   src/workloadPage.js). */
export const LASTING_STATUSES = [400, 403, 404, 405, 413, 422];
const lasting = (status) => LASTING_STATUSES.includes(status);

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
            prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, provider, created_at, recipe_json)
     VALUES (@key, @model_id, @call_id, @slot, @status, @error, @response_json, @latency_ms, @ttft_ms,
            @prompt_tokens, @completion_tokens, @reasoning_tokens, @cost_usd, @provider, @created_at, @recipe_json)
     ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error,
            response_json = excluded.response_json, latency_ms = excluded.latency_ms, ttft_ms = excluded.ttft_ms,
            prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
            reasoning_tokens = excluded.reasoning_tokens, cost_usd = excluded.cost_usd,
            provider = excluded.provider, created_at = excluded.created_at, recipe_json = excluded.recipe_json`)
    .run({ recipe_json: null, key, ...row, created_at: now() });
}

/**
 * One replay. Answers { json, ok, status, error, latencyMs, ttftMs, cost, reused, savedUsd, key,
 * completionTokens, reasoningTokens, provider, transient }. `cost` is what this call spent now,
 * which is nothing when an earlier answer was reused; `savedUsd` is what reusing it saved.
 */
export async function replayOnce({ body, callId = null, model, recipe = null, slot = 0, workload, reuse = true, reuseSince = 0 }) {
  const key = replayKey(workload.workspace_id, body, model, recipe, slot);
  if (reuse) {
    const hit = await db.prepare('SELECT * FROM replay_cache WHERE key = ?').get(key);
    // an answer from before reuseSince is not reused: a re-check wants what the model answers now
    if (hit && Number(hit.created_at) >= reuseSince) {
      const life = hit.status === 200 ? config.REPLAY_REUSE_DAYS * DAY : config.REPLAY_FAILURE_REUSE_HOURS * HOUR;
      if (now() - hit.created_at < life) {
        const r = fromRow(hit);
        return { ...r, cost: 0, reused: true, savedUsd: r.ok ? Number(hit.cost_usd || 0) : 0, key, transient: false, account: false,
          refusedAtLongest: 0 };
      }
    }
  }

  // replayed the way this workspace's own calls are sent: to providers that keep nothing, unless it chose otherwise
  const zdr = await zdrFor(workload.workspace_id);
  const clean = { ...body };
  delete clean.stream;
  let out;
  /* How many of its tries its provider turned away for coming too fast while the model was already given the longest
     wait between them (see giveBack in src/openrouter.js): a test holds that against the model, whether or not a later
     try was answered (EVAL_KEEP_UP_REFUSALS). */
  let refusedAtLongest = 0;
  try {
    let got;
    try {
      got = await streamCollect(clean, model, { recipe, zdr });
    } catch (err) {
      /* A stream that broke for a reason of its own, rather than a refusal, is asked once more
         without streaming. The answer is what matters; its first-word time is then unknown. One
         that ran out of time is not asked again: the model was too slow, and a second paid
         answer would only say so twice. */
      if (err instanceof UpstreamError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
      const plain = await chat(clean, model, { recipe, pace: true, zdr });
      got = { json: plain.json, latencyMs: plain.latencyMs, ttftMs: null, refusedAtLongest: plain.refusedAtLongest };
    }
    refusedAtLongest = Number(got.refusedAtLongest) || 0;
    const usage = got.json?.usage || {};
    out = {
      json: got.json,
      ok: true,
      status: 200,
      error: null,
      latencyMs: got.latencyMs,
      ttftMs: got.ttftMs,
      // worked out below, outside the provider's try: a slip in reading a price is not a refusal
      cost: 0,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      provider: got.json?.provider ?? null,
      promptTokens: usage.prompt_tokens ?? null,
    };
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 0;
    refusedAtLongest = Number(err?.refusedAtLongest) || 0;
    out = {
      json: null, ok: false, status, error: err instanceof UpstreamError ? reasonOf(err) : String(err?.message || err),
      latencyMs: null, ttftMs: null, cost: 0, completionTokens: null, reasoningTokens: null, provider: null,
      promptTokens: null,
    };
  }
  // an answer came back, so it was paid for, whether or not it says what it cost
  if (out.ok) out.cost = await costOfCall({ json: out.json, model, request: clean, workspaceId: workload.workspace_id });

  if (out.ok || lasting(out.status)) {
    await remember(key, {
      model_id: model, call_id: callId, slot, status: out.status, error: out.error,
      response_json: out.json ? JSON.stringify(out.json) : null,
      latency_ms: out.latencyMs, ttft_ms: out.ttftMs, prompt_tokens: out.promptTokens,
      completion_tokens: out.completionTokens, reasoning_tokens: out.reasoningTokens,
      cost_usd: out.cost, provider: out.provider,
      // how it was asked, when that was not the customer's own way
      recipe_json: recipe ? JSON.stringify(recipe) : null,
    });
  }
  await recordCall({
    workspaceId: workload.workspace_id, workloadId: workload.id, source: 'replay',
    requestedModel: workload.reference_model, servedModel: model, statusCode: out.status || 502,
    promptTokens: out.promptTokens ?? 0, completionTokens: out.completionTokens ?? 0,
    costUsd: out.cost, chargedUsd: 0, latencyMs: out.latencyMs,
  });
  const account = !out.ok && accountLevel(out.status);
  return { ...out, reused: false, savedUsd: 0, key, transient: !out.ok && !lasting(out.status) && !account, account, refusedAtLongest };
}
