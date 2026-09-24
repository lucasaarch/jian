-- Groq, and any server that speaks the OpenAI API — a Whisper the owner runs, for one.
ALTER TYPE "provider_kind" ADD VALUE IF NOT EXISTS 'groq';
--> statement-breakpoint
ALTER TYPE "provider_kind" ADD VALUE IF NOT EXISTS 'openai-compatible';
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "base_url" text;
