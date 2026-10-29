-- Every conversation, existing ones included, starts asking before its agent acts.
ALTER TABLE sessions ADD COLUMN protection text NOT NULL DEFAULT 'ask';
--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_protection CHECK (protection IN ('ask', 'full'));
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN approval jsonb;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN action jsonb;
--> statement-breakpoint
-- Nobody approves from a chat until the owner says they may.
ALTER TABLE contacts ADD COLUMN can_approve boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE channels ADD COLUMN messages jsonb;
