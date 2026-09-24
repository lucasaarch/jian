CREATE TABLE memory_links (
  profile_id uuid NOT NULL,
  a_key text NOT NULL,
  b_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, a_key, b_key),
  CHECK (a_key < b_key),
  FOREIGN KEY (profile_id, a_key) REFERENCES memories(profile_id, key) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, b_key) REFERENCES memories(profile_id, key) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX memory_links_b ON memory_links (profile_id, b_key);
