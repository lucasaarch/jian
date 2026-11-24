-- When the agent took a message into its context. Null until then. What the owner wrote before
-- this existed was read by the turn that answered it, so those messages count as read when they
-- were sent rather than showing as unread forever.
ALTER TABLE "messages" ADD COLUMN "read_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "messages" SET "read_at" = "created_at" WHERE "role" = 'user';
