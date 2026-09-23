-- Which calls belong to one workload, three ways it used to go wrong.

-- One workload per model the customer names. The same prompt sent to two models is two jobs as far as
-- a measurement goes: each is held to its own model's answers, and a switch for one says nothing about
-- the other. A sibling points at the workload its prompt was first seen in.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS sibling_of TEXT;

-- Several jobs behind one long shared instruction. The instruction the call opens with in its user turn
-- is counted for a workload's first calls, and when two or more such openings each carry a good share of
-- them, each is a job of its own: split_heads lists those openings, and a child workload carries the one
-- it was split for.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS head_key TEXT;
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS split_heads TEXT;

CREATE TABLE IF NOT EXISTS workload_heads (
  workload_id TEXT NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  head_hash   TEXT NOT NULL,
  head_text   TEXT,
  calls       INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (workload_id, head_hash)
);

-- A workload the customer named themselves, with the x-understudy-workload header, keeps that name.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS named_by_customer INTEGER NOT NULL DEFAULT 0;
