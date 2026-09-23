-- The measurement engine, keeping its word.

-- Several jobs behind one shared instruction: the job that stays with the workload it was first seen
-- in, once the others have been told apart and given workloads of their own. Set once, at the first
-- split. A later look at the openings can split more jobs away, but never this one, and never takes
-- back a split it made: a job split away and then counted no longer could fall under the cut and
-- return to the parent, riding a switch that was measured on a different job.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS own_head TEXT;
