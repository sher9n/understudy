-- Counting requests at the doors anybody can knock on: signing in, asking for codes, signing up,
-- the contact form. Per internet address and per email address, kept for two days at most.
CREATE TABLE IF NOT EXISTS rate_events (
  bucket      TEXT NOT NULL,
  key         TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rate_events ON rate_events(bucket, key, created_at);
