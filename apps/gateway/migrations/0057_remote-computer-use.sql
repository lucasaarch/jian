ALTER TABLE "remote_machines" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "remote_tasks" ADD COLUMN "kind" text DEFAULT 'shell' NOT NULL;
--> statement-breakpoint
ALTER TABLE "remote_tasks" ADD COLUMN "payload" jsonb;
--> statement-breakpoint
UPDATE "profiles" SET "allow_shell" = true;
--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "allow_shell" SET DEFAULT true;
