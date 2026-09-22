-- Which job a measurement run belongs to.
--
-- A run that a restart left behind is closed once its heartbeat goes quiet, but the job that
-- started it stayed "claimed", and a claimed job counts as open: pressing Measure now was
-- answered with that dead job, so nothing ran, and scheduled runs of the same workload were
-- blocked the same way until a later boot revived the job and ran a measurement nobody had
-- asked for then. With the job named on the run, closing the run lets go of its job too.
--
-- Named 011a so it runs after 011 and before 012, which is taken by other work in flight.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS job_id TEXT;
CREATE INDEX IF NOT EXISTS ix_runs_job ON eval_runs(job_id);
