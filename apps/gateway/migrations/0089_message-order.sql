ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;
--> statement-breakpoint
UPDATE "messages" AS "message"
SET "seq" = "ordered"."position"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "position" FROM "messages"
) AS "ordered"
WHERE "message"."id" = "ordered"."id";
--> statement-breakpoint
SELECT setval(
  pg_get_serial_sequence('messages', 'seq'),
  COALESCE(MAX("seq"), 1),
  MAX("seq") IS NOT NULL
) FROM "messages";
