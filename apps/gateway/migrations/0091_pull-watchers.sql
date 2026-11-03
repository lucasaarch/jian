CREATE TABLE "pull_watchers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE cascade,
  "owner" text NOT NULL,
  "repo" text NOT NULL,
  "number" integer NOT NULL,
  "status" text NOT NULL,
  "ended_reason" text,
  "state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "own_shas" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "next_poll_at" timestamp with time zone NOT NULL,
  "failing_since" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_watchers_pull"
  ON "pull_watchers" ("profile_id", lower("owner"), lower("repo"), "number");
--> statement-breakpoint
CREATE INDEX "pull_watchers_due" ON "pull_watchers" ("next_poll_at") WHERE "status" = 'watching';
--> statement-breakpoint
CREATE INDEX "pull_watchers_session" ON "pull_watchers" ("session_id");
