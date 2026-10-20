CREATE TABLE "remote_machines" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "platform" text NOT NULL,
  "token_hash" text NOT NULL,
  "allowed_profile_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "remote_tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "machine_id" uuid NOT NULL REFERENCES "remote_machines"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "command" text NOT NULL,
  "cwd" text,
  "timeout_ms" integer NOT NULL,
  "status" text NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "remote_tasks_pending" ON "remote_tasks" USING btree ("machine_id", "status", "created_at");
