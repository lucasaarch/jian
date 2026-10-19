-- Mid-run owner questions: a run can park as waiting without completing.
ALTER TYPE "run_status" ADD VALUE IF NOT EXISTS 'waiting';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "question" jsonb;
