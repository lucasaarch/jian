-- A schedule may name no conversation: each time it runs, it opens a new chat of the panel and
-- runs there. The conversations it already names keep it.
ALTER TABLE "schedules" ALTER COLUMN "session_id" DROP NOT NULL;
--> statement-breakpoint
-- When the owner last read a chat of the panel, so the list marks one the agent wrote in since.
-- Every conversation that exists counts as read: nothing written before this is news.
ALTER TABLE "sessions" ADD COLUMN "read_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "sessions" SET "read_at" = now();
--> statement-breakpoint
-- The browsers and installed apps the owner allowed to show notifications, one row each. A push
-- service hands out the endpoint and the keys; nothing in them identifies the owner.
CREATE TABLE "push_subscriptions" (
  "endpoint" text PRIMARY KEY,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A conversation on Auto acts unless a guardrail finds the action catastrophic. The chats a
-- schedule opens start on it, since nobody is there to approve at the hour they run.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_protection";
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_protection" CHECK ("protection" IN ('ask', 'auto', 'full'));
