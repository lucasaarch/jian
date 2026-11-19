-- Flash memories: kept like any other until expires_at, then never read again and deleted.
ALTER TABLE "memories" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "memories_expiring" ON "memories" USING btree ("profile_id","expires_at") WHERE "memories"."expires_at" IS NOT NULL;
