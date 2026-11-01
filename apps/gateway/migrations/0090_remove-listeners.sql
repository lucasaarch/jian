-- Each listener's webhook secret goes with it, matched exactly: other secrets may share the prefix.
DELETE FROM "secrets" AS "secret"
USING "subscriptions" AS "listener"
WHERE "secret"."profile_id" = "listener"."profile_id"
  AND "secret"."name" = 'subscription:' || "listener"."id";
--> statement-breakpoint
-- An objective a listener had paused has nothing left to resume it.
UPDATE "sessions"
SET "objective" = ("objective" - 'note') || '{"status":"open","continuations":0}'::jsonb
WHERE "objective"->>'status' = 'blocked'
  AND "objective"->>'note' LIKE 'Waiting for Listening%';
--> statement-breakpoint
DROP TABLE "subscription_deliveries";
--> statement-breakpoint
DROP TABLE "subscriptions";
