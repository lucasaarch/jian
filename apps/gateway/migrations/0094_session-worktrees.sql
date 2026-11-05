CREATE TABLE "session_worktrees" (
  "id" uuid PRIMARY KEY NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "branch" text NOT NULL,
  "base" text NOT NULL,
  "source" text NOT NULL,
  "path" text NOT NULL,
  "place" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_worktrees_source"
  ON "session_worktrees" ("session_id", "source") WHERE "removed_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "session_worktrees_name"
  ON "session_worktrees" ("session_id", "name") WHERE "removed_at" is null;
--> statement-breakpoint
CREATE INDEX "session_worktrees_active_source"
  ON "session_worktrees" ("source") WHERE "removed_at" is null;
