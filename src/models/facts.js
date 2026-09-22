import config from '../config.js';
import { db, now } from '../db/index.js';

/* What we know about every model, read in one place.
 *
 * The catalogue says what a model can do and what it lists at; the zero-retention list says
 * which providers can actually serve it for us, what they charge, how healthy they have been
 * and how fast they are. Both are refreshed on a timer, and both say when they were read,
 * because these are facts about today: providers come and go, prices move, a model that was
 * unreliable this morning can be fine by the afternoon. */

const parse = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

let memo = null;
let memoAt = 0;
const MEMO_MS = 60000;

/** Every model and its zero-retention providers, parsed. Read once a minute at most. */
export async function loadFacts({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memoAt < MEMO_MS) return memo;
  const models = await db.prepare(
    `SELECT model_id, name, context_len, price_in, price_out, open_weights, zdr, description, released_at,
            params_json, inputs_json, max_output, reasoning_json, expires_at, overrides_json, synced_at
       FROM models_catalog`).all();
  const endpoints = await db.prepare('SELECT * FROM model_endpoints').all();
  const synced = await db.prepare('SELECT source, synced_at, note FROM fact_sync').all();
  const byModel = new Map();
  for (const e of endpoints) {
    const row = { ...e, overrides: parse(e.overrides_json, null), params: parse(e.params_json, null) };
    if (!byModel.has(e.model_id)) byModel.set(e.model_id, []);
    byModel.get(e.model_id).push(row);
  }
  const map = new Map();
  for (const m of models) {
    map.set(m.model_id, {
      id: m.model_id,
      name: m.name,
      contextLen: m.context_len,
      priceIn: m.price_in,
      priceOut: m.price_out,
      overrides: parse(m.overrides_json, null),
      description: m.description || '',
      releasedAt: m.released_at,
      params: parse(m.params_json, null),
      inputs: parse(m.inputs_json, null),
      maxOutput: m.max_output,
      reasoning: parse(m.reasoning_json, null),
      expiresAt: m.expires_at,
      endpoints: byModel.get(m.model_id) || [],
    });
  }
  memo = {
    models: map,
    /* A zero-retention list that was never read, or that failed to load, is not the same as
       one that says a model has no such provider. Only the second rules a model out. */
    zdrKnown: endpoints.length > 0,
    syncedAt: Object.fromEntries(synced.map((r) => [r.source, r.synced_at])),
  };
  memoAt = Date.now();
  return memo;
}

/** Forget the parsed copy, after a sync wrote new facts. */
export const forgetFacts = () => { memo = null; };

/** True when a fact source was read within its lifetime. */
export async function isFresh(source, ttlMs) {
  const row = await db.prepare('SELECT synced_at FROM fact_sync WHERE source = ?').get(source);
  return !!row && now() - row.synced_at < ttlMs;
}

export async function markSynced(source, note = null) {
  await db.prepare(`INSERT INTO fact_sync (source, synced_at, note) VALUES (?, ?, ?)
              ON CONFLICT (source) DO UPDATE SET synced_at = excluded.synced_at, note = excluded.note`)
    .run(source, now(), note);
}

/* Prices -------------------------------------------------------------------------- */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const minutesOf = (hhmm) => Math.floor(Number(hhmm) / 100) * 60 + (Number(hhmm) % 100);

/* The price a provider actually charges for one call.
 *
 * Two kinds of exception are published beside a headline price. A long prompt can cost more
 * from some size up. And some prices change with the hour: one DeepSeek model costs twice as
 * much on weekday mornings and middays, UTC. The hour prices are averaged over the hours this
 * workload's calls actually arrive in, so a workload that runs at night is not priced at the
 * daytime rate, nor the other way round. `hours` is 168 weights, one per hour of the week in
 * UTC, Sunday first; without it every hour counts the same. */
