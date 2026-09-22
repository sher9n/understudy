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

/* What a request sends besides text, named the way the model catalogue names what a model can
   read. A picture, a sound and a document are different abilities: a model that can see cannot
   necessarily hear. */
const MEDIA = [['image', 'image'], ['audio', 'audio'], ['video', 'video'], ['file', 'file']];
const inputsOf = (msgs) => {
  const out = new Set();
  for (const m of msgs) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      const type = String(part?.type || '');
      for (const [word, input] of MEDIA) if (type.includes(word)) out.add(input);
    }
  }
  return out;
};

/* What a request says about thinking: 'off', 'on', or null when it says nothing about whether
   to think. Asking only for the notes to be left out of the answer ({exclude: true}, or
   include_reasoning) says nothing about whether the model thinks. */
export function thinkingAsked(b) {
  const r = b?.reasoning && typeof b.reasoning === 'object' ? b.reasoning : null;
  const effort = r?.effort ?? b?.reasoning_effort ?? null;
  if (r?.enabled === false || effort === 'none') return 'off';
  if (r?.enabled === true || (effort && effort !== 'none') || Number(r?.max_tokens) > 0) return 'on';
  return null;
}

const memo = new Map();
const MEMO_MS = 5 * 60000;

export async function profileOf(workload, { fresh = false } = {}) {
  const hit = memo.get(workload.id);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.profile;

  const rows = await db.prepare(
    `SELECT request_json, prompt_tokens, completion_tokens, latency_ms, status_code, served_model, cost_usd, created_at
       FROM calls WHERE workload_id = ? AND source NOT IN ('replay', 'test') AND created_at >= ?
      ORDER BY created_at DESC LIMIT 600`).all(workload.id, now() - 30 * DAY);
  const profile = profileFromRows(workload, rows);
  profile.refThinking = await refThinkingOf(workload);
  memo.set(workload.id, { at: Date.now(), profile });
  return profile;
}

/* Whether the customer's own model thought before answering these calls, as measured: the
 * share of its answers that carried any thinking, and how many answers that is from. Our own
 * replays of these calls come first, because they went the way a candidate's will; the usage
 * its provider reported on the calls themselves fills in when there are too few. Null when
 * nothing says either way. */
export async function refThinkingOf(workload) {
  if (!workload.reference_model) return null;
  const since = now() - 30 * DAY;
  const replayed = await db.prepare(
    `SELECT reasoning_tokens AS t FROM replay_cache
      WHERE model_id = ? AND status = 200 AND reasoning_tokens IS NOT NULL AND recipe_json IS NULL
        AND call_id IN (SELECT id FROM calls WHERE workload_id = ? AND created_at >= ?)
      ORDER BY created_at DESC LIMIT 60`).all(workload.reference_model, workload.id, since);
  let xs = replayed.map((r) => Number(r.t)).filter(Number.isFinite);
  if (xs.length < 3) {
    // only the one number, read out of the stored response without parsing all of it
    const own = await db.prepare(
      `SELECT substring(response_json from '"reasoning_tokens"[[:space:]]*:[[:space:]]*([0-9]+)') AS t
         FROM calls WHERE workload_id = ? AND served_model = ? AND source NOT IN ('replay', 'test')
          AND response_json IS NOT NULL AND created_at >= ?
        ORDER BY created_at DESC LIMIT 60`).all(workload.id, workload.reference_model, since);
    xs = xs.concat(own.map((r) => (r.t === null || r.t === undefined ? NaN : Number(r.t))).filter(Number.isFinite));
  }
  if (!xs.length) return null;
  return { share: xs.filter((x) => x > 0).length / xs.length, n: xs.length };
}

/** The same profile from calls already in hand, newest first. Pure, so a backtest can use it. */
export function profileFromRows(workload, rows) {

  let streamed = 0;
  let withBody = 0;
  let tools = false;
  let toolChoice = false;
  let json = 'none';
  const inputs = new Set();
  const asked = new Set();
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
    for (const x of inputsOf(msgs)) inputs.add(x);
    const ask = thinkingAsked(b);
    if (ask) asked.add(ask);
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
  const refCosts = ok.filter((r) => r.served_model === ref && Number(r.cost_usd) > 0).map((r) => Number(r.cost_usd));
  const streamedShare = withBody ? streamed / withBody : 0;
  /* What the customer's requests ask about thinking, taken together: off, on, or both, in which
     case they are left to say it call by call. */
  const thinking = asked.size === 1 ? [...asked][0] : asked.size > 1 ? 'mixed' : null;

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
    inputs: [...inputs],
    images: inputs.has('image'),
    /* Whether the customer's requests set how much to think: when they do (on, or differently
       call by call), every model is sent them as they are. Asking for thinking to be off is
       read as the customer's model answering straight away, which is how candidates are then
       asked too. */
    thinking,
    reasoningSet: thinking === 'on' || thinking === 'mixed',
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
    // what a call on the customer's model has really cost, for a model the catalogue cannot price
    refCostPerCall: refCosts.length ? refCosts.reduce((a, b) => a + b, 0) / refCosts.length : null,
    hours: rows.length ? hours : null,
    /* Somebody watching words appear feels the wait for the first one, so a streamed workload
       keeps the customer's own speed by default; one that is not streamed may be a little
       slower, because nobody is watching it being written. */
    speedAuto: streamedShare >= 0.5 ? 'same' : 'slower_ok',
    task,
    /* What Jev's readings of this task are kept under. The workload's own identity, not its
       newest requests: those change with every call, and a key that changes with every call is
       a cache that is never read. */
    taskKey: crypto.createHash('sha256')
      .update(JSON.stringify({ shape: workload.shape_kind, workload: workload.struct_key || workload.fingerprint || workload.id }))
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
