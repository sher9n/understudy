-- Signing in without a password.
--
-- One row backs BOTH the magic link and the four-digit code in the same email: they are two
-- ways to spend one token, so using either consumes both. Neither the link token nor the
-- code is stored in the clear, for the same reason a password is not: a leaked database
-- should not hand anybody a working sign-in.
--
-- Four digits is only ten thousand combinations, so `attempts` is what makes this safe
-- rather than the length. The row is spent after a handful of wrong guesses and cannot be
-- retried; asking for a new code costs another email and is rate limited separately.

CREATE TABLE IF NOT EXISTS login_codes (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,          -- sha256 of the four digits, salted with the id
  link_hash     TEXT NOT NULL UNIQUE,   -- sha256 of the token in the emailed link
  purpose       TEXT NOT NULL DEFAULT 'sign_in',
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed_at   BIGINT,
  requested_ip  TEXT,
  expires_at    BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_login_codes_email ON login_codes(email, created_at DESC);
