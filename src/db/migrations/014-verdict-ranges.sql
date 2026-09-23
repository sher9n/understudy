-- Verdicts that say how sure they are: where the true gap most likely is (a one-sided 95% range),
-- and how many calls a bar this size needs before anything can be said. Moved out of 013, which
-- had already shipped when these were first written into it.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS gap_lo DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS gap_hi DOUBLE PRECISION;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS calls_needed INTEGER;
