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
