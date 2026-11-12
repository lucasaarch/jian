-- Agent reviews of pull requests, asked for in the panel or started by a GitHub webhook. A
-- redelivered webhook must not start a second automatic review of the same head commit.
CREATE TABLE "github_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_reviews" ADD CONSTRAINT "github_reviews_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "github_reviews_pull" ON "github_reviews" USING btree ("repository","number","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "github_reviews_auto_once" ON "github_reviews" USING btree ("repository","number","head_sha") WHERE "github_reviews"."trigger" = 'auto';
