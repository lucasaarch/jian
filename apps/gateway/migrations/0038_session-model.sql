-- A model chosen for one conversation, over the profile's defaults. Null follows the defaults.
ALTER TABLE "sessions" ADD COLUMN "model" jsonb;
