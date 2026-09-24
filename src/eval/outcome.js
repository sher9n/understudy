import config from '../config.js';

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
   cleared the bar, priced, and costs less than the customer's model once our fee is added. A
   model that cleared but costs more is not a candidate; counting it as one put "Ready to
   optimize" over a workload the run had said nothing cleared, and offered a saving of minus. A
   customer's model with no known price used to wave the price check through, so a model ten
   times dearer could be switched to; with nothing to compare against, nothing is a candidate.

   One the second look confirmed before one it did not: a person may still approve that one, but it is
   never what is offered first. Then in the order the run itself chose from (choice_rank, by the
   workload's routing priority: see src/eval/confidence.js), and cheapest first where a run kept no order
   (every run before routing priorities). */
export function cheaperCleared(results, feePct = config.ROUTING_FEE_PCT) {
  const ref = results.find((r) => r.verdict === 'reference');
  const refCost = ref?.cost_month_usd ?? null;
  const ceiling = 1 / (1 + (Number(feePct) || 0) / 100);
  const rank = (r) => (r.choice_rank === null || r.choice_rank === undefined ? Infinity : Number(r.choice_rank));
  /* One a cautious workload left out as not sure enough is never offered: offered, approving with no
     model named switched to exactly what the workload's own priority had turned down. */
  return results.filter((r) => r.verdict === 'cleared' && r.cost_month_usd != null && refCost != null
    && Number(r.cost_month_usd) < Number(refCost)
    && (r.cost_ratio == null || Number(r.cost_ratio) < ceiling)
    && r.confirm_verdict !== 'left_out')
    .sort((a, b) => (confirmed(b) - confirmed(a)) || (rank(a) - rank(b)) || (a.cost_month_usd - b.cost_month_usd));
}

/* Whether the second look stood behind a result: it cleared again on calls it had never seen
   ('cleared'), or it is a strategy, whose second look is its live rollout, a small share of the
   calls at a time ('live'). Nothing else is. A result the second look never reached ('not_reached':
   past the models a run looks at twice, or after the run was cut short), one there were too few
   unseen calls for ('insufficient'), one that did not hold up, and a row with nothing written at
   all all wait for a person or the next measurement. Reading nothing as confirmed let a model that
   was never looked at twice sort first, drop "needs a second look" from its workload, and be the
   one an approval with no model named switched to. */
export const confirmed = (r) => (r.confirm_verdict === 'cleared' || r.confirm_verdict === 'live' ? 1 : 0);

/* The outcomes of a finished measurement that found something: it compared models, or it found
   the bar could not be set. A run that was stopped, interrupted or ran out of balance found nothing,
   and is never read as though it had. `r` is the table alias with its dot, or '' for none. */
export const FOUND = (r = '') => `${r}status = 'done' AND ${OUTCOME_OF(r)} IN ('compared', 'unmeasurable', 'refused')`;


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

