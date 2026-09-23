/* What a finished measurement found, as SQL, for a row that may not say.
 *
 * Every run now records its outcome, and migration 011 filled it in for the runs before it. But
 * during a deploy the old process can still finish a run after the new one has booted, and it
 * writes no outcome. Reading a missing outcome as "compared", as a plain COALESCE did, made a run
 * that ran out of balance stand in for the last real measurement until the hourly backfill
 * caught up, and a workload could forget a candidate in that hour. So a missing outcome is worked
 * out from the same things the backfill uses, wherever one is read.
 *
 * `r` is the table alias, or '' for none. */
export const OUTCOME_CASE = (r = '') => `CASE
    WHEN ${r}status = 'failed' THEN 'interrupted'
    WHEN ${r}status = 'stopped' THEN 'stopped'
    WHEN ${r}error LIKE 'reference disagreed with itself%' THEN 'unmeasurable'
    WHEN ${r}error = 'balance ran out after the bar was set' THEN 'no_balance'
    ELSE 'compared' END`;

export const OUTCOME_OF = (r = '') => `COALESCE(${r}outcome, ${OUTCOME_CASE(r)})`;

/** The same reading for a row already fetched, for the page. Keep it in step with the SQL above. */
export function outcomeOf(r) {
  if (!r) return null;
  if (r.outcome) return r.outcome;
  if (r.status === 'failed') return 'interrupted';
  if (r.status === 'stopped') return 'stopped';
  if (r.status !== 'done') return null;
  if (String(r.error || '').startsWith('reference disagreed with itself')) return 'unmeasurable';
  if (r.error === 'balance ran out after the bar was set') return 'no_balance';
  return 'compared';
}

/* Whether a measurement found a model to switch to, by the rule the run itself switches on:
   cleared the bar, has a monthly price, and costs less a month than the customer's model. A
   model that cleared but costs more is not a candidate; counting it as one put "Ready to
   optimize" over a workload the run had said nothing cleared, and offered a saving of minus. */
export function cheaperCleared(results) {
  const ref = results.find((r) => r.verdict === 'reference');
  const refCost = ref?.cost_month_usd ?? null;
  return results.filter((r) => r.verdict === 'cleared' && r.cost_month_usd != null
    && (refCost == null || r.cost_month_usd < refCost));
}

/* Whether a switch changes anything yet. Only calls that come through Understudy can be sent to
   another model: a copy arrives after the customer's own provider has already answered it. A
   switch on a workload whose calls all arrive as copies is set up and waiting, and starts with
   its first routed call; until then it is not "optimized", and nothing on it is saved. Read from
   the latest hundred calls, so a workload that starts coming through us counts within days. */
export const RECENT_CALLS = 100;
/* The monthly plan used to put a workspace in an "observe" mode that refused every routed call, so a
   plan customer could not route even the one workload that had cleared. The plan is now only a
   measuring allowance, and whether a switch carries calls is read from the calls themselves. */
export function carriesOf({ routed = 0 } = {}) {
  return Number(routed) > 0;
}

