-- WhatsApp Business (Meta Cloud API) is no longer a channel. Its channels are disconnected, not
-- deleted: deleting one cascades to its contacts and from them to the media of their
-- conversations. The enum value stays, as Postgres cannot drop one; the gateway reads no row of
-- that type. Every match casts to text, because on a new database 0060 added the value in this
-- same transaction, and a value added there cannot be used as a literal of the type.
--
-- The vault entry each channel kept, matched exactly as revoking one would discard it.
DELETE FROM "secrets" AS "secret"
USING "channels" AS "channel"
WHERE "channel"."type"::text = 'whatsapp-business'
  AND "secret"."profile_id" = "channel"."profile_id"
  AND "secret"."name" = 'channel:' || "channel"."id";
--> statement-breakpoint
UPDATE "deliveries"
SET "status" = 'failed', "error" = 'WhatsApp Business was removed from Jian', "updated_at" = now()
WHERE "status" IN ('pending', 'sending')
  AND "channel_id" IN (SELECT "id" FROM "channels" WHERE "type"::text = 'whatsapp-business');
--> statement-breakpoint
UPDATE "channel_inbox"
SET "status" = 'discarded', "message" = '{}'::jsonb
WHERE "status" = 'pending'
  AND "channel_id" IN (SELECT "id" FROM "channels" WHERE "type"::text = 'whatsapp-business');
--> statement-breakpoint
-- A message held for the owner's approval has no channel left to be answered on.
UPDATE "media_assets"
SET "held" = false
WHERE "contact_id" IN (
  SELECT "contact"."id" FROM "contacts" AS "contact"
  JOIN "channels" AS "channel" ON "channel"."id" = "contact"."channel_id"
  WHERE "channel"."type"::text = 'whatsapp-business'
);
--> statement-breakpoint
UPDATE "contacts"
SET "held_message" = NULL, "held_message_id" = NULL
WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "type"::text = 'whatsapp-business');
--> statement-breakpoint
UPDATE "channels"
SET "revoked_at" = coalesce("revoked_at", now()), "enabled" = false
WHERE "type"::text = 'whatsapp-business';
--> statement-breakpoint
-- Its conversations were WhatsApp conversations, and stay readable among them, titled as one.
UPDATE "sessions"
SET "channel" = 'whatsapp',
  "title" = regexp_replace("title", '^WhatsApp Business \(Meta\) · ', 'WhatsApp · ')
WHERE "channel" = 'whatsapp-business';
--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "inbound_event_id";
--> statement-breakpoint
DROP TABLE "meta_receipts";
--> statement-breakpoint
DROP TABLE "meta_inbox";
--> statement-breakpoint
DROP TABLE "meta_windows";
--> statement-breakpoint
DROP TABLE "meta_bindings";
