CREATE TABLE "session_artifacts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "type" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "visibility" text DEFAULT 'private' NOT NULL,
  "public_token" text UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_artifacts_session"
  ON "session_artifacts" ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE "session_artifact_versions" (
  "artifact_id" uuid NOT NULL REFERENCES "session_artifacts"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("artifact_id", "version")
);
