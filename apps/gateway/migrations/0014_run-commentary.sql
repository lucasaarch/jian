ALTER TABLE "runs" ADD COLUMN "commentary" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "said_count" integer DEFAULT 0 NOT NULL;
