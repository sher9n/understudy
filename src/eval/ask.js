/* What a call asked, for a judge to weigh answers against: every message, with who said it, cut to a
   length a judge reads well. One reading of it, shared by a measurement (src/eval/run.js) and the control
   group (src/learn/control.js), so a live answer is judged against exactly what a measurement's would be.

   Cut from the middle, never from the end. The instructions come first and the request being answered
   last, so a cut from the end took the question itself away whenever the instructions were long: a judge
   then weighed two answers without knowing what either was answering (26 Sep 2026). Now the newest turn,
   from the last thing the user said to the end, is kept whole wherever it fits; the instructions keep
   their start and their end; the turns between are kept newest first, whole; and whatever is left out
   says so. A picture, a sound or a file is named where it was, and a tool the model called is shown with
   what it was called with, rather than dropped as an empty message. */

export const ASK_MAX = 4000;

/** Longer than `n`, cut from the middle: its start and its end kept, and how much was left out said between them. */
export function cutMiddle(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  const mark = ` [... ${t.length} characters, the middle left out ...] `;
  const room = Math.max(0, n - mark.length);
  const head = Math.ceil(room * 0.4);
  return `${t.slice(0, head)}${mark}${t.slice(t.length - (room - head))}`;
}

const partText = (x) => {
  if (typeof x === 'string') return x;
  const type = x?.type;
  if (type === 'text' || type === 'input_text') return String(x.text ?? '');
  if (type === 'image_url' || type === 'input_image' || type === 'image') return '[a picture]';
  if (type === 'input_audio' || type === 'audio') return '[a sound recording]';
  if (type === 'file' || type === 'input_file') return '[a file]';
  return typeof x?.text === 'string' ? x.text : '';
};
const contentText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(partText).filter(Boolean).join(' ') : '');

/** One message as a judge reads it: who said it, what they said, and any tool it called with what. */
export function messageLine(m) {
  let t = contentText(m?.content);
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    const calls = m.tool_calls.map((c) => `[called ${c?.function?.name || 'a tool'} with ${cutMiddle(c?.function?.arguments ?? '', 300)}]`).join(' ');
    t = t ? `${t} ${calls}` : calls;
  }
  return `${m?.role || 'user'}: ${t}`;
}

export function askOf(body, max = ASK_MAX) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const full = msgs.map(messageLine).join('\n');
  if (full.length <= max) return full;
  // the newest turn: from the last thing the user said to the end (a tool's result after it included)
  let at = msgs.length - 1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === 'user') { at = i; break; }
  }
  // the instructions: the system and developer messages it starts with
  let i = 0;
  while (i < at && ['system', 'developer'].includes(msgs[i]?.role)) i += 1;
  const leadFull = msgs.slice(0, i).map(messageLine).join('\n');
  const between = msgs.slice(i, at);
  const tailFull = msgs.slice(at).map(messageLine).join('\n');
  /* The newest turn first, whole wherever the instructions' first 40% leave room for it; then the instructions, in
     whatever the newest turn leaves; then the turns between, newest first, in what is left after both. */
  const leadShare = Math.min(leadFull.length, Math.floor(max * 0.4));
  const tail = cutMiddle(tailFull, max - (leadShare ? leadShare + 1 : 0));
  const lead = leadFull ? cutMiddle(leadFull, Math.max(0, max - tail.length - 1)) : '';
  let room = max - tail.length - (lead ? lead.length + 1 : 0) - 48;
  const kept = [];
  for (let k = between.length - 1; k >= 0; k -= 1) {
    const line = messageLine(between[k]);
    if (line.length + 1 > room) break;
    kept.unshift(line);
    room -= line.length + 1;
  }
  const dropped = between.length - kept.length;
  const note = dropped ? `[${dropped} earlier message${dropped === 1 ? '' : 's'} left out]` : '';
  return [lead, note, ...kept, tail].filter(Boolean).join('\n');
}
