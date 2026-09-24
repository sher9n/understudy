-- Performance first: which of the setups that cleared a workload switches to, and whether it keeps the
-- promise afterwards.
--
-- Each result says how sure the measurement is that the setup's true rate of worse or different answers
-- is inside the pass mark (chance), what it saves times that chance (safe_saving), how often Jev found its
-- answer better than the customer's own model's where the two differed (better_pct), and where it came in
-- the order the run looked at setups again (choice_rank). The run says which routing priority chose, and
-- the ranking it chose from.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS chance DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS safe_saving DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS better_pct DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS choice_rank INTEGER;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS confirm_note TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS routing_mode TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS choice_json TEXT;

-- A workload's routing priority (cautious, balanced or savings), and a workspace's for new workloads.
-- Empty means the workspace's, and then the deployment's (balanced).
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS routing_mode TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS default_routing_mode TEXT;

-- The control group: after a switch, a few answers a day are also asked of the customer's own model in
-- the background, and the served answer is scored against it the way a measurement scores a candidate
-- (0 the same or at least as good, 1 worse or different). A setup whose rate climbs clearly past the pass
-- mark is switched back.
CREATE TABLE IF NOT EXISTS control_checks (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  workload_id    TEXT NOT NULL,
  arm_id         TEXT,
  call_id        TEXT,
  score          DOUBLE PRECISION,
  better         INTEGER NOT NULL DEFAULT 0,
  judged_by      TEXT,
  -- the yardstick it was judged by (agreement or quality): a check is only counted against a pass mark set by the same one
  yardstick      TEXT,
  detail_json    TEXT,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  ref_latency_ms INTEGER,
  status         INTEGER,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS control_checks_workload ON control_checks (workload_id, created_at);
CREATE INDEX IF NOT EXISTS control_checks_arm ON control_checks (arm_id, created_at);
-- what a workspace spent on optimizing, over a window (optimizeSpent, the value history)
CREATE INDEX IF NOT EXISTS control_checks_workspace ON control_checks (workspace_id, created_at);
