CREATE TABLE "artifact_folders" (
  "id" uuid PRIMARY KEY NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifact_folders_profile"
  ON "artifact_folders" ("profile_id", "name");
--> statement-breakpoint
ALTER TABLE "session_artifacts" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_artifacts"
  ADD COLUMN "folder_id" uuid REFERENCES "artifact_folders"("id") ON DELETE set null;
