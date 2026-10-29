-- Model defaults belong to the installation now, not to each agent. For each role the global
-- choice is the newest one the owner actually saved: a save writes every role at once, the
-- conversation role included, while creating an agent only seeded its optional roles as
-- disabled. Without that preference, an agent created yesterday would switch off the image
-- model another agent was given last week.
CREATE TABLE gateway_model_defaults (
  role text PRIMARY KEY,
  provider_id uuid,
  model_id text,
  reasoning_effort text,
  voice_name text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO gateway_model_defaults (role, provider_id, model_id, reasoning_effort, voice_name, updated_at)
SELECT DISTINCT ON (candidate.role)
  candidate.role, candidate.provider_id, candidate.model_id, candidate.reasoning_effort, candidate.voice_name, candidate.updated_at
FROM model_defaults candidate
ORDER BY
  candidate.role,
  EXISTS (
    SELECT 1 FROM model_defaults saved
    WHERE saved.profile_id = candidate.profile_id
      AND saved.role = 'conversation'
      AND saved.updated_at = candidate.updated_at
  ) DESC,
  candidate.updated_at DESC;
--> statement-breakpoint
DROP TABLE model_defaults;
--> statement-breakpoint
ALTER TABLE gateway_model_defaults RENAME TO model_defaults;
--> statement-breakpoint
-- The per-agent sticker switch only mirrored the per-agent sticker model.
ALTER TABLE profiles DROP COLUMN use_stickers;
--> statement-breakpoint
UPDATE profile_revisions SET document = document - 'useStickers' WHERE document ? 'useStickers';
