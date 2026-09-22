-- Stopping a measurement, and saying what a finished one found.
--
-- A run was a loop nobody could interrupt. Once it started it replayed every sampled call on
-- every model, and the only way to end it early was to restart the server, which left the row
-- saying "running" for ever: the page showed a progress bar that never moved, and Measure now
-- refused to start another. A stop is now a request written here, which the run reads between
-- calls, and a heartbeat tells a run that is merely slow apart from one nothing is running.
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS stop_requested_at BIGINT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS stopped_by TEXT;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS heartbeat_at BIGINT;

-- What a finished run found, as a word rather than an error sentence, so the page can say why
-- a measurement has nothing to compare without matching on the wording of a message:
--   compared      at least one model was tried to the end
--   unmeasurable  the customer's own model disagreed with itself too often to set a bar
--   no_balance    the balance ran out once the bar was set, before any model was tried
--   stopped       somebody stopped it
--   interrupted   the process running it went away, usually a restart or a deploy
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS outcome TEXT;

-- The runs that finished before this existed. Their error sentences were written by the same
-- code that now writes the word, so they map one to one. A row still saying "running" is left
-- alone: this runs at boot, and during a deploy the old process may still be running it. The
-- heartbeat check closes it once nothing is.
UPDATE eval_runs SET outcome = CASE
    WHEN status = 'failed' THEN 'interrupted'
    WHEN error LIKE 'reference disagreed with itself%' THEN 'unmeasurable'
    WHEN error = 'balance ran out after the bar was set' THEN 'no_balance'
    ELSE 'compared' END
 WHERE outcome IS NULL AND status IN ('done', 'failed');
