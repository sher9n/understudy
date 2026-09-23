-- Every provider of a model, not only those that keep nothing: for a workspace that allows providers
-- keeping data briefly, a call can reach any of them, so the most it can cost is the dearest of them and
-- the longest answer any of them writes. Read from OpenRouter per model when a call first needs it, and
-- kept for a few hours. model_endpoints_all_sync says when a model was last read, and whether it worked.
CREATE TABLE IF NOT EXISTS model_endpoints_all (
  model_id       TEXT NOT NULL,
  tag            TEXT NOT NULL,
  provider       TEXT,
  price_in       DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_out      DOUBLE PRECISION NOT NULL DEFAULT 0,
  overrides_json TEXT,
  pricing_json   TEXT,
  context_len    INTEGER,
  max_output     INTEGER,
  synced_at      BIGINT NOT NULL,
  PRIMARY KEY (model_id, tag)
);
CREATE TABLE IF NOT EXISTS model_endpoints_all_sync (
  model_id  TEXT PRIMARY KEY,
  synced_at BIGINT NOT NULL,
  ok        INTEGER NOT NULL DEFAULT 0
);
