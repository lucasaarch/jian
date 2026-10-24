CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "team_members_team_id_profile_id_pk" PRIMARY KEY("team_id", "profile_id")
);
--> statement-breakpoint
CREATE INDEX "team_members_profile" ON "team_members" USING btree ("profile_id", "team_id");
