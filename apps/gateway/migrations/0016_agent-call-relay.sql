ALTER TABLE "runs" ADD COLUMN "relay_to" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_relay_to_sessions_id_fk" FOREIGN KEY ("relay_to") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
