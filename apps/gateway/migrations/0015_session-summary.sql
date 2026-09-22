ALTER TABLE "sessions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "summarized_up_to" timestamp with time zone;
