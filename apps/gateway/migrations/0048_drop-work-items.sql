-- Legacy task cards are gone; conversation subagents keep runs.subagent and related indexes.
DROP INDEX IF EXISTS "runs_work_item";
--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "work_item_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "work_items";
