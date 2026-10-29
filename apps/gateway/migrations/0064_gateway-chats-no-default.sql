UPDATE "sessions"
SET "title" = NULL
WHERE "channel" = 'gateway' AND "is_default" = true;
--> statement-breakpoint
DROP INDEX "sessions_gateway_default";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "is_default";
