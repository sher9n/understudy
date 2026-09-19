-- An event is "seen" the moment it arrives, but it is only DONE once the work succeeded.
--
-- The dedupe wrote the event id before doing the work and the handler answered 500 when the
-- work threw. Stripe then retried, the retry matched the id, and the event was skipped as a
-- duplicate. A transient database blip therefore lost a payment permanently. Splitting the
-- two makes a retry do what a retry is for.
ALTER TABLE stripe_events ADD COLUMN IF NOT EXISTS handled_at BIGINT;

-- Everything already recorded ran to completion under the old code, or it would not be here.
UPDATE stripe_events SET handled_at = created_at WHERE handled_at IS NULL;
