-- Take OpenRouter's own routing products back out of the catalogue.
--
-- They are not models: they pick one for you at call time. They are also listed at a price
-- of MINUS two million, which is presumably a sentinel meaning "it depends", and which made
-- them win every "cheapest model" query on the platform by a margin nothing could beat. So
-- the test call and, worse, the job that NAMES a customer's workloads were both being run by
-- a router. That is how a workload full of poetry came to be called log-message-request.
--
-- They were excluded from new syncs already, but the sync only ever inserted and updated, so
-- the rows synced before that fix stayed. This removes them, and anything else that cannot
-- be priced, which is the same thing said as a rule rather than a list.
DELETE FROM models_catalog WHERE price_in <= 0 OR price_out <= 0;
DELETE FROM workspace_models WHERE model_id NOT IN (SELECT model_id FROM models_catalog);
