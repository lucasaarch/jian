-- The stickers an agent has seen, kept once each, to send again.
CREATE TABLE "stickers" (
  "id" uuid PRIMARY KEY,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "hash" text NOT NULL,
  "data" text NOT NULL,
  "description" text,
  "uses" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stickers_hash" ON "stickers" ("profile_id", "hash");
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "sticker" boolean NOT NULL DEFAULT false;
