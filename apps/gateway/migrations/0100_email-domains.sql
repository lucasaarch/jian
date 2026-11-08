-- `expect_email` no longer opens a 30-minute wait for the conversation that called it: it names a
-- service domain the agent expects mail from, for 30 days, one per channel and domain, whose
-- automatic mail is kept in an email conversation of its own. A wait still open keeps the time it
-- had left; it no longer points at the conversation that asked.
ALTER TABLE "email_windows" RENAME TO "email_domains";
--> statement-breakpoint
ALTER TABLE "email_domains" DROP CONSTRAINT "email_windows_session_id_fkey";
--> statement-breakpoint
ALTER TABLE "email_domains" ALTER COLUMN "session_id" DROP NOT NULL;
--> statement-breakpoint
UPDATE "email_domains" SET "session_id" = NULL;
--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- The count capped how much one wait brought into a turn; automatic mail starts no turn now.
ALTER TABLE "email_domains" DROP COLUMN "received";
--> statement-breakpoint
DROP INDEX "email_windows_per_session";
--> statement-breakpoint
DROP INDEX "email_windows_open";
--> statement-breakpoint
-- Two conversations may have waited on the same domain; the one that lasts longer stays.
DELETE FROM "email_domains" AS "older" USING "email_domains" AS "newer"
WHERE "older"."channel_id" = "newer"."channel_id"
  AND "older"."domain" = "newer"."domain"
  AND ("older"."expires_at", "older"."id") < ("newer"."expires_at", "newer"."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_per_channel" ON "email_domains" ("channel_id", "domain");
