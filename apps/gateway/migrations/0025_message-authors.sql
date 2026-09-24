ALTER TABLE messages ADD COLUMN author_id text;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN author_name text;
--> statement-breakpoint
CREATE TABLE people (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  display_name text,
  avatar text,
  avatar_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, actor_id)
);
