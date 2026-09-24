-- Whether a channel conversation is with one person or a group, kept on the conversation
-- itself: a group is still one after its contact is gone.
ALTER TABLE "sessions" ADD COLUMN "scope" text;
--> statement-breakpoint
UPDATE "sessions" AS s SET "scope" = c."scope"::text FROM "contacts" AS c WHERE c."session_id" = s."id";
--> statement-breakpoint
-- Groups whose contact went with an earlier connection were titled as groups when they opened.
UPDATE "sessions" SET "scope" = 'group' WHERE "scope" IS NULL AND "title" LIKE '% · Grupo %';
--> statement-breakpoint
-- The app speaks English: the group marker leaves the titles, and the old agent prefix is renamed.
UPDATE "sessions" SET "title" = replace("title", ' · Grupo ', ' · ') WHERE "title" LIKE '% · Grupo %';
--> statement-breakpoint
UPDATE "sessions" SET "title" = 'Agent · ' || substr("title", 10) WHERE "title" LIKE 'Agente · %';
