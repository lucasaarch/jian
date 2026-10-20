-- Poll-based Listening: gateway checks GitHub on a timer; webhooks stay optional.
ALTER TABLE subscriptions
  ADD COLUMN next_poll_at timestamptz,
  ADD COLUMN last_observation jsonb;
--> statement-breakpoint
CREATE INDEX subscriptions_due ON subscriptions (next_poll_at)
WHERE
  enabled;
