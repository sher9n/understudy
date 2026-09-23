-- Every price a model and each provider of it publishes, not only the two for text in and text out:
-- a picture or sound written costs more a token than text, and writing a prompt to a cache costs more
-- than reading it plainly. A call's hold (see callBound) has to be able to reach all of them.
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS pricing_json TEXT;
ALTER TABLE model_endpoints ADD COLUMN IF NOT EXISTS pricing_json TEXT;
