DELETE FROM "model_defaults" WHERE "role" IN ('voice', 'speech');
--> statement-breakpoint
ALTER TABLE "model_defaults" DROP COLUMN "voice_name";
