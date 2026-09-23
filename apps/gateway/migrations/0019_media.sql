CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  mime_type text NOT NULL,
  data text NOT NULL,
  bytes integer NOT NULL,
  voice boolean NOT NULL DEFAULT false,
  analysis text,
  held boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX media_source ON media_assets(profile_id, source_key);
--> statement-breakpoint
CREATE INDEX media_session ON media_assets(profile_id, session_id);
--> statement-breakpoint
ALTER TABLE deliveries ADD COLUMN media_id uuid REFERENCES media_assets(id) ON DELETE CASCADE;
--> statement-breakpoint

DROP INDEX providers_live_per_kind;
--> statement-breakpoint
CREATE UNIQUE INDEX providers_live_per_kind_auth ON providers(kind, coalesce(auth_mode, 'api')) WHERE revoked_at IS NULL;
--> statement-breakpoint

ALTER TABLE errands ADD COLUMN answer_request_key text;
--> statement-breakpoint
