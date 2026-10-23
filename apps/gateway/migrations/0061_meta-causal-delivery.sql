ALTER TABLE "deliveries" ADD COLUMN "inbound_event_id" text;
--> statement-breakpoint
CREATE INDEX "meta_inbox_head" ON "meta_inbox" ("channel_id", "sequence") WHERE "processed_at" IS NULL;
