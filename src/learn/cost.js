import { priceCall } from '../openrouter.js';
import { textOf } from './threads.js';

/* What one model's answer cost: what the provider said, or, where it said nothing, as near as can be
 * worked out. Never nothing.
 *
 * A provider's answer carries its cost in usage.cost. Read as `?? 0`, an answer without one cost nothing:
 * a call a cascade or a router served was charged $0, the answer the customer got said it cost $0 (so
 * nothing downstream could tell it had been guessed), and background work charged as optimizing was
 * free. A cost the provider did not state is unknown, not zero. It is estimated here from the tokens the
 * answer says it used, at the model's catalogue price, and where the answer says nothing about its tokens
 * either, from the length of what was sent and what came back, at three characters a token. An estimate
 * always says it is one, so it is never written into an answer as the provider's own figure. */

const CHARS_PER_TOKEN = 3;
const tokensIn = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
const known = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

// what a request puts in front of a model: its messages, and the tools it offers
const sentText = (body) => {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const words = msgs.map((m) => textOf(m?.content)).join('\n');
  return words + (Array.isArray(body?.tools) && body.tools.length ? JSON.stringify(body.tools) : '');
};

// what came back: the words, the tool calls, and any thinking it shows
const answerText = (json) => {
  const msg = json?.choices?.[0]?.message || {};
  const calls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c) => `${c?.function?.name || ''}(${c?.function?.arguments || ''})`).join('\n') : '';
  return textOf(msg.content) + calls + (typeof msg.reasoning === 'string' ? msg.reasoning : '');
};

/**
 * { cost, estimated } for one model's answer `json` to `body`: the cost the provider stated, or an
 * estimate (never below zero, and zero only for a model with no catalogue price) marked as one.
 */
export async function costOf(json, model, body = null) {
  const said = json?.usage?.cost;
  if (known(said)) return { cost: Number(said), estimated: false };
  const u = json?.usage || {};
  const tokensSent = known(u.prompt_tokens) ? Number(u.prompt_tokens) : tokensIn(sentText(body));
  const tokensBack = known(u.completion_tokens) ? Number(u.completion_tokens) : tokensIn(answerText(json));
  const price = model ? await priceCall(model, tokensSent, tokensBack) : null;
  return { cost: Math.max(0, Number(price) || 0), estimated: true };
}
