-- What the money and account review found, made safe.

-- A card is only charged automatically when it was saved for that, at a checkout where the customer
-- ticked the box and saw what it means. Every checkout used to save its card, so automatic top up
-- could be switched on for a card Stripe had never been told could be charged later, and the first
-- automatic charge failed. A card already charging automatically keeps doing so.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS card_for_topups INTEGER NOT NULL DEFAULT 0;
UPDATE billing_accounts SET card_for_topups = 1
 WHERE auto_topup = 1 AND payment_method IS NOT NULL AND card_for_topups = 0;

-- The browser that signed up holds a secret, and only a code used from that browser keeps the
-- password chosen there. Anybody else's code signs in and asks for a password, so signing up with
-- somebody else's address can no longer choose their password for them.
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS signup_nonce_hash TEXT;

-- A code for an address with no account, never sent, so that trying a code answers the same way
-- whether or not the address has an account.
ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS decoy INTEGER NOT NULL DEFAULT 0;

-- A call whose cost was worked out from its tokens because the provider did not say, until the
-- provider's own record of it is read and the charge is corrected to that.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cost_estimated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS generation_id TEXT;
