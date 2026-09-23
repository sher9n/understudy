import config, { canJev } from './config.js';
import { reportCallFailure } from './alerts.js';

/* Jev, TypeSafe's System One model, reached through OpenRouter unless JEV_VIA says otherwise.
 *
 * It does not write text. It is handed some state and a few narrow questions, and it answers
 * each with a probability: a yes/no ("noul"), a pick from a list ("choice"), or a place on a
 * scale ("score"). That is exactly the shape of the two judgements measuring needs most: do
 * these two answers mean the same thing, and how well does this model suit this task. It is
 * fast, it is charged only for what it reads, and every question in one request shares the
 * state and runs at once.
 *
 * Its own documented weak spots are numbers, dates, long state full of things that do not
 * matter, and text in the state written to steer it. So the callers keep numbers in code, keep
 * the state to what the question needs, and word every question to treat the state as data.
 * https://docs.typesafe.ai/model-jaggedness/jev-1.13.md */

export class JevError extends Error {
  constructor(status, message) {
    super(`jev ${status}: ${message}`);
    this.status = status;
  }
}

/* When Jev refuses for a reason that will not pass by itself (the account has no credit, or the
   key is wrong), every question until somebody fixes it would be sent, refused and fallen back
   from, one at a time, slowing a measurement for nothing. So a refusal like that rests Jev for a
   while, everything falls back to the language-model judge at once, and whoever runs the service
   is told, the same way a failing provider is. */
let restingUntil = 0;
let restingWhy = null;
/* Credit and keys are fixed by a person, not by waiting a few seconds, so after such a refusal
   Jev is left alone for half an hour and asked again once; the half hour is what a top-up can
   take to be noticed. Only the first refusal of an outage is reported: while the account stays
   empty, every retry would otherwise be another email saying the same thing. */
const REST_MS = 30 * 60000;
let outage = false;

/** True while Jev can be asked: a key is set and it is not resting after a lasting refusal. */
export const jevUsable = () => canJev() && Date.now() >= restingUntil;
/** Why Jev is resting, for a page to say, or null. */
export const jevResting = () => (Date.now() < restingUntil ? restingWhy : null);

/* How many questions are out at once. Jev allows 1,200 requests a minute today and says the
   limit is moving, so this is kept well under it and a refusal is waited out, not retried hard.

   Some places are kept for questions a live call is waiting on (JEV_LIVE_RESERVED). Work nobody is
   waiting on (a measurement's checks, reading answers in the background, reading follow-ups) queues
   for the rest. With one shared pool, a measurement filling every place made each cascade's live
   check answer "busy", and every call was sent on to the customer's own model at its full price. */
let active = 0;
let background = 0;
const waiting = [];
const backgroundLimit = () => Math.max(1, config.JEV_CONCURRENCY - Math.max(0, config.JEV_LIVE_RESERVED));
const acquire = () => new Promise((resolve) => {
  if (active < config.JEV_CONCURRENCY && background < backgroundLimit()) { active += 1; background += 1; resolve(); return; }
  waiting.push(resolve);
});
// a place now or not at all, for a question somebody's call is waiting on: any free place, reserved ones too
const tryAcquire = () => {
  if (active < config.JEV_CONCURRENCY) { active += 1; return true; }
  return false;
};
const release = (wasBackground) => {
  active -= 1;
  if (wasBackground) background -= 1;
  while (waiting.length && active < config.JEV_CONCURRENCY && background < backgroundLimit()) {
    active += 1;
    background += 1;
    waiting.shift()();
  }
};
/** How the places are being used, for a health page and for tests. */
export const jevSlots = () => ({ active, background, waiting: waiting.length, reservedForLive: config.JEV_CONCURRENCY - backgroundLimit() });

/** What a request cost: as OpenRouter reports it, or from the tokens Jev read. Output is free. */
export const jevCost = (usage) => {
  const said = Number(usage?.cost);
  if (usage?.cost !== undefined && usage?.cost !== null && Number.isFinite(said)) return said;
  return ((usage?.input_tokens ?? 0) * config.JEV_PRICE_PER_MTOK) / 1e6;
};

