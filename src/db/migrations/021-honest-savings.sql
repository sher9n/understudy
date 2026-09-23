-- Savings counted the way the customer would count them.

-- What a model charges for prompt tokens a provider already has cached, where it says: a saving that
-- priced the customer's own model at full price for tokens it would have had cached overstated itself.
ALTER TABLE models_catalog ADD COLUMN IF NOT EXISTS price_cache_read DOUBLE PRECISION;

-- How many of a call's prompt tokens the provider had cached, where it says.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cached_tokens INTEGER;

-- Whether we marked the call's long instruction for the provider to cache (see src/openrouter.js):
-- a saving of ours, counted as one, where a cache the customer set up themselves is not.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hinted INTEGER;

-- Whether a workspace lets us mark long instructions for caching. On unless it says otherwise.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS cache_hints INTEGER NOT NULL DEFAULT 1;
