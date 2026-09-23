import crypto from 'node:crypto';

/* What a call is, read from the call itself. Pure: no database, no model, no clock.
 *
 * Understudy sits between an app and its models, so it sees every step of a conversation or an
 * agent's loop go past, one call at a time. Each call carries the whole conversation so far, so
 * a follow-up call contains the previous call's answer word for word. That is what links the
 * steps of one task together, and what lets the next step say whether the last answer worked:
 * a tool that errored on the arguments it was given, or a person who says the answer was wrong.
 *
 * Nothing here needs the customer to do anything. It is read from traffic that already flows. */

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/* The parts of a request that change nothing about what is being asked. The model is among
   them: the same request sent again to another model is still the same request sent again. */
const VOLATILE = ['stream', 'stream_options', 'user', 'metadata', 'store', 'model', 'n', 'seed'];

const canonical = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};

/** The words of a message, whether it came as a string or as parts. Pictures and files count as markers. */
export function textOf(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((p) => {
    if (typeof p === 'string') return p;
    if (p?.type === 'text' || typeof p?.text === 'string') return p.text || '';
    return `[${String(p?.type || 'part').replace(/_url$/, '')}]`;
  }).join(' ');
}

/* Tool arguments are JSON written by a model, and a client that echoes them back may space them
   differently; read as values, they compare. */
const argsOf = (a) => {
  if (a === null || a === undefined) return '';
  if (typeof a !== 'string') return canonical(a);
  try { return canonical(JSON.parse(a)); } catch { return a.trim(); }
};

/* One message as it matters for following a conversation. Ids a provider makes up (a tool
   call's id) are left out: a client may be given different ones on different providers. */
export function canonicalMessage(m) {
  const role = String(m?.role || '');
  const out = { role, content: textOf(m?.content).trim() };
  if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((t) => ({ name: t?.function?.name || t?.name || '', arguments: argsOf(t?.function?.arguments ?? t?.arguments) }));
  }
  return out;
}

/** The request as a fingerprint: the same request sent again has the same one. */
export function requestHash(body) {
  const b = { ...(body || {}) };
  for (const k of VOLATILE) delete b[k];
  if (Array.isArray(b.messages)) b.messages = b.messages.map(canonicalMessage);
  return sha(canonical(b));
}

/** The conversation up to this call's last answer from the assistant: the state it continues. */
export function beforeHash(messages) {
  if (!Array.isArray(messages)) return null;
  let last = -1;
  messages.forEach((m, i) => { if (m?.role === 'assistant') last = i; });
  if (last < 0) return null;
  return sha(canonical(messages.slice(0, last + 1).map(canonicalMessage)));
}

/** The conversation including this call's own answer: what a follow-up call will start from. */
export function afterHash(messages, answer) {
  if (!Array.isArray(messages) || !answer) return null;
  return sha(canonical([...messages, answer].map(canonicalMessage)));
}

/** The assistant's message in an answer, from a whole response or a streamed one put back together. */
export function answerOf(response) {
  const m = response?.choices?.[0]?.message;
  if (!m) return null;
  return { role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls };
}

/* What came after the previous call's answer, in the call that continues it: the results of the
   tools it asked for, and anything the person said next. */
export function afterLastAnswer(messages) {
  if (!Array.isArray(messages)) return { tools: [], user: null };
  let last = -1;
  messages.forEach((m, i) => { if (m?.role === 'assistant') last = i; });
  if (last < 0) return { tools: [], user: null };
  const rest = messages.slice(last + 1);
  const tools = rest.filter((m) => m?.role === 'tool' || m?.role === 'function').map((m) => textOf(m.content));
  const users = rest.filter((m) => m?.role === 'user').map((m) => textOf(m.content)).filter((t) => t.trim());
  return { tools, user: users.length ? users[users.length - 1] : null, assistant: textOf(messages[last]?.content) };
}

/* Whether a tool's result says it failed. Tools report failure in a handful of recognisable ways:
   an error field, a success flag set to false, a failing status, or text that opens with an error.
   Read conservatively, so that a result that only mentions the word "error" in passing (a log
   search, a document about errors) is not counted as one. */
