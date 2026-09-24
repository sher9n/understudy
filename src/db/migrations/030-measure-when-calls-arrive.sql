-- A measurement nobody asked for that was turned down only because the workload had too few calls to show
-- anything waits for its calls, not for a time: this is how many usable calls it needs, counted the way the
-- plan counts them (its own, from the last thirty days, at most EVAL_POOL_PER_DAY a day). The call that brings
-- the count to it starts the measurement (measureWhenReady in src/proxy.js). Null when it waits for nothing.
ALTER TABLE workloads ADD COLUMN IF NOT EXISTS measure_at_calls INTEGER;
