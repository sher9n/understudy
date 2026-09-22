-- Learning from what happens next: every call's place in a task, how it was decided, and how it
-- turned out. IF NOT EXISTS everywhere, so it can be applied again safely.

-- each call: the customer's own reference for it, its fingerprints, its place in a task, the
-- strategy that served it and the chance that strategy had, and how well it worked once known
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS before_hash TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS after_hash TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_call_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS task_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS step INTEGER;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS arm_id TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS propensity DOUBLE PRECISION;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS explored INTEGER;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS escalated INTEGER;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS check_json TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reward DOUBLE PRECISION;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS reward_json TEXT;
CREATE INDEX IF NOT EXISTS ix_calls_ws_request ON calls (workspace_id, request_hash, created_at);
CREATE INDEX IF NOT EXISTS ix_calls_ws_after ON calls (workspace_id, after_hash);
CREATE INDEX IF NOT EXISTS ix_calls_task ON calls (task_id, created_at);
CREATE INDEX IF NOT EXISTS ix_calls_ws_ref ON calls (workspace_id, ref, created_at);
CREATE INDEX IF NOT EXISTS ix_calls_arm ON calls (arm_id, created_at);

-- what happened after a call: read from the traffic that followed it, or reported by the customer
CREATE TABLE IF NOT EXISTS outcomes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id   TEXT,
  call_id       TEXT,
  task_id       TEXT,
  kind          TEXT NOT NULL,   -- retry | broken | cut_off | refused | tool_error | tool_ok | correction | continued | reported
  event         TEXT NOT NULL DEFAULT '',  -- a reported event's own name, e.g. resolved; empty for a signal
  value         DOUBLE PRECISION, -- 1 worked, 0 did not; null for a reported event nobody has said the meaning of yet
  source        TEXT NOT NULL,   -- seen | reported
  detail_json   TEXT,
  occurred_at   BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outcomes_once ON outcomes (call_id, kind, event);
CREATE INDEX IF NOT EXISTS ix_outcomes_workload ON outcomes (workload_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_outcomes_ws ON outcomes (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_outcomes_task ON outcomes (task_id);

-- what "worked" means for one workload: which reported events say so, and which signals count
CREATE TABLE IF NOT EXISTS outcome_defs (
  workload_id   TEXT PRIMARY KEY REFERENCES workloads(id) ON DELETE CASCADE,
  events_json   TEXT,            -- [{ "event": "resolved", "means": "worked" | "failed" }]
  signals_json  TEXT,            -- { "retry": true, "broken": true, ... } which signals read from traffic count
  window_days   INTEGER,         -- how long after a call a reported event still belongs to it
  updated_at    BIGINT NOT NULL
);

-- the ways a workload's calls can be served: one model, or a cheap model checked and sent on
-- when unsure, or a choice made call by call. What was measured about each, and what is learned
CREATE TABLE IF NOT EXISTS arms (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id   TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- model | cascade | router
  key           TEXT NOT NULL,   -- one per strategy per workload: the same strategy found again is the same arm
  spec_json     TEXT NOT NULL,
  label         TEXT NOT NULL,
  status        TEXT NOT NULL,   -- serving | trying | shadow | resting | retired
  origin_run_id TEXT,
  offline_json  TEXT,
  stats_json    TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_arms_key ON arms (workload_id, key);
CREATE INDEX IF NOT EXISTS ix_arms_workload ON arms (workload_id, status);

-- one task: calls that continue one conversation or one agent's loop, step by step
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  first_call_id  TEXT NOT NULL,
  last_call_id   TEXT NOT NULL,
  steps          INTEGER NOT NULL DEFAULT 1,
  workloads_json TEXT,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  tool_errors    INTEGER NOT NULL DEFAULT 0,
  retries        INTEGER NOT NULL DEFAULT 0,
  corrections    INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms     BIGINT NOT NULL DEFAULT 0,
  outcome        DOUBLE PRECISION,
  started_at     BIGINT NOT NULL,
  ended_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_ws ON tasks (workspace_id, ended_at DESC);

-- a workload's serving strategy, and how much it may experiment
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS routed_arm_id TEXT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS explore_mode TEXT;          -- off | shadow | careful | normal; null follows the optimize mode
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS explore_budget_usd DOUBLE PRECISION;  -- a day

-- answers a runner-up gave in the background to live calls, never seen by anybody, and how
-- closely each matched the answer that was used
CREATE TABLE IF NOT EXISTS shadow_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id   TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  arm_id        TEXT NOT NULL,
  call_id       TEXT,
  agreement     DOUBLE PRECISION, -- 1 the same answer, 0 a different one or none; null when it says nothing
  cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms    BIGINT,
  status        INTEGER,
  detail_json   TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shadow_workload ON shadow_runs (workload_id, created_at);
CREATE INDEX IF NOT EXISTS ix_shadow_arm ON shadow_runs (arm_id, created_at);

-- a measured strategy that is not a single model, and how often it sent a call on
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS arm_json TEXT;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS escalated_pct DOUBLE PRECISION;