export function toolFailed(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t);
      const o = Array.isArray(j) ? j[0] : j;
      if (o && typeof o === 'object') {
        if (o.error !== undefined && o.error !== null && o.error !== false && o.error !== '') return true;
        if (o.success === false || o.ok === false) return true;
        if (typeof o.status === 'string' && /^(error|failed|failure)$/i.test(o.status)) return true;
        if (typeof o.status === 'number' && o.status >= 400) return true;
        return false;
      }
    } catch { /* not JSON after all */ }
  }
  return /^(error|exception|traceback|failed|failure|fatal)\b|^\w*error:/i.test(t)
    || /^(\d{3})\b/.test(t) && Number(t.slice(0, 3)) >= 400;
}

/* A refusal, said the ways models say it. Only for written answers, and only at the start, where a
   refusal is: an answer that quotes someone saying "I can't" further down is not one.

   It has to decline something ("I can't help with that", "I'm sorry, but I cannot provide", "As an AI I
   am not able to"), and the answer has to be mostly that. The old rule took any answer opening with an
   apology or "I can't" for a refusal, so "I'm sorry to hear that, here is how to reset it" and "I can't
   wait to help with this" were counted as failed calls, against whichever model wrote them. And an
   answer that declines one part and then helps at length ("I can't give medical advice, but here is
   what the guidance says: ...") did the job it was asked, and is not a failure either. */
const DECLINE = new RegExp([
  // an apology or "unfortunately" may come first
  String.raw`^(?:(?:i'?m|i am)\s+(?:so\s+|really\s+|very\s+)?sorry,?\s+(?:but\s+)?|sorry,?\s+(?:but\s+)?|unfortunately,?\s+)?`,
  '(?:',
  // "I can't", "I cannot", "I won't", "I am unable", "I'm not able", "I must decline", "I don't feel comfortable" ...
  String.raw`i(?:\s+(?:can(?:no|')t|cannot|won'?t|will\s+not|am\s+(?:not\s+able|unable)|must\s+decline|do\s+not\s+feel\s+comfortable|don'?t\s+feel\s+comfortable)|'m\s+(?:not\s+able|unable))`,
  // ... then what it declines to do
  String.raw`\s+(?:to\s+)?(?:help|assist|provide|do|comply|fulfil|fulfill|complete|answer|create|generate|write|share|support|engage|continue|process|give|offer|produce|make)`,
  // or the old "as an AI I cannot"
  String.raw`|as\s+an\s+ai(?:\s+(?:language\s+)?model)?,?\s+i(?:\s+(?:can(?:no|')t|cannot|don'?t|do\s+not|am\s+not)|'m\s+not)`,
  ')',
].join(''), 'i');
export function refused(text) {
  // curly apostrophes, as most models write them, read as straight ones
  const t = String(text ?? '').trim().replace(/[\u2018\u2019]/g, "'");
  if (!DECLINE.test(t.slice(0, 240))) return false;
  // what follows the first sentence: a long answer after a decline is help, not a refusal
  const first = t.search(/[.!?](\s|$)/);
  const rest = first >= 0 ? t.slice(first + 1).trim() : '';
  return rest.length < 300;
}

/* Problems visible in an answer the moment it arrives, before anything else happens: it stopped
   at the length limit, it is not the JSON the request asked for, a tool call's arguments are not
   JSON, or it refused. Each is a failure, whatever happens next. */
export function problemsIn(body, response) {
  const out = [];
  const ch = response?.choices?.[0];
  if (!ch) return out;
  if (ch.finish_reason === 'length') out.push('cut_off');
  const msg = ch.message || {};
  const text = textOf(msg.content);
  const rf = body?.response_format?.type;
  if ((rf === 'json_object' || rf === 'json_schema') && !(Array.isArray(msg.tool_calls) && msg.tool_calls.length)) {
    const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { JSON.parse(s); } catch { out.push('broken'); }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const t of msg.tool_calls) {
      const a = t?.function?.arguments;
      if (typeof a === 'string' && a.trim()) {
        try { JSON.parse(a); } catch { out.push('broken'); break; }
      }
    }
  }
  if (!rf && !(Array.isArray(msg.tool_calls) && msg.tool_calls.length) && refused(text)) out.push('refused');
  return [...new Set(out)];
}

/** The reference a customer gave a call, to report how it went later. */
export function refOf(headers, body) {
  const h = headers?.['x-understudy-ref'];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  const fromBody = body?.metadata && typeof body.metadata === 'object' ? (body.metadata.understudy_ref ?? body.metadata.ref) : null;
  const ref = fromHeader ?? fromBody ?? null;
  return ref === null || ref === undefined || ref === '' ? null : String(ref).slice(0, 200);
}
