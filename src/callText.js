/* What a call asked and what came back, as text a person can read: used by the calls a workload lists (src/api.js)
   and by one model's requests in a test (runAnswersOf in src/workloadPage.js). Content is cleared after the
   workspace's retention window, so each says nothing rather than something empty once it is. */

/** The text of a message, whether it came as a string or as parts. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === 'string' ? p.text
      : (p?.type ? `[${String(p.type).replace('_', ' ')}]` : ''))).join('\n');
  }
  return '';
}

/** Every message of a request, in the order it was sent, from its parsed body. */
export function messagesText(req) {
  const msgs = Array.isArray(req?.messages) ? req.messages : [];
  if (!msgs.length) return null;
  return msgs.map((m) => {
    const body = contentText(m.content)
      || (m.tool_calls ? JSON.stringify(m.tool_calls, null, 2) : '');
    return `${String(m.role || 'message').toUpperCase()}\n${body}`;
  }).join('\n\n');
}

/** The last thing a person asked in a request: the part that differs from one request to the next. */
export function lastAsked(req) {
  const msgs = Array.isArray(req?.messages) ? req.messages : [];
  const last = [...msgs].reverse().find((m) => m?.role === 'user') || msgs[msgs.length - 1];
  const text = last ? contentText(last.content) : '';
  return text.trim() ? text : null;
}

/** The whole of what was asked: every message in the request, in the order it was sent. */
export function askedFull(c) {
  if (c.content_purged_at) return null;
  try { return messagesText(JSON.parse(c.request_json || 'null')); } catch { return null; }
}

/** What an answer said, from the response it came in: its words, or the tools it called. */
export function responseText(res) {
  if (res?.error?.message) return String(res.error.message);
  const msg = res?.choices?.[0]?.message;
  if (!msg) return null;
  const text = contentText(msg.content);
  if (text.trim()) return text;
  const tools = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (!tools.length) return null;
  return tools.map((t) => `CALLED ${t?.function?.name || 'a tool'}\n${t?.function?.arguments ?? ''}`).join('\n\n');
}

/** The whole of what came back. */
export function answeredFull(c) {
  if (c.content_purged_at) return null;
  try { return responseText(JSON.parse(c.response_json || 'null')); } catch { return null; }
}
