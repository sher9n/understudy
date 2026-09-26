-- What a test costs, said before it runs and held to while it runs (26 Sep 2026).
--
-- A test's quote as people see it, our fee included: what it is expected to cost ("about"), from the raw estimate
-- (quote_usd) corrected by how far recent tests ran over theirs, and the most it may spend ("at most"), which is where
-- it stops. Null on tests from before.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS quote_about_usd DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS cap_usd DOUBLE PRECISION;
-- The money a running test sets aside on the balance (balance_holds), given back when it ends, and by the closer of a
-- test nothing is running any more.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS hold_id TEXT;

-- The testing limit: the most tests and checks may spend in any thirty days. A workspace that has not set one has the
-- default (TESTING_LIMIT_DEFAULT_USD); 1 here is a workspace that chose no limit at all.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS optimize_budget_none INTEGER NOT NULL DEFAULT 0;

-- Why the last test nobody asked for did not run, so the page says so rather than a date: JSON
-- { reason, text, at }, cleared when a test runs.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS test_skip_json TEXT;
