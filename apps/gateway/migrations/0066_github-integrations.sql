CREATE TABLE github_installations (
  id uuid PRIMARY KEY,
  installation_id bigint NOT NULL UNIQUE,
  account_id bigint NOT NULL,
  login text NOT NULL,
  type text NOT NULL,
  avatar_url text,
  connected_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE github_installation_states (
  hash text PRIMARY KEY,
  return_origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX github_installation_states_expiry ON github_installation_states (expires_at);
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN github_account_id uuid;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN github_repository_id bigint;
--> statement-breakpoint
ALTER TABLE projects
  ADD CONSTRAINT projects_github_account_fk
  FOREIGN KEY (github_account_id) REFERENCES github_installations (id) ON DELETE SET NULL;
