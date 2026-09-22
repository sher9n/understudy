import config, { canJev } from './config.js';
import { reportCallFailure } from './alerts.js';

/* Jev, TypeSafe's System One model.
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
   limit is moving, so this is kept well under it and a refusal is waited out, not retried hard. */
let active = 0;
const waiting = [];
const acquire = () => new Promise((resolve) => {
  if (active < config.JEV_CONCURRENCY) { active += 1; resolve(); return; }
  waiting.push(resolve);
});
const release = () => {
  const next = waiting.shift();
  if (next) next(); else active -= 1;
};

/** What a request cost, from the tokens Jev says it read. Output is free. */
export const jevCost = (usage) => ((usage?.input_tokens ?? 0) * config.JEV_PRICE_PER_MTOK) / 1e6;

/**
 * Ask Jev one or more questions about one state.
 * Returns { answers, model, usage, costUsd, ms }. Throws JevError when it cannot answer, so a
 * caller always knows the difference between "Jev said no" and "Jev said nothing".
 */
export async function ask(state, questions, { retries = 3, model = config.JEV_MODEL } = {}) {
  if (!canJev()) throw new JevError(0, 'No TYPESAFE_API_KEY is set.');
  if (Date.now() < restingUntil) throw new JevError(503, restingWhy || 'Jev is resting after a refusal');
  await acquire();
  try {
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      let res;
      try {
        res = await fetch(`${config.TYPESAFE_BASE}/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(config.JEV_TIMEOUT_MS),
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
        if ([401, 402, 403].includes(res.status)) {
          restingUntil = Date.now() + REST_MS;
          restingWhy = res.status === 402
            ? 'The TypeSafe account has no credit left, so Jev cannot answer until more is added.'
            : 'TypeSafe refused the key, so Jev cannot answer until it is fixed.';
          if (!outage) reportCallFailure({ kind: 'Jev (TypeSafe)', model, status: res.status, message: msg });
          outage = true;
        }
        throw new JevError(res.status, msg);
      }
      outage = false;
      return {
        answers: body.answers,
        model: body.model || model,
        usage: body.usage || null,
        costUsd: jevCost(body.usage),
        ms: Date.now() - started,
      };
    }
  } finally {
    release();
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text for Jev's state, cut to a length it reads well. Long state costs accuracy. */
export const clip = (s, n = 3000) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)} [cut]` : t;
};
