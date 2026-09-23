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
 * The customer's own model is never priced with our fee on it: without us, they would not pay it.
 *
 * Each call the customer made is counted once. A try that failed and was answered another way (an
 * experiment, or a switch sent on to the customer's own model) is a row of its own, beside the row of
 * what answered it; it is not a call of the customer's, and nothing it would have cost is counted. The
 * row that answered it carries the call. A call that failed outright was never answered, so nothing is
 * said to have been saved on it. A strategy's measured cost is only ever applied to calls it answered,
 * and it is read from them too (see the fair record in src/learn/fair.js): read with its failures at
 * nothing, and applied to every try as well as to the answer that stood in for each failure, a failed
 * call was counted twice and a switch that failed one call in twenty read one in twenty cheaper. */

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
            COALESCE(c.status_code = 200, FALSE) AS ok,
            COALESCE(c.check_json LIKE '%"by":"fell back"%' OR c.check_json LIKE '%"by":"experiment failed"%', FALSE) AS tried,
            COUNT(*) AS n, COALESCE(SUM(c.charged_usd), 0) AS paid, COALESCE(SUM(c.cost_usd), 0) AS cost,
            COALESCE(SUM(c.prompt_tokens), 0) AS pin, COALESCE(SUM(c.completion_tokens), 0) AS pout,
            COALESCE(SUM(c.cached_tokens), 0) AS cached
       FROM calls c
      WHERE c.workspace_id = ? AND c.created_at >= ? AND c.source = 'routed'
        ${workloadId ? 'AND c.workload_id = ?' : ''}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`)
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
    /* A try answered another way is not a call of the customer's, and a call that failed outright was
       never answered: whatever either was charged is still counted as paid, and nothing as saved. */
    if (r.tried || !r.ok) {
      if (!r.tried) calls += Number(r.n);
      slot.paid = round8(slot.paid + paid);
      continue;
    }
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