/* Where a question goes, and with which key. Through OpenRouter it is sent only to a provider
   that keeps nothing, like every other call Understudy makes: the state Jev reads is a
   customer's own requests and answers. */
const viaOpenRouter = () => config.JEV_VIA === 'openrouter';
const route = () => (viaOpenRouter()
  ? {
    url: `${config.OPENROUTER_BASE}/systemone`,
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.PUBLIC_URL,
      'X-Title': 'Understudy',
    },
    extra: config.ZDR_ONLY ? { provider: { zdr: true, data_collection: 'deny' } } : {},
    who: 'Jev (via OpenRouter)',
  }
  : {
    url: `${config.TYPESAFE_BASE}/systemone`,
    headers: { Authorization: `Bearer ${config.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    extra: {},
    who: 'Jev (TypeSafe)',
  });

/* Why a refusal that will not pass by itself happened, in words for the page. */
const restingReason = (status) => {
  if (viaOpenRouter()) {
    if (status === 402) return 'Our OpenRouter account has no credit left, so Jev cannot answer until more is added.';
    if (status === 404) return 'OpenRouter has no provider that keeps nothing serving Jev right now.';
    return 'OpenRouter refused our key for Jev, so it cannot answer until that is fixed.';
  }
  return status === 402
    ? 'The TypeSafe account has no credit left, so Jev cannot answer until more is added.'
    : 'TypeSafe refused the key, so Jev cannot answer until it is fixed.';
};

/**
 * Ask Jev one or more questions about one state.
 * Returns { answers, model, usage, costUsd, ms }. Throws JevError when it cannot answer, so a
 * caller always knows the difference between "Jev said no" and "Jev said nothing".
 */
export async function ask(state, questions, { retries = 3, model = config.JEV_MODEL, timeoutMs = config.JEV_TIMEOUT_MS, wait = true } = {}) {
  if (!canJev()) throw new JevError(0, `Jev is not set up (JEV_VIA is ${config.JEV_VIA}).`);
  const to = route();
  if (Date.now() < restingUntil) throw new JevError(503, restingWhy || 'Jev is resting after a refusal');
  /* A question a live call is waiting on does not queue behind a measurement's: with no place free
     it is answered "busy" at once, and the call goes on without it. */
  if (wait) await acquire();
  else if (!tryAcquire()) throw new JevError(503, 'busy');
  const heldBackground = !!wait;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      let res;
      try {
        res = await fetch(to.url, {
          method: 'POST',
          headers: to.headers,
          body: JSON.stringify({ model, state, questions, ...to.extra }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) { await pause(500 * 2 ** attempt); continue; }
        throw new JevError(0, err?.message || 'unreachable');
      }
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not json */ }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after')) * 1000;
        await pause(Number.isFinite(after) && after > 0 ? after : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok || !body?.answers) {
        const raw = body?.error?.message || body?.message || body?.detail || text.slice(0, 200) || 'no answer';
        const msg = typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 200);
        // a missing private provider is as lasting through OpenRouter as a missing credit
        if ([401, 402, 403].includes(res.status) || (viaOpenRouter() && res.status === 404)) {
          restingUntil = Date.now() + REST_MS;
          restingWhy = restingReason(res.status);
          if (!outage) reportCallFailure({ kind: to.who, model, status: res.status, message: msg });
          outage = true;
        }
        throw new JevError(res.status, msg);
      }
      outage = false;
      return {
        answers: body.answers,
        model: body.model || model,
        provider: body.provider || null,
        usage: body.usage || null,
        costUsd: jevCost(body.usage),
        ms: Date.now() - started,
      };
    }
  } finally {
    release(heldBackground);
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text for Jev's state, cut to a length it reads well. Long state costs accuracy. */
export const clip = (s, n = 3000) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)} [cut]` : t;
};
