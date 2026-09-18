-- Two corrections to how a call finds its workload.
--
-- The exact-match cache was keyed on the OLD fingerprint, which hashes the system prompt.
-- A call with no system prompt has almost nothing in it, so unrelated jobs collided there
-- and were merged before the similarity check ever ran. The key is now the structure and
-- the normalised instruction together, which cannot collapse two different instructions.
--
-- And a workload used to be compared only against the one sample it was created from, so a
-- later variant that drifted from that single point started a second workload of the same
-- job. Every accepted variant now carries its own signature, and a call joins a workload if
-- it is close to ANY of them.

ALTER TABLE workload_signatures ADD COLUMN IF NOT EXISTS simhash    TEXT;
ALTER TABLE workload_signatures ADD COLUMN IF NOT EXISTS struct_key TEXT;
CREATE INDEX IF NOT EXISTS ix_wsig_struct ON workload_signatures(workspace_id, struct_key);
