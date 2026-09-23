-- Accounts that prove whose they are, and money that cannot be spent twice.

-- An account is only usable once its email address has answered. Accounts made before this was
-- asked are taken as they are: their owners have been using them, and asking now would lock them out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_changed_at BIGINT;
-- set when an account was proved by a sign-in code rather than by its sign-up code: the password typed
-- at sign-up may not have been the owner's, so it no longer works and the owner sets their own
ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_cleared INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- A sign-up code carries the password chosen with it, so the password that takes effect is always
-- the one the person holding the code chose, never one somebody else typed for the same address.
-- A change of address carries the new address the same way.
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS pw_hash TEXT;
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS pw_salt TEXT;
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS new_email TEXT;
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Automatic top up is something a person switches on, with a card, for an amount they choose.
ALTER TABLE billing_accounts ALTER COLUMN auto_topup SET DEFAULT 0;
UPDATE billing_accounts SET auto_topup = 0 WHERE payment_method IS NULL;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS topup_amount_usd DOUBLE PRECISION;
-- the monthly plan's measuring allowance runs in periods from when the plan started
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS allowance_period_start BIGINT;

-- Money set aside for work in flight. A call reserves what it could cost before it is sent and
-- gives back what it did not use once it is answered, so calls arriving together cannot spend
-- more than the balance holds. A hold its process never came back for lapses on its own.
CREATE TABLE IF NOT EXISTS balance_holds (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_usd    DOUBLE PRECISION NOT NULL,
  purpose       TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_holds_ws ON balance_holds(workspace_id, expires_at);

-- Copies of calls are what the customer already paid their own provider. They were recorded as
-- charges until 2026-09-21, which put their provider's bill into "what you paid us".
UPDATE calls SET charged_usd = 0 WHERE source = 'trace' AND charged_usd <> 0;

-- The monthly plan no longer puts a workspace in a mode that refuses routed calls: it is a measuring
-- allowance, and nothing else. Workspaces left in that mode go back to routing.
UPDATE workspaces SET mode = 'route' WHERE mode = 'observe';
