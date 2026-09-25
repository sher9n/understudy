import config, { canRoute } from './config.js';
import { db, now } from './db/index.js';

/* One account, one key. Every call states that it will only accept a provider that
   retains nothing, and every call reports its own cost so nothing is estimated. */

/* Measurement calls are paced per model by how that model behaves, not by a fixed gap. At most
   MODEL_MAX_IN_FLIGHT of one model's measurement calls are out at once, in the order they asked, started at least
   MODEL_MIN_GAP_MS apart (none by default). A model that turns one away for coming too fast (a 429) is slowed:
   the gap before its next call doubles, from MODEL_BACKOFF_START_MS up to MODEL_BACKOFF_MAX_MS, and halves again
   after every MODEL_BACKOFF_EASE_AFTER calls in a row it takes, down to none.

   It used to be a fixed 3.2 s between any two measurement calls to a model, because a new provider account was
   held to a few calls a minute. That held every measurement to one call a model every 3.2 s, the judge included,
   which every model being tried and every measurement running shares: a measurement of written answers took an
   hour, most of it queued for the judge. Over the week to 25 Sep 2026 providers turned away 8 of 2,144
   measurement calls for coming too fast, all from three models. A turned-away call is still tried again (see
   chat), after the wait the provider asks for. A customer's own calls are never paced: they were, through this
   same function, so every routed call to a popular model could wait up to the full gap behind anybody else's. */
const paces = new Map();
const paceOf = (model) => {
  let p = paces.get(model);
  if (!p) { p = { out: 0, gap: 0, nextAt: 0, easy: 0, queue: [], timer: null }; paces.set(model, p); }
  return p;
};
// hands out what the cap and the gap allow, first come first served, and wakes itself for a gap still to run
function drain(p) {
  while (p.queue.length && p.out < Math.max(1, config.MODEL_MAX_IN_FLIGHT)) {
    const wait = p.nextAt - Date.now();
    if (wait > 0) {
      /* kept alive while a call waits on it: a call waiting its turn is work still to do, so the process must
         not end under it (only set while somebody waits, so nothing is held open otherwise) */
      if (!p.timer) p.timer = setTimeout(() => { p.timer = null; drain(p); }, wait);
      return;
    }
    p.out += 1;
    p.nextAt = Date.now() + Math.max(config.MODEL_MIN_GAP_MS, p.gap);
    p.queue.shift()();
  }
}
/** A turn to send one paced call to `model`, or null for a call that is not paced. Given back with giveBack. */
export async function takeSlot(model, pace) {
  if (!pace) return null;
  const p = paceOf(model);
  await new Promise((resolve) => { p.queue.push(resolve); drain(p); });
  return p;
}
/** Whether a paced call is being sent while its model is already given the longest wait between calls
    (MODEL_BACKOFF_MAX_MS). A provider that turns a call away even then cannot keep up, which a test counts against the
    model (EVAL_KEEP_UP_REFUSALS in src/config.js). Read as the call is sent, never when its refusal comes back: calls
    already out when another's refusal raised the gap were not sent at the longest wait, and counted as if they had been,
    a few calls out at once could reach the whole limit on one refusal that was. */
export const atLongestWait = (p) => !!p && config.MODEL_BACKOFF_MAX_MS > 0 && p.gap >= config.MODEL_BACKOFF_MAX_MS;

/** A paced call is over: `refused` when the provider turned it away for coming too fast. */
export function giveBack(p, { refused = false } = {}) {
  if (!p) return;
  p.out = Math.max(0, p.out - 1);
  if (refused) {
    p.gap = Math.min(config.MODEL_BACKOFF_MAX_MS, Math.max(config.MODEL_BACKOFF_START_MS, p.gap * 2));
    p.easy = 0;
    p.nextAt = Math.max(p.nextAt, Date.now() + p.gap);
  } else if (p.gap > 0) {
    p.easy += 1;
    if (p.easy >= config.MODEL_BACKOFF_EASE_AFTER) {
      p.gap = p.gap / 2 < config.MODEL_BACKOFF_START_MS / 2 ? 0 : Math.round(p.gap / 2);
      p.easy = 0;
    }
  }
  drain(p);
}

/* How many of one call's tries were sent at the longest wait and turned away all the same (see atLongestWait), carried on
   what the call answers or throws, so a test can hold it against the model it asked. */
