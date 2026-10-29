CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"repository_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_profile_id_id" ON "projects" ("profile_id", "id");
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "sessions" SET "is_default" = true WHERE "channel" = 'gateway';
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_profile_fk"
	FOREIGN KEY ("profile_id", "project_id") REFERENCES "projects"("profile_id", "id");
--> statement-breakpoint
DROP INDEX "sessions_gateway";
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_gateway_default" ON "sessions" ("profile_id")
	WHERE "channel" = 'gateway' AND "is_default" = true;
