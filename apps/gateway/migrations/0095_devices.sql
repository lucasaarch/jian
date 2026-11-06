CREATE TABLE "devices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "platform" text NOT NULL,
  "token_hash" text NOT NULL,
  "push_token" text,
  "previews" boolean DEFAULT true NOT NULL,
  "focused_session" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash" ON "devices" ("token_hash");
--> statement-breakpoint
CREATE TABLE "device_pairings" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);
