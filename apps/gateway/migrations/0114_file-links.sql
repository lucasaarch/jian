-- A file of the agents' workspace reachable by an unguessable link until it expires or is revoked.
-- Only the token's SHA-256 is stored, so the table cannot be read back into working links.
CREATE TABLE "file_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"session_id" uuid,
	"token_hash" text NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"modified_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_links_token_hash" ON "file_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "file_links_profile_expires" ON "file_links" USING btree ("profile_id","expires_at");
