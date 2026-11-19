-- A vendor may hold several accounts (two Claude plans, a work and a personal OpenAI key), and runs
-- use the one marked active. Every live row was the only one of its vendor and mode, so each
-- starts active and named "Account 1"; the old index, one live row per vendor and mode, gives way
-- to one active live row per vendor and mode. Written to run again over itself, so a test can
-- replay it on rows made the old way.
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
UPDATE "providers" SET "label" = 'Account 1' WHERE "label" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "providers_live_per_kind_auth";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "providers_active_per_kind_auth" ON "providers" USING btree ("kind", coalesce("auth_mode", 'api')) WHERE "revoked_at" IS NULL AND "active";
