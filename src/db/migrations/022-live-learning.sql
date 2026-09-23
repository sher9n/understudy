-- Live learning that can be trusted, and switches that start small.

-- Calls a grader read in the background: whether it found the answer wrong, how sure it was, who read
-- it and what that cost. A few of each strategy's fair calls a day, so strategies can be compared on
-- what is right rather than only on what was seen to fail, and so how often a failure goes unseen can
-- be estimated.
CREATE TABLE IF NOT EXISTS graded_calls (
  call_id      TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id  TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  arm_id       TEXT,
  bad          INTEGER NOT NULL,
  p            DOUBLE PRECISION,
  judged_by    TEXT,
  cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_graded_workload ON graded_calls (workload_id, created_at DESC);

-- A switch in progress serves only a share of the calls, and the rest stay with what served before it.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS rollout_from_arm_id TEXT;
