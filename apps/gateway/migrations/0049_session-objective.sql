-- Durable per-conversation objective the agent works toward across turns.
-- Older binaries ignore the column; do not drop it while objectives are in use.
ALTER TABLE "sessions" ADD COLUMN "objective" jsonb;
