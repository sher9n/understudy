/* What a call asked, for a judge to weigh answers against: every message, with who said it, cut to a
   length a judge reads well. One reading of it, shared by a measurement (src/eval/run.js) and the control
   group (src/learn/control.js), so a live answer is judged against exactly what a measurement's would be. */
export function askOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.map((x) => x?.text || '').join(' ') : '');
    return `${m.role}: ${c}`;
  }).join('\n').slice(0, 4000);
}
