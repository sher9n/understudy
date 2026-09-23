import { db, round8 } from '../db/index.js';

/* What the customer's routed calls cost them through us, and what the same calls would have cost
 * going straight to their own provider on their own model. Counted in the database, a day and a
 * strategy at a time, never call by call in memory.
 *
 * "Would have cost" is read the most honest way the record allows, in this order:
 *   the call went to the model it asked for      what it cost, before our fee: nothing was saved on
 *                                                it, and the fee on it is a cost of using us;
 *   a strategy with a measured cost against      what it cost, divided by that measurement: it carries
 *     the customer's own model                   every difference a list price misses, longer answers,
 *                                                thinking that is billed, calls sent on by a check;
 *   otherwise                                    the customer's model's list price for the same tokens,
 *                                                with the prompt tokens the provider had cached priced
 *                                                as cached, where the model says what that costs.
 * The customer's own model is never priced with our fee on it: without us, they would not pay it. */

const DAY = 86400000;

async function ratiosFor(armIds) {
  if (!armIds.length) return new Map();
  const rows = await db.prepare('SELECT id, offline_json, stats_json FROM arms WHERE id = ANY(?::text[])').all(armIds);
  const out = new Map();
  for (const r of rows) {
    let ratio = null;
    try { ratio = JSON.parse(r.stats_json || 'null')?.liveRatio ?? null; } catch { ratio = null; }
    if (!(Number(ratio) > 0)) {
      try { ratio = JSON.parse(r.offline_json || 'null')?.ratio ?? null; } catch { ratio = null; }
    }
    if (Number(ratio) > 0) out.set(r.id, Number(ratio));
  }
  return out;
}

async function measuredRatio(workloadId, model) {
  const r = await db.prepare(
    `SELECT e.cost_ratio FROM eval_results e JOIN eval_runs r ON r.id = e.run_id
      WHERE r.workload_id = ? AND e.model_id = ? AND e.cost_ratio IS NOT NULL
      ORDER BY r.created_at DESC LIMIT 1`).get(workloadId, model);
  return r && Number(r.cost_ratio) > 0 ? Number(r.cost_ratio) : null;
}

/**
 * @returns {{ series: {at, paid, would}[], paid, would, saved, calls, switched }}
 *   series is one entry per day, labelled by the moment it ends, oldest first.
 */
export async function routedSavings({ workspaceId, workloadId = null, days = 30, at }) {
  const t0 = at;
  const first = t0 - (days - 1) * DAY;
  const since = t0 - days * DAY;
  /* Each bucket is labelled by the moment it ENDS, so a call belongs to the first bucket that ends at
     or after it: ceil, not floor, as the charts have always read it. */
  const rows = await db.prepare(
    `SELECT LEAST(?::int, GREATEST(0, CEIL((c.created_at - ?::bigint) / 86400000.0)))::int AS b,
            c.workload_id, c.requested_model, c.served_model, c.arm_id, COALESCE(c.hinted, 0) AS hinted,
            COUNT(*) AS n, COALESCE(SUM(c.charged_usd), 0) AS paid, COALESCE(SUM(c.cost_usd), 0) AS cost,
            COALESCE(SUM(c.prompt_tokens), 0) AS pin, COALESCE(SUM(c.completion_tokens), 0) AS pout,
            COALESCE(SUM(c.cached_tokens), 0) AS cached
       FROM calls c
      WHERE c.workspace_id = ? AND c.created_at >= ? AND c.source = 'routed'
        ${workloadId ? 'AND c.workload_id = ?' : ''}
      GROUP BY 1, 2, 3, 4, 5, 6`)
    .all(...[days - 1, first, workspaceId, since, ...(workloadId ? [workloadId] : [])]);
  const prices = new Map((await db.prepare('SELECT model_id, price_in, price_out, price_cache_read FROM models_catalog').all())
    .map((m) => [m.model_id, m]));
  const ratios = await ratiosFor([...new Set(rows.map((r) => r.arm_id).filter(Boolean))]);
  const measured = new Map();
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) series.push({ at: t0 - i * DAY, paid: 0, would: 0 });
  let calls = 0;
  let switched = 0;
  for (const r of rows) {
    const slot = series[Number(r.b)];
    if (!slot) continue;
    const cost = Number(r.cost);
    const paid = Number(r.paid);
    const asked = r.requested_model;
    const same = !asked || !r.served_model || r.served_model === asked;
    let would = cost;
    const armRatio = r.arm_id ? ratios.get(r.arm_id) ?? null : null;
    if (armRatio && !(same && armRatio === 1)) {
      would = cost / armRatio;
    } else if (same && Number(r.hinted) && prices.get(r.served_model)) {
      /* The customer's own model, with the instruction we marked for caching: without the mark, every
         prompt token would have been paid at full price. */
      const own = prices.get(r.served_model);
      would = own.price_in * Number(r.pin) + own.price_out * Number(r.pout);
    } else if (!same) {
      const key = `${r.workload_id}|${r.served_model}`;
      if (!measured.has(key)) measured.set(key, await measuredRatio(r.workload_id, r.served_model));
      const ratio = measured.get(key);
      const own = prices.get(asked);
      if (ratio) would = cost / ratio;
      else if (own) {
        const pin = Number(r.pin);
        const cached = Math.min(pin, Number(r.cached));
        const cacheRate = own.price_cache_read != null && Number(own.price_cache_read) >= 0 ? Number(own.price_cache_read) : Number(own.price_in);
        would = own.price_in * (pin - cached) + cacheRate * cached + own.price_out * Number(r.pout);
      }
    }
    if (!same) switched += Number(r.n);
    calls += Number(r.n);
    slot.paid = round8(slot.paid + paid);
    slot.would = round8(slot.would + would);
  }
  const paid = round8(series.reduce((a, d) => a + d.paid, 0));
  const would = round8(series.reduce((a, d) => a + d.would, 0));
  return { series, paid, would, saved: round8(would - paid), calls, switched };
}
