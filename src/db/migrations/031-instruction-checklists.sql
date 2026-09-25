-- A written workload's instruction as a list of things any answer can be checked against (src/eval/checklist.js):
-- read once per version of the instruction, and kept, so every measurement and every daily check holds each
-- answer to the same list without paying to read the instruction again.
CREATE TABLE IF NOT EXISTS workload_checklists (
  workload_id      TEXT NOT NULL,
  instruction_hash TEXT NOT NULL,
  items_json       TEXT NOT NULL,
  model            TEXT,
  cost_usd         DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (workload_id, instruction_hash)
);
CREATE INDEX IF NOT EXISTS ix_checklists_workload ON workload_checklists (workload_id, created_at DESC);
