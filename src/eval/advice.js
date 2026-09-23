import { db, now } from '../db/index.js';
import config from '../config.js';

/* Savings a customer can make in their own code, which no switch of ours can make for them.
 *
 * Said as advice with its numbers, never done behind anybody's back: a cap on answer length cuts
 * off answers that were meant to be long, so only the customer can say whether the long ones matter.
 * Every figure is from the workload's own calls over the last thirty days. */

const DAY = 86400000;

export async function adviceFor(workload) {
  if (!workload?.id) return [];
  const since = now() - 30 * DAY;
  const out = [];
  const s = await db.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS first,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY completion_tokens) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY completion_tokens) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY completion_tokens) AS p99,
            COUNT(*) FILTER (WHERE request_json IS NOT NULL
              AND ((request_json::jsonb -> 'max_tokens') IS NOT NULL OR (request_json::jsonb -> 'max_completion_tokens') IS NOT NULL)) AS capped,
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
     workspace turned marking off, or calls do not yet come often enough for it to pay. */
  if (model && /^anthropic\//.test(model)) {
    const ws = await db.prepare('SELECT cache_hints FROM workspaces WHERE id = ?').get(workload.workspace_id);
    const hinted = (await db.prepare(
      `SELECT COUNT(*) AS n FROM calls WHERE workload_id = ? AND created_at >= ? AND hinted = 1`).get(workload.id, since)).n;
    if (!Number(hinted) && Number(ws?.cache_hints ?? 1) === 0) {
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
