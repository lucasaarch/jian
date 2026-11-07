-- An email channel, received and sent through the owner's Resend account. The live address is
-- kept in its own table rather than a partial index on channels: an enum value added in a
-- migration cannot be used in the same transaction, and the migrator runs them all in one.
ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'email';
--> statement-breakpoint
CREATE TABLE "email_bindings" (
  "channel_id" uuid PRIMARY KEY REFERENCES "channels"("id") ON DELETE CASCADE,
  "address" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "email_threads" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "chat_id" text NOT NULL,
  "subject" text NOT NULL,
  "message_id" text NOT NULL,
  "references" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("channel_id", "chat_id")
);
