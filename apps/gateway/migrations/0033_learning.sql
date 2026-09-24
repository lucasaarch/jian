-- On by default: an agent reviews its larger turns and keeps what it learned.
ALTER TABLE "profiles" ADD COLUMN "learn_from_work" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- One learning conversation per profile, whatever races to open it.
CREATE UNIQUE INDEX "sessions_learning" ON "sessions" ("profile_id") WHERE "channel" = 'learning';
