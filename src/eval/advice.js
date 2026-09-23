import { db, now } from '../db/index.js';
import config from '../config.js';
import { hintApplies } from '../openrouter.js';

/* Savings a customer can make in their own code, which no switch of ours can make for them.
 *
 * Said as advice with its numbers, never done behind anybody's back: a cap on answer length cuts
 * off answers that were meant to be long, so only the customer can say whether the long ones matter.
 * Every figure is from the workload's own calls over the last thirty days.
 *
 * Advice is a side note on the workload page, so it can never take the page down: anything that
 * goes wrong while working it out leaves the page without advice rather than without a page. */

const DAY = 86400000;

/* Whether a call set a cap on its answer, read from the request as it was stored. The stored text is
   never read as JSON by the database: JSON.stringify writes a NUL character and a lone surrogate as
   escapes that Postgres refuses as jsonb, so one such call anywhere in thirty days made the cast fail
   and the whole workload page answer 500. It also parsed every call on every page load. A key as
   JSON.stringify writes it, a quote, the name, a quote and a colon, cannot come from inside a string,
   where every quote is escaped. */
const CAPPED = `(strpos(request_json, '"max_tokens":') > 0 OR strpos(request_json, '"max_completion_tokens":') > 0)`;

export async function adviceFor(workload) {
  if (!workload?.id) return [];
  try {
    return await adviceOf(workload);
  } catch (err) {
    console.error(`advice for ${workload.slug || workload.id} could not be worked out: ${err?.message || err}`);
    return [];
  }
}

async function adviceOf(workload) {
  const since = now() - 30 * DAY;
  const out = [];
  const s = await db.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS first,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY completion_tokens) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY completion_tokens) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY completion_tokens) AS p99,
            COUNT(*) FILTER (WHERE request_json IS NOT NULL AND ${CAPPED}) AS capped,
            COUNT(*) FILTER (WHERE request_json IS NOT NULL) AS readable
       FROM calls
      WHERE workload_id = ? AND source IN ('routed', 'trace') AND status_code = 200 AND created_at >= ?
        AND completion_tokens > 0`).get(workload.id, since);
  const n = Number(s?.n || 0);
  if (n < 50) return out;
  const days = Math.max(1, Math.min(30, (now() - Number(s.first)) / DAY));
  const model = workload.routed_model || workload.reference_model;
  const price = model ? await db.prepare('SELECT price_out FROM models_catalog WHERE model_id = ?').get(model) : null;

  /* A cap on answer length. Worth saying when most calls set none and a few answers run many times
     longer than the typical one: those few are often an answer that did not know when to stop. The cap
     suggested leaves room for every answer up to the longest one in twenty, and half as much again. */
  const p50 = Number(s.p50 || 0);
  const p95 = Number(s.p95 || 0);
  const p99 = Number(s.p99 || 0);
  const readable = Number(s.readable || 0);
  const cappedShare = readable ? Number(s.capped) / readable : 1;
  if (readable && cappedShare < 0.5 && p99 >= 800 && p50 > 0 && p99 >= 6 * p50 && price?.price_out > 0) {
    const cap = Math.max(256, Math.ceil((p95 * 1.5) / 50) * 50);
    const over = await db.prepare(
      `SELECT COALESCE(SUM(GREATEST(0, completion_tokens - ?)), 0) AS t, COUNT(*) FILTER (WHERE completion_tokens > ?) AS k
         FROM calls WHERE workload_id = ? AND source IN ('routed', 'trace') AND status_code = 200 AND created_at >= ?`)
      .get(cap, cap, workload.id, since);
    const monthly = (Number(over.t) * Number(price.price_out) / days) * 30;
    if (monthly >= 0.01) {
      out.push({
        kind: 'answer_cap',
        title: `Cap answers at about ${cap.toLocaleString('en-US')} tokens`,
        detail: `Most answers run about ${Math.round(p50).toLocaleString('en-US')} tokens, and one in a hundred runs past `
          + `${Math.round(p99).toLocaleString('en-US')}. ${Number(over.k)} answers in the last ${Math.round(days)} days ran past `
          + `${cap.toLocaleString('en-US')} tokens. If those long ones are not needed, setting max_tokens to ${cap} would cut `
          + `about $${monthly.toFixed(2)} a month. Leave it if the long answers are the point.`,
        monthlyUsd: Math.round(monthly * 100) / 100,
        cap,
      });
    }
  }

  /* A long instruction on a model that only caches what is marked, where we do not mark it: the
     workspace turned marking off, or calls do not yet come often enough for it to pay. Only where the
     instruction really is long enough for a provider to cache it: a short one is never marked, so
     switching marking on would change nothing and the advice would be a false promise. Read from a few
     of the newest calls that still hold their request, the way a call is read when it is marked. */
  if (model && /^anthropic\//.test(model)) {
    const ws = await db.prepare('SELECT cache_hints FROM workspaces WHERE id = ?').get(workload.workspace_id);
    const hinted = (await db.prepare(
      `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND created_at >= ? AND hinted = 1`).get(workload.id, since)).n;
    if (!Number(hinted) && Number(ws?.cache_hints ?? 1) === 0 && await longInstruction(workload, model, since)) {
      out.push({
        kind: 'cache_hints',
        title: 'Let us mark your instruction for caching',
        detail: 'This workload sends a long instruction to a model that only caches what is marked. With marking '
          + 'switched on in Settings, repeated instructions are read back from the cache at a tenth of the price, on '
          + `workloads busy enough for that to pay (${config.CACHE_HINT_MIN_PER_HOUR} calls an hour or more).`,
        monthlyUsd: null,
      });
    }
  }
  return out;
}

/* Whether this workload's instruction is one a provider would cache if we marked it: at least
   CACHE_HINT_MIN_CHARS long, and not already marked by the customer. */
async function longInstruction(workload, model, since) {
  const rows = await db.prepare(
    `SELECT request_json FROM calls WHERE workload_id = ? AND created_at >= ? AND request_json IS NOT NULL
        AND source IN ('routed', 'trace') ORDER BY created_at DESC LIMIT 5`).all(workload.id, since);
  for (const r of rows) {
    let body = null;
    try { body = JSON.parse(r.request_json); } catch { continue; }
    if (hintApplies(body, model)) return true;
  }
  return false;
}
