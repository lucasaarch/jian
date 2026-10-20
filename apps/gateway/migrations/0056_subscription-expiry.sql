-- Listening TTL: every subscription expires; no infinite watch by default.
ALTER TABLE subscriptions
  ADD COLUMN expires_at timestamptz;
--> statement-breakpoint
-- Existing rows get one more hour so an upgrade mid-CI does not drop the watch instantly.
UPDATE subscriptions
SET
  expires_at = NOW() + INTERVAL '1 hour'
WHERE
  expires_at IS NULL;
--> statement-breakpoint
ALTER TABLE subscriptions
  ALTER COLUMN expires_at
  SET NOT NULL;
