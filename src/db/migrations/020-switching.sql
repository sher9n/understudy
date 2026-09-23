-- Switching that a person stays in charge of, that starts small, and that tells them.

-- How a new workload in this workspace is switched: 'ask' (a person approves each switch), 'auto', or
-- 'off'. Null reads as 'ask': nothing is switched before somebody has seen it clear. Workloads that
-- exist already keep the mode they have.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS default_optimize_mode TEXT;
-- Workspaces that exist today keep switching the way they always have; only new ones start by asking.
UPDATE workspaces SET default_optimize_mode = 'auto' WHERE default_optimize_mode IS NULL;

-- A switch starts on a share of the workload's calls and grows while its live calls hold up: the share
-- it is on now, which step of the way it is at, when that step started, and when it may take the next.
-- Null share means every call.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS rollout_share DOUBLE PRECISION;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS rollout_stage INTEGER;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS rollout_started_at BIGINT;

-- The most a workspace's calls may cost through us in a day, and in a month, before we refuse them.
-- Null is no limit beyond the balance.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS daily_limit_usd DOUBLE PRECISION;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS monthly_limit_usd DOUBLE PRECISION;

-- Which emails the workspace wants: a switch made, a switch taken back, a candidate waiting for
-- approval, balance running low. Null is the default set (all of them).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS notify_json TEXT;

-- Emails sent, so one event is told once and a burst of them is folded into one message.
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  ref          TEXT,
  sent_to      TEXT,
  subject      TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  created_at   BIGINT NOT NULL,
  sent_at      BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_once ON notifications (workspace_id, kind, ref);
CREATE INDEX IF NOT EXISTS ix_notifications_ws ON notifications (workspace_id, created_at DESC);
