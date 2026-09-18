-- How calls are grouped into workloads.
--
-- The old scheme hashed the whole prompt exactly, which fails in both directions at once:
-- a prompt carrying a customer name or a rotating example makes a new workload on every
-- call, and a call with no system prompt has so little left to hash that two unrelated
-- jobs land in the same one. Matching is now structural plus similar, so:

ALTER TABLE workloads ADD COLUMN IF NOT EXISTS struct_key  TEXT;
-- 64 bits as hex, NOT as a number: a 64 bit value does not survive a JS number, and this
-- app parses Postgres int8 into one, so an integer column would silently round it.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS simhash     TEXT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS calls_seen  INTEGER NOT NULL DEFAULT 0;
-- candidate: seen too few times to be worth showing anybody. live: on the screens.
-- merged: folded into another workload, kept so its history still resolves.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS state       TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS merged_into TEXT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS named_at    BIGINT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS name_source TEXT;

CREATE INDEX IF NOT EXISTS ix_workloads_struct ON workloads(workspace_id, struct_key, state);

-- Every exact request shape that has been decided already. The first call of a shape does
-- the similarity work; every call after it is one indexed lookup, which is what keeps this
-- off the hot path of the proxy.
CREATE TABLE IF NOT EXISTS workload_signatures (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  workload_id   TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_wsig_workload ON workload_signatures(workload_id);
