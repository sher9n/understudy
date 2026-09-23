-- Measurements that can be trusted, and that cost what they are worth.

-- What a run was quoted before it started, so the quote and what it spent can be compared; how many of
-- its bar's answers were the customer's own recorded ones rather than paid replays; what the judge got
-- right on the known pairs it was tested with; and which yardstick it used.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS quote_usd DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS recorded_refs INTEGER;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS judge_check_json TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS yardstick TEXT;

-- The second look before anything is switched: the cheapest model that cleared, measured again on calls
-- it had never seen, and what that found. And the providers that answered for it.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_runs INTEGER;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_gap DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_hi DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_verdict TEXT;
-- the bar the second look was held to: read from both samples' disagreement of the customer's model with itself
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_floor DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS providers_json TEXT;

-- When a workload is next measured by itself. Stretched while re-checks keep confirming what serves,
-- brought forward when something changed: a new model worth trying, a price, a provider.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS recheck_after BIGINT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS recheck_streak INTEGER NOT NULL DEFAULT 0;

-- Whether this workspace's measurement results (which model cleared which kind of workload, never any
-- content) may help other workspaces choose which models to try. Off until the workspace says so.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS share_stats INTEGER NOT NULL DEFAULT 0;
-- The most this workspace wants spent on optimizing in a month, measurements and experiments together.
-- Null follows what each workload is worth.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS optimize_budget_usd DOUBLE PRECISION;
