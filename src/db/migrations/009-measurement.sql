-- How often a workspace measures itself, and how many models a run tries.
--
-- Both were fixed numbers in the code. The interval could not be changed at all and the
-- model count was whatever the six cheapest happened to be, which is not a shortlist, it is
-- the bottom of the catalogue.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS measure_every_days INTEGER;  -- 0 means never
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS eval_models INTEGER;

-- What a run is doing while it runs.
--
-- A run is hundreds of model calls over several minutes and the screen had no way to say so:
-- somebody pressed Measure now and watched a page that never changed. A run is a countable
-- number of replays, so it counts them.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS steps_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS steps_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS models_planned INTEGER NOT NULL DEFAULT 0;

-- A run left mid-flight by a restart is finished, not running for ever.
UPDATE eval_runs SET status = 'failed', error = COALESCE(error, 'interrupted'), finished_at = started_at
 WHERE status = 'running';
