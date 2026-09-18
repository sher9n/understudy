-- Showing a customer their own key.
--
-- Only a hash was kept, so a key could be shown once and never again. That is the stricter
-- posture, and it is the wrong trade here: the key is the single thing a customer needs off
-- this screen, and a page that shows eight characters of it and a Copy button hands over
-- something that cannot authenticate.
--
-- The key is now also kept ENCRYPTED, so the app can show it and a copy of the database on
-- its own cannot. Decrypting needs KEY_SECRET, which lives in the environment and never in
-- here. The hash stays and is still what authentication looks up, so that path is unchanged
-- and no slower.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS secret_enc TEXT;
