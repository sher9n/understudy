/* What a workload costs on the model it started on and on the one serving it now, and what
   that difference comes to over time. Every function here is pure, so the figures on a
   switched card can be checked by hand from the prices and the token counts beside them.

   The two sides are priced the way the customer would actually pay them. The original model
   is priced at its own list price, because without us that is what it costs. The model
   serving it now carries our routing fee, because through us that is what it costs. Leaving
   the fee off would make the saving look bigger than the one that reaches the customer. */

const round8 = (n) => Math.round(n * 1e8) / 1e8;

/** One call on a model, from its per-token prices and one call's token counts. */
export function perCall(price, tokens) {
  if (!price || !tokens) return null;
  return price.price_in * tokens.prompt + price.price_out * tokens.completion;
}

/** The same thing with our fee on it, which is what a routed call is charged. */
export const withFeeOn = (usd, feePct) => (usd == null ? null : usd * (1 + feePct / 100));

/* How many calls a month the workload makes, from what it did over a window of days. A
   workload seen for three days is projected from those three days, never from thirty, so a
   new workload is not made to look ten times quieter than it is. */
export function callsPerMonth(calls, days) {
  if (!calls) return 0;
  return (calls / Math.max(1, Math.min(30, days))) * 30;
}

/* The saving over time, at a steady volume. `fromPerCall` is the original model at list price;
   `toPerCall` is the model serving it now, already including the fee. */
export function projectSavings({ fromPerCall, toPerCall, monthly, months = [1, 3, 6, 12] }) {
  if (fromPerCall == null || toPerCall == null) return [];
  return months.map((m) => {
    const from = fromPerCall * monthly * m;
    const to = toPerCall * monthly * m;
    return { months: m, from: round8(from), to: round8(to), saved: round8(from - to) };
  });
}

/** How much cheaper one call is, as a percentage of the original, or null when unpriced. */
export function cheaperPct(fromPerCall, toPerCall) {
  if (fromPerCall == null || toPerCall == null || fromPerCall <= 0) return null;
  return ((fromPerCall - toPerCall) / fromPerCall) * 100;
}