export function callPrice(p, promptTokens, completionTokens, hours = null) {
  let pin = Number(p.priceIn ?? p.price_in ?? 0);
  let pout = Number(p.priceOut ?? p.price_out ?? 0);
  const overrides = Array.isArray(p.overrides) ? p.overrides : [];

  // the long-prompt tier that applies to a prompt of this size, if any
  const tiers = overrides.filter((o) => o && o.min_prompt_tokens != null && !o.utc_days)
    .filter((o) => promptTokens >= Number(o.min_prompt_tokens))
    .sort((a, b) => Number(b.min_prompt_tokens) - Number(a.min_prompt_tokens));
  if (tiers.length) {
    pin = Number(tiers[0].prompt ?? pin);
    pout = Number(tiers[0].completion ?? pout);
  }

  /* A window of hours, on some days or on every day. One that ends at 0 ends at midnight, and one
     that ends before it starts runs past midnight: tencent/hy3 is cheaper from 16:00 to 0, every
     day, and read literally that window never matched an hour. */
  const timed = overrides.filter((o) => o && (Array.isArray(o.utc_days) || o.utc_start != null || o.utc_end != null));
  if (!timed.length) return pin * promptTokens + pout * completionTokens;
  const inWindow = (o, day, minute) => {
    if (Array.isArray(o.utc_days) && !o.utc_days.map((d) => String(d).toLowerCase()).includes(day)) return false;
    const start = o.utc_start == null ? 0 : minutesOf(o.utc_start);
    const end = o.utc_end == null ? 1440 : minutesOf(o.utc_end);
    return end > start ? minute >= start && minute < end : minute >= start || minute < end;
  };
  let total = 0;
  let weight = 0;
  for (let h = 0; h < 168; h += 1) {
    const w = hours ? Number(hours[h] || 0) : 1;
    if (!w) continue;
    const day = DAYS[Math.floor(h / 24)];
    const minute = (h % 24) * 60 + 30;
    const hit = timed.find((o) => inWindow(o, day, minute));
    const hi = hit ? Number(hit.prompt ?? pin) : pin;
    const ho = hit ? Number(hit.completion ?? pout) : pout;
    total += w * (hi * promptTokens + ho * completionTokens);
    weight += w;
  }
  return weight ? total / weight : pin * promptTokens + pout * completionTokens;
}

/** A provider that can be counted on: live, and answering most of what it is sent. */
export const healthy = (e) => (e.status === null || e.status === 0)
  && (e.uptime_1d === null || e.uptime_1d >= 95)
  && (e.uptime_30m === null || e.uptime_30m >= 80);

/* What a call on this model costs us, going the way OpenRouter routes it.
 *
 * With zero retention required, only those providers can be used. OpenRouter spreads calls
 * over the cheaper ones, weighted by the inverse square of their price, so the price we pay is
 * that weighted average rather than the cheapest provider's, and rather than the headline
 * price, which is often a provider we are not allowed to use. Answers null when no provider
 * that keeps nothing serves it at all. */
export function routedCallPrice(model, promptTokens, completionTokens, hours = null, { zdrOnly = config.ZDR_ONLY } = {}) {
  if (!zdrOnly) return callPrice(model, promptTokens, completionTokens, hours);
  const usable = (model.endpoints || []).filter(healthy);
  const pool = usable.length ? usable : (model.endpoints || []);
  if (!pool.length) return null;
  const prices = pool.map((e) => callPrice({ priceIn: e.price_in, priceOut: e.price_out, overrides: e.overrides },
    promptTokens, completionTokens, hours)).filter((x) => x > 0);
  if (!prices.length) return null;
  const weights = prices.map((x) => 1 / (x * x));
  const sum = weights.reduce((a, b) => a + b, 0);
  return prices.reduce((a, x, i) => a + x * weights[i], 0) / sum;
}

/* How reachable and how quick a model is, from its providers that keep nothing.
   The best provider's figures, because OpenRouter sends a call to a healthy one first. */
export function healthOf(model) {
  const eps = model.endpoints || [];
  const good = eps.filter(healthy);
  const up = eps.map((e) => e.uptime_1d).filter((x) => x !== null && x !== undefined);
  const ttft = good.map((e) => e.ttft_p50).filter((x) => x != null);
  const ttft90 = good.map((e) => e.ttft_p90).filter((x) => x != null);
  const tps = good.map((e) => e.tps_p50).filter((x) => x != null);
  return {
    providers: eps.length,
    healthyProviders: good.length,
    bestUptime: up.length ? Math.max(...up) : null,
    ttftP50: ttft.length ? Math.min(...ttft) : null,
    ttftP90: ttft90.length ? Math.min(...ttft90) : null,
    tpsP50: tps.length ? Math.max(...tps) : null,
  };
}
