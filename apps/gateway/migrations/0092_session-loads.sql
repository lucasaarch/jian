CREATE TABLE "session_loads" (
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "loaded_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone NOT NULL,
  "used_since_compaction" boolean DEFAULT true NOT NULL,
  PRIMARY KEY ("session_id", "kind", "name")
);