const counted = (err, refusedAtLongest) => Object.assign(err, { refusedAtLongest });
/** How one model is being paced, for tests and the page. */
export const paceNow = (model) => {
  const p = paces.get(model);
  return p ? { out: p.out, gap: p.gap, waiting: p.queue.length } : { out: 0, gap: 0, waiting: 0 };
};

export class UpstreamError extends Error {
  constructor(status, body) {
    super(`upstream ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** What an upstream refusal said, in the provider's own words, short enough to show. */
export function reasonOf(err) {
  const b = err?.body;
  const raw = b?.error?.metadata?.raw;
  let inner = null;
  if (typeof raw === 'string') {
    try { inner = JSON.parse(raw)?.error?.message ?? null; } catch { inner = raw; }
  }
  const msg = inner || b?.error?.message || err?.message || 'no reason given';
  return String(msg).replace(/\s+/g, ' ').trim().slice(0, 400);
}

function headers() {
  return {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': config.PUBLIC_URL,
    'X-Title': 'Understudy',
  };
}

/** The request the proxy and every replay both send, so a certificate tests the real thing.
 *
 * `recipe` is how a model was measured, when that differs from the customer's own request: a
 * model that thinks before it answers can be measured with its thinking switched off, and if
 * it is switched to, it is routed the same way, because that is the model that cleared. */
/* Whether a call's instruction can be marked for caching: a model that only caches what is marked, a
   system instruction long enough to be cached, and nothing marked already by the customer. */
const MARKED_ONLY = /^anthropic\//;
export function hintApplies(body, model) {
  if (!MARKED_ONLY.test(String(model || ''))) return false;
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (JSON.stringify(msgs).includes('"cache_control"')) return false;
  const system = msgs.filter((m) => m.role === 'system');
  if (!system.length) return false;
  const text = (m) => (typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p) => p?.text || '').join('') : '');
  return system.reduce((a, m) => a + text(m).length, 0) >= config.CACHE_HINT_MIN_CHARS;
}

/* The same call with its instruction marked for the provider to cache: only the last system turn, at
   its end, so everything before that point is read back from the cache on the next call. The words
   sent are exactly the customer's; only the mark is added. */
function withCacheHint(body) {
  const msgs = body.messages.map((m) => ({ ...m }));
  let last = -1;
  msgs.forEach((m, i) => { if (m.role === 'system') last = i; });
  if (last < 0) return body;
  const m = msgs[last];
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }]
    : Array.isArray(m.content) ? m.content.map((p) => ({ ...p })) : [];
  if (!parts.length) return body;
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
  msgs[last] = { ...m, content: parts };
  return { ...body, messages: msgs };
}

export function buildUpstream(body, model, recipe = null, { zdr = null, cacheHint = false, priceCaps = null } = {}) {
  const out = { ...(cacheHint && hintApplies(body, model) ? withCacheHint(body) : body), model };
  delete out.stream_options;
  /* What the customer told us, rather than the model: which workload a call is, and their own
     reference for it. A provider has no use for either, and some refuse metadata they did not expect. */
  if (out.metadata && typeof out.metadata === 'object') {
    const meta = Object.fromEntries(Object.entries(out.metadata).filter(([k]) => !k.startsWith('understudy_') && k !== 'workload'));
    if (Object.keys(meta).length) out.metadata = meta; else delete out.metadata;
  }
  if (recipe?.reasoning) out.reasoning = { ...recipe.reasoning };
  /* served only by the providers it was measured on, where a switch says so; or by them first and by others
     when they cannot, where it says they are preferred (a cascade's cheap model, whose answers are checked) */
  const pinnedTo = Array.isArray(recipe?.providers) && recipe.providers.length ? recipe.providers : null;
  /* A workspace keeps zero data retention unless it chose otherwise on Settings, and nobody's calls
     ever go to a provider that trains on them. Turning retention off lets a workspace reach the models
     that have no provider keeping nothing (o3, the newest Claude models), and says so where it is chosen.
     Turning it off only takes our own requirement away: a customer whose call asks for zero retention
     itself keeps it. It used to be deleted, so that call could reach a provider that keeps what it is
     sent, against what the customer's own code asked for. */
  const keepNothing = zdr ?? config.ZDR_ONLY;
  out.provider = { ...(out.provider || {}), data_collection: 'deny', ...(keepNothing ? { zdr: true } : {}),
    ...(pinnedTo ? (recipe.preferred ? { order: pinnedTo, allow_fallbacks: true } : { only: pinnedTo }) : {}) };
  /* The most any provider may charge on this call, per million tokens and per request: the prices the
     call's hold was worked out at (see callBound). OpenRouter never sends the call to a provider dearer
     than this, which keeps the hold a bound when a provider is added or reprices after we read the list.
     A ceiling the customer set is kept where it is lower. Rounded up a hair, so a provider at exactly the
     bound is not turned away by the arithmetic. */
  const ours = ceilingSent(priceCaps?.[model]);
  if (ours) {
    const theirs = out.provider.max_price && typeof out.provider.max_price === 'object' ? out.provider.max_price : {};
    const lower = (given, mine) => (Number.isFinite(Number(given)) ? Math.min(Number(given), mine) : mine);
    out.provider.max_price = { ...theirs };
    for (const [k, v] of Object.entries(ours)) out.provider.max_price[k] = lower(theirs[k], v);
  }
  return out;
}

/* Our ceiling for one model as it is sent: per million tokens, and per request where there is a fee. */
function ceilingSent(cap) {
  if (!cap) return null;
  const perMillion = (v) => Math.ceil(Number(v) * 1e6 * 1e6) / 1e6;
  return {
    prompt: perMillion(cap.prompt),
    completion: perMillion(cap.completion),
    ...(cap.request > 0 ? { request: Math.ceil(cap.request * 1e6) / 1e6 } : {}),
  };
}

/* OpenRouter turns a request away when no provider is at or under the price ceiling it carries (see
   buildUpstream): a price moved after we last read it. The call is answered as a moment's wait rather
   than as OpenRouter's 404, which from a chat endpoint reads as a wrong address, and the prices of that
   model are read again now instead of at the next hourly reading, so the next call is held at them. */
function priceMoved(status, json, model, body, cap) {
  if (status !== 404 || !/satisfy the max price/i.test(String(json?.error?.message || ''))) return null;
  /* A max_price the customer sent themselves, at or under ours on any price (or on one we do not set), is
     what rules the providers out: sending the call again cannot help, so it is said as that, and the
     prices are not read again on its account. */
  const theirs = body?.provider?.max_price;
  const ours = ceilingSent(cap);
  const theirsBinds = !!theirs && typeof theirs === 'object' && Object.entries(theirs)
    .some(([k, v]) => Number.isFinite(Number(v)) && (!ours || ours[k] === undefined || Number(v) <= ours[k]));
  if (theirsBinds) {
    return new UpstreamError(400, { error: {
      message: 'No provider of this model is within the max_price your request sets (provider.max_price). Raise it or leave it out: every call through Understudy already carries a ceiling at the price it set aside for.',
      type: 'max_price_too_low' } });
  }
  const base = String(model || '').replace(/:[a-z0-9._-]+$/i, '');
  db.prepare('DELETE FROM model_endpoints_all_sync WHERE model_id = ?').run(base).catch(() => {});
  db.prepare(`UPDATE jobs SET run_after = ? WHERE kind = 'model_health' AND status = 'queued' AND run_after > ?`)
    .run(now(), now()).catch(() => {});
  return new UpstreamError(503, { error: {
    message: 'The price of this model moved a moment ago, so no provider was within what this call set aside. Send it again in a moment.',
    type: 'not_ready' } });
}

export async function chat(body, model, { signal, retries = 3, recipe = null, pace = false, maxWaitMs = null, zdr = null, cacheHint = false,
  priceCaps = null } = {}) {
  if (!canRoute()) throw new UpstreamError(503, { error: { message: 'No OPENROUTER_API_KEY is set.' } });
  const payload = buildUpstream(body, model, recipe, { zdr, cacheHint, priceCaps });
  // this call's tries sent at the longest wait and turned away all the same (see atLongestWait)
  let atLongest = 0;
  for (let attempt = 0; ; attempt += 1) {
    const slot = await takeSlot(model, pace);
    const sentAtLongest = atLongestWait(slot);
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
        method: 'POST', headers: headers(), body: JSON.stringify(payload),
        signal: signal ?? AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      giveBack(slot);
      // no answer at all, or none in time: a provider that cannot be reached, said as one
      throw counted(new UpstreamError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 408 : 0,
        { error: { message: err?.name === 'TimeoutError' ? 'The provider did not answer in time.' : 'The provider could not be reached.' } }), atLongest);
    }
    let text;
    try {
      text = await res.text();
    } finally {
      // the turn is over once the answer is in; one turned away for coming too fast slows this model down
      giveBack(slot, { refused: res.status === 429 });
      if (res.status === 429 && sentAtLongest) atLongest += 1;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* upstream sent something unparseable */ }
    if (res.status === 429 && attempt < retries) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      const wait = Number.isFinite(after) && after > 0 ? after : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, maxWaitMs ?? config.UPSTREAM_RETRY_WAIT_MAX_MS)));
      continue;
    }
    if (!res.ok) throw counted(priceMoved(res.status, json, model, body, priceCaps?.[model]) || new UpstreamError(res.status, json ?? { error: { message: text.slice(0, 400) } }), atLongest);
    return { json, latencyMs: Date.now() - started, refusedAtLongest: atLongest };
  }
}

const timedOut = (message) => Object.assign(new Error(message), { name: 'TimeoutError' });

/** Streaming passes straight through; the final chunk carries usage, which is what we bill on.
 *
 *  A stream is timed in two parts. The provider has UPSTREAM_TIMEOUT_MS to start answering, and then
 *  may keep going for as long as it keeps sending, up to UPSTREAM_STREAM_MAX_MS, with no silence longer
 *  than UPSTREAM_IDLE_MS. One limit on the whole answer used to cut every streamed answer that took
 *  longer than two minutes to write, which a long answer or a model that thinks at length routinely
 *  does, and the customer was left holding half an answer. */
export async function chatStream(body, model, { signal, recipe = null, retries = 0, pace = false, zdr = null, cacheHint = false,
  wholeMs = config.UPSTREAM_STREAM_MAX_MS, priceCaps = null } = {}) {
  if (!canRoute()) throw new UpstreamError(503, { error: { message: 'No OPENROUTER_API_KEY is set.' } });
  const payload = buildUpstream(body, model, recipe, { zdr, cacheHint, priceCaps });
  payload.stream = true;
  payload.stream_options = { include_usage: true };
  // this call's tries sent at the longest wait and turned away all the same (see atLongestWait)
  let atLongest = 0;
  for (let attempt = 0; ; attempt += 1) {
    const slot = await takeSlot(model, pace);
    const sentAtLongest = atLongestWait(slot);
    // given back exactly once, however this try ends (letGo is reached from every ending)
    let freed = false;
    const free = (refused = false) => {
      if (freed) return;
      freed = true;
      giveBack(slot, { refused });
      if (refused && sentAtLongest) atLongest += 1;
    };
    const sentAt = Date.now();
    const ctl = new AbortController();
    const stop = (why) => { if (!ctl.signal.aborted) ctl.abort(why); };
    const onOuter = () => stop(signal.reason);
    if (signal) {
      if (signal.aborted) stop(signal.reason);
      else signal.addEventListener('abort', onOuter, { once: true });
    }
    /* Every timer of this try, cleared together however it ends: answered in full, broken off, given
       up by the reader, or refused. A broken stream used to leave its half hour timer and its listener
       on the caller's signal behind. The whole answer is timed from when this try was sent, after any
       wait for a turn, so a queue on our side never uses up a try's time. */
    let whole = null;
    let quiet = null;
    const letGo = () => {
      clearTimeout(whole);
      clearTimeout(quiet);
      if (signal) signal.removeEventListener('abort', onOuter);
      free();
    };
    whole = setTimeout(() => stop(timedOut('The answer took longer than allowed.')), wholeMs);
    whole.unref?.();
    const toStart = setTimeout(() => stop(timedOut('The provider did not start answering in time.')),
      Math.min(config.UPSTREAM_TIMEOUT_MS, wholeMs));
    let res;
    try {
      res = await fetch(`${config.OPENROUTER_BASE}/chat/completions`, {
        method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: ctl.signal,
      });
    } catch (err) {
      letGo();
      const late = err?.name === 'TimeoutError' || ctl.signal.reason?.name === 'TimeoutError';
      throw counted(new UpstreamError(late ? 408 : 0,
        { error: { message: late ? 'The provider did not answer in time.' : 'The provider could not be reached.' } }), atLongest);
    } finally {
      clearTimeout(toStart);
    }
    if (res.status === 429 && attempt < retries) {
      free(true);
      letGo();
      await res.text().catch(() => '');
      const after = Number(res.headers.get('retry-after')) * 1000;
      const wait = Number.isFinite(after) && after > 0 ? after : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, config.UPSTREAM_RETRY_WAIT_MAX_MS)));
      continue;
    }
    if (!res.ok) {
      free(res.status === 429);
      letGo();
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      throw counted(priceMoved(res.status, json, model, body, priceCaps?.[model]) || new UpstreamError(res.status, json ?? { error: { message: text.slice(0, 400) } }), atLongest);
    }
    // started: from here the answer may take as long as it is allowed, so long as it keeps coming
    const hush = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => stop(timedOut('The provider stopped sending.')), config.UPSTREAM_IDLE_MS);
      quiet.unref?.();
    };
    hush();
    let watched = null;
    if (res.body) {
      const reader = res.body.getReader();
      watched = new ReadableStream({
        async pull(c) {
          try {
            const { done, value } = await reader.read();
            if (done) { letGo(); c.close(); return; }
            hush();
            c.enqueue(value);
          } catch (err) {
            letGo();
            c.error(err);
          }
        },
        cancel(reason) {
          letGo();
          stop(reason);
          return reader.cancel(reason).catch(() => {});
        },
      });
    } else {
      letGo();
    }
    const out = new Response(watched, { status: res.status, statusText: res.statusText, headers: res.headers });
    out.sentAt = sentAt;
    out.refusedAtLongest = atLongest;
    return out;
  }
}

/* One replay, streamed, put back together into the shape a non-streamed answer has.
 *
 * Streamed so the moment the first word arrives can be timed: for a workload somebody watches
 * being written, that moment is what they feel, and a total time hides it. Words and tool calls
 * both count as the first thing written; a model's hidden thinking does not, because nobody sees
 * it. Tool calls arrive in pieces and are joined by their index, the way every client joins them. */
export async function streamCollect(body, model, { recipe = null, retries = 3, signal, pace = true, zdr = null } = {}) {
  /* Each try of a replay is held to UPSTREAM_TIMEOUT_MS in all, from when it is sent, as before the live
     stream's longer limit: a measurement's heartbeat is written between calls, and a replay allowed the
     live stream's half hour would read as a measurement nothing is running. */
  const res = await chatStream(body, model, { recipe, retries, signal, pace, zdr, wholeMs: config.UPSTREAM_TIMEOUT_MS });
  /* Timed from when the request actually left, after any spacing, so waiting our turn is
     never counted against a model's speed. */
  const started = res.sentAt ?? Date.now();
  // its tries turned away at the longest wait before it was answered (see giveBack)
  const atLongest = res.refusedAtLongest ?? 0;
  /* A provider that ignores the request to stream answers in one piece. That is still an
     answer: it is read as one, and only the moment of its first word is unknown. */
  if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
    const text = await res.text();
    let whole = null;
    try { whole = JSON.parse(text); } catch { /* not json either */ }
    if (!whole || whole.error) {
      throw counted(new UpstreamError(Number(whole?.error?.code) || 502, whole ?? { error: { message: text.slice(0, 400) } }), atLongest);
    }
    return { json: whole, latencyMs: Date.now() - started, ttftMs: null, refusedAtLongest: atLongest };
  }
  let firstAt = null;
  let content = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  let id = null;
  let served = null;
  let provider = null;
  let failed = null;
  const calls = [];
  const read = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) { failed = j.error; return; }
    id = id || j.id || null;
    served = j.model || served;
    provider = j.provider || provider;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (typeof d.content === 'string' && d.content.length) {
      if (firstAt === null) firstAt = Date.now();
      content += d.content;
    }
    if (typeof d.reasoning === 'string') reasoning += d.reasoning;
    if (Array.isArray(d.tool_calls)) {
      if (firstAt === null && d.tool_calls.length) firstAt = Date.now();
      for (const tc of d.tool_calls) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        const c = calls[i] || (calls[i] = { id: null, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.type) c.type = tc.type;
        // the name comes whole, once or repeated in every piece; the arguments come in pieces
        if (tc.function?.name) c.function.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') c.function.arguments += tc.function.arguments;
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // only lines that have ended are read; the last piece may be half a line
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) read(line);
  }
  if (buf) read(buf);
  if (failed) {
    throw counted(new UpstreamError(Number(failed.code) || 502, { error: failed }), atLongest);
  }
  const toolCalls = calls.filter(Boolean);
  const json = {
    id, model: served || model, provider,
    choices: [{
      index: 0,
      finish_reason: finish,
      message: {
        role: 'assistant',
        content: toolCalls.length && !content ? null : content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning } : {}),
      },
    }],
    usage,
  };
  return { json, latencyMs: Date.now() - started, ttftMs: firstAt === null ? null : firstAt - started, refusedAtLongest: atLongest };
}

/* OpenRouter's own routing products. They are not models: they choose one for you at call
   time, and they are listed at a price of zero, so they sort to the front of every "cheapest"
   query and would quietly become the default. A certificate has to name the exact model it
   measured, and a thing that picks a different model each call can never be that. */
const isRouter = (id) => id.startsWith('openrouter/');

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const epochMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

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
      // what cached prompt tokens cost, where the model says; null where it does not
      price_cache_read: m.pricing?.input_cache_read === undefined || m.pricing?.input_cache_read === null
        ? null : Number(m.pricing.input_cache_read),
      open_weights: /^(mistralai|deepseek|meta-llama|qwen|google\/gemma|nousresearch|microsoft\/phi)/.test(m.id) ? 1 : 0,
      zdr: 0,
      description: typeof m.description === 'string' ? m.description.slice(0, 2000) : null,
      released_at: epochMs(m.created),
      params_json: json(Array.isArray(m.supported_parameters) ? m.supported_parameters : null),
      inputs_json: json(m.architecture?.input_modalities ?? null),
      max_output: m.top_provider?.max_completion_tokens ?? null,
      reasoning_json: json(m.reasoning ?? null),
      expires_at: epochMs(m.expiration_date),
      overrides_json: json(m.pricing?.overrides ?? null),
      // every price it publishes: pictures and sound written, cache writes, per request (see callBound)
      pricing_json: json(m.pricing ?? null),
    }));
}

export async function saveCatalog(models) {
  const at = now();
  const keep = new Set(models.map((m) => m.model_id));
  /* The whole catalogue lands at once. A half-written catalogue would price some models
     and not others, and every cost figure on every screen reads from this table. */
  await db.tx(async (tx) => {
    const stmt = tx.prepare(
      `INSERT INTO models_catalog (model_id, name, context_len, price_in, price_out, open_weights, zdr, synced_at,
              description, released_at, params_json, inputs_json, max_output, reasoning_json, expires_at,
              overrides_json, price_cache_read, pricing_json)
       VALUES (@model_id, @name, @context_len, @price_in, @price_out, @open_weights, @zdr, @synced_at,
              @description, @released_at, @params_json, @inputs_json, @max_output, @reasoning_json, @expires_at,
              @overrides_json, @price_cache_read, @pricing_json)
       ON CONFLICT(model_id) DO UPDATE SET name = excluded.name, context_len = excluded.context_len,
         price_in = excluded.price_in, price_out = excluded.price_out, price_cache_read = excluded.price_cache_read,
         open_weights = excluded.open_weights, synced_at = excluded.synced_at,
         description = excluded.description, released_at = excluded.released_at,
         params_json = excluded.params_json, inputs_json = excluded.inputs_json,
         max_output = excluded.max_output, reasoning_json = excluded.reasoning_json,
         expires_at = excluded.expires_at, overrides_json = excluded.overrides_json, pricing_json = excluded.pricing_json`);
    for (const m of models) {
      await stmt.run({
        description: null, released_at: null, params_json: null, inputs_json: null, max_output: null,
        reasoning_json: null, expires_at: null, overrides_json: null, price_cache_read: null, pricing_json: null, ...m, synced_at: at,
      });
    }
    /* And take out what is no longer offered. Inserting and updating without ever removing
       meant a model that stopped being sold, or that we deliberately stopped stocking, sat
       in the catalogue for ever at its last known price. The routers were exactly that: we
       excluded them from the fetch and they stayed anyway, still winning every cheapest
       query. A catalogue that only grows is not a catalogue. */
    const gone = (await tx.prepare('SELECT model_id FROM models_catalog').all())
      .map((r) => r.model_id).filter((x) => !keep.has(x));
    for (const x of gone) await tx.prepare('DELETE FROM models_catalog WHERE model_id = ?').run(x);
    await tx.prepare(`INSERT INTO fact_sync (source, synced_at, note) VALUES ('catalog', ?, ?)
                ON CONFLICT (source) DO UPDATE SET synced_at = excluded.synced_at, note = excluded.note`)
      .run(at, `${models.length} models`);
  });
  return models.length;
}

/* The providers that keep nothing, with how healthy and how fast each one is.
 *
 * Every routed call and every replay is sent with zero data retention required, so these are
 * the only providers a model can actually be reached through: a model with none of them is
 * refused on every call, which is what happened to aion-3.0 on production. Read with our key,
 * the list also carries each provider's first-token time and writing speed over the last half
 * hour, for everybody's traffic, which is a rough guide and never a measurement of ours. */
/* Every provider of one model, with its prices and limits, for a call that may reach any of them (a
   workspace that allows providers keeping data briefly). Read from OpenRouter the first time a call needs
   it, kept for ALL_ENDPOINTS_HOURS, and read again after a failure ten minutes later. Calls for the same
   model arriving together wait on one reading. Answers the rows, or null when nothing could be read. */
const ALL_ENDPOINTS_HOURS = 6;
const reading = new Map();
export async function allEndpointsOf(modelId) {
  const id = String(modelId || '');
  const seen = await db.prepare('SELECT synced_at, ok FROM model_endpoints_all_sync WHERE model_id = ?').get(id);
  if (seen && now() - Number(seen.synced_at) < ALL_ENDPOINTS_HOURS * 3600000) {
    if (!Number(seen.ok)) return null;
    const rows = await db.prepare('SELECT * FROM model_endpoints_all WHERE model_id = ?').all(id);
    return rows.length ? rows : null;
  }
  if (reading.has(id)) return reading.get(id);
  const p = (async () => {
    try {
      if (!canRoute()) return null;
      const res = await fetch(`${config.OPENROUTER_BASE}/models/${id}/endpoints`, { headers: headers(), signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`endpoints for ${id} answered ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];
      const at = now();
      const rows = list.map((e) => ({
        model_id: id,
        tag: String(e.tag || e.provider_name || e.name || 'default'),
        provider: String(e.provider_name || e.name || e.tag || ''),
        price_in: Number(e.pricing?.prompt || 0),
        price_out: Number(e.pricing?.completion || 0),
        overrides_json: json(e.pricing?.overrides ?? null),
        pricing_json: json(e.pricing ?? null),
        context_len: e.context_length ?? null,
        max_output: e.max_completion_tokens ?? null,
        synced_at: at,
      }));
      await db.tx(async (tx) => {
        await tx.prepare('DELETE FROM model_endpoints_all WHERE model_id = ?').run(id);
        const put = tx.prepare(`INSERT INTO model_endpoints_all (model_id, tag, provider, price_in, price_out, overrides_json, pricing_json,
            context_len, max_output, synced_at) VALUES (@model_id, @tag, @provider, @price_in, @price_out, @overrides_json, @pricing_json,
            @context_len, @max_output, @synced_at) ON CONFLICT (model_id, tag) DO NOTHING`);
        for (const r of rows) await put.run(r);
        await tx.prepare(`INSERT INTO model_endpoints_all_sync (model_id, synced_at, ok) VALUES (?, ?, ?)
            ON CONFLICT (model_id) DO UPDATE SET synced_at = excluded.synced_at, ok = excluded.ok`).run(id, at, rows.length ? 1 : 0);
      });
      return rows.length ? rows : null;
    } catch {
      // looked at again in ten minutes, rather than on every call meanwhile
      await db.prepare(`INSERT INTO model_endpoints_all_sync (model_id, synced_at, ok) VALUES (?, ?, 0)
          ON CONFLICT (model_id) DO UPDATE SET synced_at = excluded.synced_at, ok = 0`)
        .run(id, now() - (ALL_ENDPOINTS_HOURS * 3600000 - 600000)).catch(() => {});
      return null;
    } finally {
      reading.delete(id);
    }
  })();
  reading.set(id, p);
  return p;
}

