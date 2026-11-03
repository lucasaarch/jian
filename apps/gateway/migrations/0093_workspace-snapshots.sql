CREATE TABLE "workspace_snapshots" (
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "location" text NOT NULL,
  "path" text NOT NULL,
  "content" jsonb NOT NULL,
  "hash" text NOT NULL,
  "read_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("profile_id", "location", "path")
);
