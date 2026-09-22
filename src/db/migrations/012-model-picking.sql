-- Choosing which models to measure, and remembering what measuring found.
--
-- A measurement used to choose its models by price alone. In the one real run on production,
-- four of the ten it chose never produced an answer: one has no provider that keeps nothing,
-- which every routed call requires, and three think before they answer and ran out of the
-- 180 tokens the customer allows. Everything needed to see that coming is published, and is
-- kept here. Every fact carries the time it was read, because what is true about a model
-- today is not true next month: providers come and go, prices move, speeds change.

-- What a model can do, beyond its headline price.
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS released_at BIGINT;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS params_json TEXT;       -- supported request parameters
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS inputs_json TEXT;       -- text, image, file, audio
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS max_output INTEGER;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS reasoning_json TEXT;    -- whether and how it thinks
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS overrides_json TEXT;    -- long-prompt and time-of-day prices

-- The providers that serve a model and keep nothing, which are the only ones a routed call
-- or a replay can reach. Their prices, their health, and how fast they are.
CREATE TABLE IF NOT EXISTS model_endpoints (
  model_id      TEXT NOT NULL,
  tag           TEXT NOT NULL,
  provider      TEXT NOT NULL,
  price_in      DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_out     DOUBLE PRECISION NOT NULL DEFAULT 0,
  overrides_json TEXT,
  context_len   INTEGER,
  max_output    INTEGER,
  max_prompt    INTEGER,
  params_json   TEXT,
  status        INTEGER,
  uptime_5m     DOUBLE PRECISION,
  uptime_30m    DOUBLE PRECISION,
  uptime_1d     DOUBLE PRECISION,
  ttft_p50      DOUBLE PRECISION,    -- milliseconds to the first token, everyone's traffic, last 30 minutes
  ttft_p90      DOUBLE PRECISION,
  tps_p50       DOUBLE PRECISION,    -- tokens a second once it is writing
  tps_p90       DOUBLE PRECISION,
  speed_at      BIGINT,              -- when the speed figures were read
  synced_at     BIGINT NOT NULL,
  PRIMARY KEY (model_id, tag)
);
CREATE INDEX IF NOT EXISTS ix_endpoints_model ON model_endpoints (model_id);

-- When each kind of fact was last read, so a screen can say how fresh it is and a job knows
-- when it is due.
CREATE TABLE IF NOT EXISTS fact_sync (
  source     TEXT PRIMARY KEY,
  synced_at  BIGINT NOT NULL,
  note       TEXT
);

-- Jev's reading of how well a model suits a workload's task, from the model's own
-- description and a few of the workload's requests. Kept for a while, then asked again.
CREATE TABLE IF NOT EXISTS model_fits (
  model_id   TEXT NOT NULL,
  task_key   TEXT NOT NULL,
  fit        DOUBLE PRECISION NOT NULL,
  detail_json TEXT,
  judged_at  BIGINT NOT NULL,
  PRIMARY KEY (model_id, task_key)
);

-- The public Arena leaderboard (CC BY 4.0), and which of our models each entry is.
CREATE TABLE IF NOT EXISTS arena_ratings (
  name       TEXT PRIMARY KEY,
  organization TEXT,
  rating     DOUBLE PRECISION NOT NULL,
  votes      INTEGER,
  published  TEXT,
  fetched_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS arena_links (
  model_id   TEXT PRIMARY KEY,
  arena_name TEXT,                   -- null: looked for and not on the leaderboard
  how        TEXT NOT NULL,          -- 'name' matched by name, 'jev' chosen by Jev
  linked_at  BIGINT NOT NULL
);

-- Answers already paid for. Replaying the same call on the same model the same way costs
-- the same again and says nothing new, so an answer is kept and used again until it is old
-- enough that the model or its providers may have changed.
CREATE TABLE IF NOT EXISTS replay_cache (
  key         TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL,
  call_id     TEXT,
  slot        INTEGER NOT NULL DEFAULT 0,
  status      INTEGER,
  error       TEXT,
  response_json TEXT,
  latency_ms  INTEGER,
  ttft_ms     INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  provider    TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_replay_cache_model ON replay_cache (model_id, created_at);

-- Verdicts on pairs of answers, so the same two answers are never judged twice.
CREATE TABLE IF NOT EXISTS judge_cache (
  key        TEXT PRIMARY KEY,
  score      DOUBLE PRECISION NOT NULL,
  detail_json TEXT,
  judged_by  TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Every answer a measurement looked at: whose, to which call, how long it took, what it
-- cost, whether it came from an earlier measurement, and what the comparison said. A
-- candidate's answer used to be thrown away once it was scored, so nobody could see why a
-- model failed, only that it had.
CREATE TABLE IF NOT EXISTS eval_replays (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  call_id     TEXT,
  model_id    TEXT NOT NULL,
  slot        INTEGER NOT NULL DEFAULT 0,
  cache_key   TEXT,
  reused      INTEGER NOT NULL DEFAULT 0,
  status      INTEGER,
  error       TEXT,
  failure     TEXT,
  answer      TEXT,
  latency_ms  INTEGER,
  ttft_ms     INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
  score       DOUBLE PRECISION,
  judged_by   TEXT,
  difference  TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_eval_replays_run ON eval_replays (run_id, model_id);

-- What a model did in a measurement, beyond how often it disagreed.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS latency_p50 DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS latency_p90 DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS ttft_p50 DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS ttft_p90 DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS stopped TEXT;          -- why it was dropped early, if it was
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS error_text TEXT;       -- what the provider said, if it refused
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS difference TEXT;       -- how its answers differed, mostly
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS reused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS rank_json TEXT;        -- why it was chosen
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS recipe_json TEXT;      -- how it was asked, e.g. thinking off
-- What it cost on the sampled calls against what the customer's own model cost on the same
-- calls. A list price misses answers that run longer, thinking that is billed, and a private
-- provider that charges more than the headline; this does not, and a month's cost comes from it.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS cost_ratio DOUBLE PRECISION;

-- What a measurement chose, how it judged, and what reusing earlier answers saved.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS plan_json TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS judge TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS reused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS saved_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ref_latency_p50 DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ref_latency_p90 DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ref_ttft_p50 DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ref_ttft_p90 DOUBLE PRECISION;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ref_error TEXT;           -- why the customer's own model refused, if it did

-- How much slower a switched-to model may be, per workload. NULL means worked out from the
-- workload's own traffic. And how a switched-to model has to be asked, which is how it was
-- measured: a model measured with its thinking off is routed with its thinking off.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS speed_pref TEXT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS routed_recipe TEXT;
