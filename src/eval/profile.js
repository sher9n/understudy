import crypto from 'node:crypto';
import { db, now } from '../db/index.js';
import { clip } from '../jev.js';

/* What a workload needs from a model, read from its own traffic.
 *
 * Choosing models by price alone chose ones that could not do the job: a model that cannot
 * take tools, cannot return JSON, cannot see images, cannot read a prompt this long or write an
 * answer this long, or thinks for longer than the customer's own cap on answers allows. All of
 * that is written in the requests the customer already sends, so it is read from them. */

const DAY = 86400000;
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ') : '');

const hasImage = (msgs) => msgs.some((m) => Array.isArray(m?.content)
  && m.content.some((p) => /image|file|audio|video/.test(String(p?.type || ''))));

const memo = new Map();
const MEMO_MS = 5 * 60000;

export async function profileOf(workload, { fresh = false } = {}) {
  const hit = memo.get(workload.id);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.profile;

  const rows = await db.prepare(
    `SELECT request_json, prompt_tokens, completion_tokens, latency_ms, status_code, served_model, created_at
       FROM calls WHERE workload_id = ? AND source NOT IN ('replay', 'test') AND created_at >= ?
      ORDER BY created_at DESC LIMIT 600`).all(workload.id, now() - 30 * DAY);
  const profile = profileFromRows(workload, rows);
  memo.set(workload.id, { at: Date.now(), profile });
  return profile;
}

/** The same profile from calls already in hand, newest first. Pure, so a backtest can use it. */
export function profileFromRows(workload, rows) {

  let streamed = 0;
  let withBody = 0;
  let tools = false;
  let toolChoice = false;
  let json = 'none';
  let images = false;
  let reasoningSet = false;
  const caps = [];
  const hours = new Array(168).fill(0);
  const examples = [];
  for (const r of rows) {
    const t = new Date(r.created_at);
    hours[t.getUTCDay() * 24 + t.getUTCHours()] += 1;
    if (!r.request_json) continue;
    let b;
    try { b = JSON.parse(r.request_json); } catch { continue; }
    withBody += 1;
    if (b.stream === true) streamed += 1;
    if (Array.isArray(b.tools) && b.tools.length) tools = true;
    if (b.tool_choice && b.tool_choice !== 'auto' && b.tool_choice !== 'none') toolChoice = true;
    const rf = b.response_format?.type;
    if (rf === 'json_schema') json = 'schema';
    else if (rf === 'json_object' && json === 'none') json = 'object';
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    if (hasImage(msgs)) images = true;
    if (b.reasoning || b.reasoning_effort || b.include_reasoning !== undefined) reasoningSet = true;
    const cap = Number(b.max_completion_tokens ?? b.max_tokens);
    if (Number.isFinite(cap) && cap > 0) caps.push(cap);
    if (examples.length < 3) {
      const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');
      const user = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).slice(-1)[0] || '';
      const ex = [sys && `Instructions: ${clip(sys, 700)}`, user && `Request: ${clip(user, 500)}`].filter(Boolean).join('\n');
      if (ex && !examples.includes(ex)) examples.push(ex);
    }
  }

  const ok = rows.filter((r) => (r.status_code ?? 200) < 400);
  const pin = ok.map((r) => r.prompt_tokens || 0).filter((x) => x > 0);
  const pout = ok.map((r) => r.completion_tokens || 0).filter((x) => x > 0);
  const ref = workload.reference_model;
  const onRef = ok.filter((r) => r.served_model === ref && r.latency_ms > 0).map((r) => r.latency_ms);
  const streamedShare = withBody ? streamed / withBody : 0;

  const task = {
    name: workload.slug || 'workload',
    answers: { free_text: 'written text', json: 'JSON data', enum: 'one label from a fixed list', tool_call: 'a call to one of its tools' }[workload.shape_kind] || workload.shape_kind,
    examples,
  };
  const profile = {
    calls: rows.length,
    streamedShare,
    streamed: streamedShare >= 0.5,
    tools,
    toolChoice,
    json,
    images,
    reasoningSet,
    /* The tightest cap the customer sets on answers, when most calls set one: a thinking model
       has to fit its thinking and its answer under it. */
    outCap: caps.length >= Math.max(1, withBody * 0.5) ? Math.min(...caps) : null,
    promptAvg: pin.length ? pin.reduce((a, b) => a + b, 0) / pin.length : 0,
    promptP95: pct(pin, 0.95) ?? 0,
    promptMax: pin.length ? Math.max(...pin) : 0,
    outAvg: pout.length ? pout.reduce((a, b) => a + b, 0) / pout.length : 0,
    outP50: pct(pout, 0.5) ?? 0,
    outP95: pct(pout, 0.95) ?? 0,
    refLatencyP50: pct(onRef, 0.5),
    refLatencyP90: pct(onRef, 0.9),
    hours: rows.length ? hours : null,
    /* Somebody watching words appear feels the wait for the first one, so a streamed workload
       keeps the customer's own speed by default; one that is not streamed may be a little
       slower, because nobody is watching it being written. */
    speedAuto: streamedShare >= 0.5 ? 'same' : 'slower_ok',
    task,
    taskKey: crypto.createHash('sha256')
      .update(JSON.stringify({ shape: workload.shape_kind, name: task.name, examples }))
      .digest('hex').slice(0, 32),
  };
  return profile;
}

/** Forget a workload's profile, after its traffic or its settings changed. */
export const forgetProfile = (workloadId) => memo.delete(workloadId);

/** The speed a switched-to model has to keep, from the workload's setting or its traffic. */
export function speedRule(workload, profile, config) {
  const pref = workload.speed_pref || profile.speedAuto;
  if (pref === 'any') return { pref, factor: null, metric: null };
  const factor = pref === 'same' ? config.SPEED_SAME : config.SPEED_SLOWER_OK;
  return {
    pref,
    auto: !workload.speed_pref,
    factor,
    slowEnd: factor + config.SPEED_SLOW_END_EXTRA,
    /* Streamed: the first word is what is felt. Otherwise the whole answer is. */
    metric: profile.streamed ? 'ttft' : 'latency',
  };
}
