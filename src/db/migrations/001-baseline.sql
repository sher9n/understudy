-- Understudy, on Postgres.
--
-- Ported from the SQLite baseline this app shipped on. Two deliberate differences: every
-- timestamp is BIGINT, because they are epoch milliseconds and would overflow a 4-byte
-- integer, and REAL became DOUBLE PRECISION so money keeps its precision. Booleans stay
-- as INTEGER 0/1, which is what the application code already reads.

-- Accounts and the workspace each one owns -----------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  pw_hash       TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'route',      -- route | observe
  -- days of call content to keep. 0 MEANS KEEP INDEFINITELY, which is a real choice a
  -- customer makes on Settings, not an accident.
  retention_days INTEGER NOT NULL DEFAULT 30,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ws_owner ON workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                   -- sha256 of the cookie value
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- The key a customer puts in their client ------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'production',
  key_hash      TEXT NOT NULL UNIQUE,               -- sha256 of the whole key
  prefix        TEXT NOT NULL,                      -- us_live_ + first 4, for display
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT,
  revoked_at    BIGINT
);
CREATE INDEX IF NOT EXISTS ix_keys_ws ON api_keys(workspace_id);

-- Traffic ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workloads (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  shape_kind      TEXT NOT NULL,                    -- tool_call | json | enum | free_text
  reference_model TEXT,                             -- the bar is measured against this
  routed_model    TEXT,                             -- what the proxy substitutes today
  optimize_mode   TEXT NOT NULL DEFAULT 'auto',     -- auto | ask
  status          TEXT NOT NULL DEFAULT 'new',      -- new|measuring|certified|promoted|no_match
  status_note     TEXT,
  floor_pct       DOUBLE PRECISION,
  promoted_at     BIGINT,
  promoted_run_id TEXT,
  sample_prompt   TEXT,
  tool_names      TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_workloads_ws ON workloads(workspace_id);

CREATE TABLE IF NOT EXISTS calls (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id     TEXT REFERENCES workloads(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,                    -- routed | trace | replay
  requested_model TEXT,
  served_model    TEXT,
  status_code     INTEGER,
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,          -- what the provider charged us
  charged_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,          -- what the customer paid, fee included
  latency_ms      INTEGER,
  request_json    TEXT,
  response_json   TEXT,
  content_purged_at BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_calls_ws_time ON calls(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS ix_calls_workload ON calls(workload_id, created_at);

CREATE TABLE IF NOT EXISTS activity (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id   TEXT REFERENCES workloads(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,                      -- connect|ok|bad|floor|revert|bill|run
  title         TEXT NOT NULL,
  detail        TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_activity_ws ON activity(workspace_id, created_at DESC);

-- Models ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS models_catalog (
  model_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  context_len   INTEGER,
  price_in      DOUBLE PRECISION NOT NULL DEFAULT 0,            -- USD per token
  price_out     DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_weights  INTEGER NOT NULL DEFAULT 0,
  zdr           INTEGER NOT NULL DEFAULT 0,
  synced_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_models (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, model_id)
);

-- Measurement -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS eval_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workload_id   TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',     -- queued|running|done|failed|paused_billing
  shape_kind    TEXT NOT NULL,
  reference_model TEXT NOT NULL,
  sample_size   INTEGER NOT NULL DEFAULT 0,
  floor_pct     DOUBLE PRECISION,
  noise_pct     DOUBLE PRECISION,
  error         TEXT,
  spend_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at    BIGINT,
  finished_at   BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_runs_workload ON eval_runs(workload_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_samples (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  call_id       TEXT NOT NULL,
  quartile      INTEGER NOT NULL DEFAULT 0,
  ref_a_json    TEXT,
  ref_b_json    TEXT,
  charged       INTEGER NOT NULL DEFAULT 0,
  content_purged_at BIGINT
);
CREATE INDEX IF NOT EXISTS ix_samples_run ON eval_samples(run_id);

CREATE TABLE IF NOT EXISTS eval_results (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  runs          INTEGER NOT NULL DEFAULT 0,         -- replays that actually happened
  gap_pct       DOUBLE PRECISION,                               -- disagreement with the reference
  cost_month_usd DOUBLE PRECISION,
  verdict       TEXT,                               -- cleared|review|missed|insufficient
  gate_structure INTEGER NOT NULL DEFAULT 0,
  gate_accuracy  INTEGER NOT NULL DEFAULT 0,
  gate_coverage  INTEGER NOT NULL DEFAULT 0,
  gate_complete  INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  UNIQUE (run_id, model_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id            TEXT PRIMARY KEY,
  workload_id   TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,                      -- promote|revert|auto_revert
  from_model    TEXT,
  to_model      TEXT,
  reason        TEXT,
  run_id        TEXT,
  actor_user_id TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_promotions_workload ON promotions(workload_id, created_at DESC);

-- Money ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_accounts (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  balance_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  stripe_customer   TEXT,
  payment_method    TEXT,
  card_brand        TEXT,
  card_last4        TEXT,
  auto_topup        INTEGER NOT NULL DEFAULT 1,
  topup_failed_note TEXT,
  plan              TEXT,                            -- observe subscription id
  plan_status       TEXT,
  eval_used_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                       -- call|eval|credit|starter|refund
  amount_usd    DOUBLE PRECISION NOT NULL,                       -- negative is a charge
  balance_after DOUBLE PRECISION NOT NULL,
  note          TEXT,
  ref           TEXT UNIQUE,                         -- the Stripe object, where there is one
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_ws ON ledger(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

-- Background work ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                       -- eval_run|catalog_sync|purge|topup
  payload       TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',      -- queued|claimed|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     BIGINT NOT NULL,
  claimed_at    BIGINT,
  error         TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_jobs_ready ON jobs(status, run_after);
