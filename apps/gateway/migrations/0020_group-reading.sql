ALTER TABLE messages ALTER COLUMN run_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE channels ADD COLUMN handle text;