export async function fetchZdrEndpoints() {
  const res = await fetch(`${config.OPENROUTER_BASE}/endpoints/zdr`, {
    headers: canRoute() ? { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` } : {},
  });
  if (!res.ok) throw new UpstreamError(res.status, { error: { message: 'zero-retention endpoint list unavailable' } });
  const { data } = await res.json();
  const byKey = new Map();
  for (const e of data || []) {
    if (typeof e?.model_id !== 'string') continue;
    const tag = String(e.tag || e.provider_name || 'default');
    const row = {
      model_id: e.model_id,
      tag,
      provider: String(e.provider_name || tag),
      price_in: Number(e.pricing?.prompt || 0),
      price_out: Number(e.pricing?.completion || 0),
      overrides_json: json(e.pricing?.overrides ?? null),
      pricing_json: json(e.pricing ?? null),
      context_len: e.context_length ?? null,
      max_output: e.max_completion_tokens ?? null,
      max_prompt: e.max_prompt_tokens ?? null,
      params_json: json(Array.isArray(e.supported_parameters) ? e.supported_parameters : null),
      status: Number.isFinite(Number(e.status)) ? Number(e.status) : null,
      uptime_5m: e.uptime_last_5m ?? null,
      uptime_30m: e.uptime_last_30m ?? null,
      uptime_1d: e.uptime_last_1d ?? null,
      ttft_p50: e.latency_last_30m?.p50 ?? null,
      ttft_p90: e.latency_last_30m?.p90 ?? null,
      tps_p50: e.throughput_last_30m?.p50 ?? null,
      tps_p90: e.throughput_last_30m?.p90 ?? null,
    };
    /* The list names a few endpoints twice. Keep the healthier reading of the two, so a
       duplicate can never make a working provider look broken. */
    const k = `${row.model_id}|${tag}`;
    const had = byKey.get(k);
    if (!had || (row.uptime_1d ?? -1) > (had.uptime_1d ?? -1)) byKey.set(k, row);
  }
  return [...byKey.values()];
}

/** Replace what we know about zero-retention providers with what is true now. */
export async function saveZdrEndpoints(rows) {
  const at = now();
  await db.tx(async (tx) => {
    await tx.prepare('DELETE FROM model_endpoints').run();
    const stmt = tx.prepare(
      `INSERT INTO model_endpoints (model_id, tag, provider, price_in, price_out, overrides_json, context_len,
              max_output, max_prompt, params_json, status, uptime_5m, uptime_30m, uptime_1d,
              ttft_p50, ttft_p90, tps_p50, tps_p90, speed_at, synced_at, pricing_json)
       VALUES (@model_id, @tag, @provider, @price_in, @price_out, @overrides_json, @context_len,
              @max_output, @max_prompt, @params_json, @status, @uptime_5m, @uptime_30m, @uptime_1d,
              @ttft_p50, @ttft_p90, @tps_p50, @tps_p90, @speed_at, @synced_at, @pricing_json)`);
    for (const r of rows) {
      await stmt.run({ ...r, speed_at: r.ttft_p50 != null || r.tps_p50 != null ? at : null, synced_at: at });
    }
    // the count the catalogue has always had a column for, and never filled in
    await tx.prepare(`UPDATE models_catalog c SET zdr = COALESCE((SELECT COUNT(*) FROM model_endpoints e
                WHERE e.model_id = c.model_id), 0)`).run();
    await tx.prepare(`INSERT INTO fact_sync (source, synced_at, note) VALUES ('zdr', ?, ?)
                ON CONFLICT (source) DO UPDATE SET synced_at = excluded.synced_at, note = excluded.note`)
      .run(at, `${rows.length} providers`);
  });
  return rows.length;
}

/** What one call's tokens cost on a given model, from the synced catalogue only. */
export async function priceCall(modelId, promptTokens, completionTokens) {
  // a variant after a colon (":nitro", ":online") is priced as the model it varies
  const m = await db.prepare('SELECT price_in, price_out FROM models_catalog WHERE model_id = ?')
    .get(String(modelId || '').replace(/:[a-z0-9._-]+$/i, ''));
  if (!m) return null;
  return m.price_in * promptTokens + m.price_out * completionTokens;
}
