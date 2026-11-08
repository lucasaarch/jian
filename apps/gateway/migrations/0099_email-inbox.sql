-- What an email channel received and sent, for the agent to search: the mail is otherwise spread
-- over conversations, held messages and deliveries, none of them keyed by address.
CREATE TABLE "email_log" (
  "id" uuid PRIMARY KEY,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "address" text NOT NULL,
  "subject" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "email_log_recent" ON "email_log" ("profile_id", "created_at" DESC);
--> statement-breakpoint
-- A short wait for mail from a service the agent signed up to, for the conversation that did.
CREATE TABLE "email_windows" (
  "id" uuid PRIMARY KEY,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "reason" text NOT NULL,
  "received" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_windows_per_session" ON "email_windows" ("session_id", "domain");
--> statement-breakpoint
CREATE INDEX "email_windows_open" ON "email_windows" ("channel_id", "domain", "expires_at");
