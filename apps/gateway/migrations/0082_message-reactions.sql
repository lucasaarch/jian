ALTER TABLE "messages" ADD COLUMN "reactions" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel_message" jsonb;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reaction" jsonb;
