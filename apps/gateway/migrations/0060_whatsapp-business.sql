ALTER TYPE "channel_type" ADD VALUE 'whatsapp-business';
--> statement-breakpoint
CREATE TABLE "meta_bindings" (
  "channel_id" uuid PRIMARY KEY REFERENCES "channels"("id") ON DELETE CASCADE,
  "phone_number_id" text NOT NULL UNIQUE,
  "business_account_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_windows" (
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "chat_id" text NOT NULL,
  "last_inbound" timestamptz NOT NULL,
  PRIMARY KEY ("channel_id", "chat_id")
);
--> statement-breakpoint
CREATE TABLE "meta_inbox" (
  "sequence" bigserial NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("channel_id", "event_id")
);
--> statement-breakpoint
CREATE INDEX "meta_inbox_pending" ON "meta_inbox" ("available_at") WHERE "processed_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "meta_receipts" (
  "chat_id" text NOT NULL,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "remote_id" text NOT NULL,
  "status" text NOT NULL,
  "rank" integer NOT NULL,
  "at" timestamptz NOT NULL,
  PRIMARY KEY ("channel_id", "remote_id")
);
