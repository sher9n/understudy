-- What each workspace's calls have cost today and this month (days and months in IST), kept on its
-- billing row by every call charge, so a spending limit is checked against one row rather than a
-- month of ledger summed under the account's lock on every call.
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS call_day_start BIGINT;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS call_day_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS call_month_start BIGINT;
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS call_month_usd DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Filled from the ledger for the day and the month in progress, so a limit counts what was spent before
-- this ran. The day starts at midnight IST (UTC+05:30), the month on the 1st in IST.
WITH b AS (
  SELECT (floor((extract(epoch FROM now()) * 1000 + 19800000) / 86400000) * 86400000 - 19800000)::bigint AS day,
         (extract(epoch FROM (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')) * 1000)::bigint AS month
)
UPDATE billing_accounts a SET
  call_day_start = b.day,
  call_month_start = b.month,
  call_day_usd = COALESCE((SELECT -SUM(l.amount_usd) FROM ledger l
                            WHERE l.workspace_id = a.workspace_id AND l.kind = 'call' AND l.created_at >= b.day), 0),
  call_month_usd = COALESCE((SELECT -SUM(l.amount_usd) FROM ledger l
                              WHERE l.workspace_id = a.workspace_id AND l.kind = 'call' AND l.created_at >= b.month), 0)
FROM b;
