-- The release each machine's worker reports on every poll: the gateway refuses agents a worker
-- whose major.minor differs from its own, and offers to update it instead.
ALTER TABLE "remote_machines" ADD COLUMN "version" text;
--> statement-breakpoint
-- The owner updates a machine from the panel, outside any agent: such a task has no profile.
ALTER TABLE "remote_tasks" ALTER COLUMN "profile_id" DROP NOT NULL;
