-- An Artifact outlives the conversation it was made in: deleting a conversation leaves its
-- Artifacts on the owner's page. `session_id` goes on naming that conversation, gone or not, so
-- every route under it still reaches them; `project_id` is the project the conversation was in,
-- written as it is deleted, which still names where the page keeps them.
ALTER TABLE "session_artifacts" DROP CONSTRAINT "session_artifacts_session_id_fkey";
--> statement-breakpoint
ALTER TABLE "session_artifacts" ADD COLUMN "project_id" uuid;
