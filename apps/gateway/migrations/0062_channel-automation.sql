ALTER TABLE "channels" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "automation_paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "source_run_id" uuid REFERENCES "runs"("id") ON DELETE CASCADE;
