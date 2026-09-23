import { chat, UpstreamError } from '../openrouter.js';
import { jevUsable } from '../jev.js';
import { checkAnswer, liveCheckUsable } from './check.js';
import { featuresOf, predict } from './router.js';

/* Serving one call with a strategy.
 *
 * One model is served as ever. A router picks which of its two models answers, from what can be
 * seen of the call. A cascade asks its cheap model first, checks the answer, and sends the call on
 * to the stronger model when the check is not sure enough: the customer then gets the stronger
 * model's answer, and pays for both calls and the check, which is why a cascade is only offered
 * when a measurement found it cheaper overall. Two things always go to the stronger model
 * straight away, because the check cannot vouch for the cheap answer: a cheap model that fails
 * outright, and a check that is not available. */

const usd = (json) => Number(json?.usage?.cost ?? 0);
/* The answer as the customer receives it, saying what the whole call cost: a cascade that sent a
   call on paid for the cheap answer and the check as well, and the usage an answer carries is
   what a customer reconciles their bill against. */
const costing = (json, cost) => (json && typeof json === 'object'
  ? { ...json, usage: { ...(json.usage || {}), cost: Math.round(cost * 1e10) / 1e10 } } : json);

/* `call` is how long a live call may wait on a busy provider (see liveOpts in src/proxy.js): every
   model a strategy asks on a live call is held to it, so a cascade or a router is compared with the
   yardstick on the same terms as a single model. Without it, as for a background answer nobody waits
   on, a model is asked the way a measurement asks it. A live call's cascade and router calls used to
   be asked that way too: three retries with waits of up to thirty seconds each. */
export async function serveWith(spec, given, { shape, scope = null, check = checkAnswer, zdr = null, call = null } = {}) {
  const started = Date.now();
  const policy = call || {};
  /* Every answer here is worked out whole, whatever the customer asked for: a cascade has to read
     an answer before anybody sees it, and a customer who asked for a stream is sent the finished
     answer as one afterwards. Passed on, the request to stream came back as a stream that was
     read as an empty answer. */
  const body = { ...given };
  delete body.stream;
  delete body.stream_options;
  if (spec.kind === 'router') {
    const p = predict(spec, featuresOf(body));
    const use = p >= spec.threshold ? spec.cheap : spec.strong;
    const r = await chat(body, use.model, { ...policy, recipe: use.recipe ?? null, zdr });
    return { json: r.json, served: use.model, recipe: use.recipe ?? null, cost: usd(r.json),
      latencyMs: Date.now() - started, escalated: use === spec.strong, check: { by: 'router', p: Math.round(p * 1000) / 1000 } };
  }
  if (spec.kind === 'cascade') {
    const toFallback = async (why, spent = 0, readings = {}) => {
      let r;
      try {
        r = await chat(body, spec.fallback.model, { ...policy, recipe: spec.fallback.recipe ?? null, zdr });
      } catch (err) {
        // what was already spent on this call is kept on the failure, so it is recorded
        err.spent = (err.spent || 0) + spent;
        throw err;
      }
      const cost = spent + usd(r.json);
      return { json: costing(r.json, cost), served: spec.fallback.model, recipe: spec.fallback.recipe ?? null, cost,
        latencyMs: Date.now() - started, escalated: true, check: { ...readings, by: why } };
    };
    if (!jevUsable() || !liveCheckUsable()) return toFallback('unavailable');
    let first;
    try {
      // once, with no retries: a cheap model that is busy hands the call on at once, not after waiting
      first = await chat(body, spec.first.model, { ...policy, recipe: spec.first.recipe ?? null, retries: 0, zdr });
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 401 || err.status === 402)) throw err;
      return toFallback('first failed', 0, { status: err?.status ?? 0 });
    }
    let c;
    try {
      c = await check(body, first.json, shape, { threshold: spec.threshold, scope, live: true });
    } catch (err) {
      return toFallback('check failed', usd(first.json), { reason: String(err?.message || err).slice(0, 120) });
    }
    const readings = { by: c.by, p: c.p === null || c.p === undefined ? null : Math.round(c.p * 1000) / 1000, reason: c.reason ?? null, ms: c.ms ?? 0 };
    if (c.pass) {
      const cost = usd(first.json) + (c.cost || 0);
      return { json: costing(first.json, cost), served: spec.first.model, recipe: spec.first.recipe ?? null, cost,
        latencyMs: Date.now() - started, escalated: false, check: readings };
    }
    return toFallback(c.by === 'shape' ? 'shape' : 'unsure', usd(first.json) + (c.cost || 0), readings);
  }
  const r = await chat(body, spec.model, { ...policy, recipe: spec.recipe ?? null, zdr });
  return { json: r.json, served: spec.model, recipe: spec.recipe ?? null, cost: usd(r.json), latencyMs: Date.now() - started,
    escalated: false, check: null };
}

/* An answer that was worked out whole, sent the way a streamed answer is: the customer's client
   asked for a stream and gets one, a few pieces and then the end, with what it cost. */
export function writeAsStream(res, json) {
  const base = { id: json?.id || 'gen', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: json?.model };
  const msg = json?.choices?.[0]?.message || {};
  const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`);
  send({ role: 'assistant', content: '' });
  const text = typeof msg.content === 'string' ? msg.content : '';
  for (let i = 0; i < text.length; i += 160) send({ content: text.slice(i, i + 160) });
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    send({ tool_calls: msg.tool_calls.map((c, index) => ({ index, id: c.id, type: 'function', function: c.function })) });
  }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: json?.choices?.[0]?.finish_reason || 'stop' }], usage: json?.usage })}\n\n`);
  res.write('data: [DONE]\n\n');
}
