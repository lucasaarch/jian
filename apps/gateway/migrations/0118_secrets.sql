-- Command secrets become Secrets: a credential of one or more fields, each the environment variable
-- a command reads it as. Every command secret is carried across as a Secret of one sensitive
-- field, under the same variable, for the same agents.
--
-- A carried field keeps vault_key = command:<name>, where its value already is. The gateway vault
-- binds each ciphertext to the key it was written under (its AAD), so moving the value to a new
-- key would mean decrypting and rewriting it, which SQL cannot do. A field made later is written
-- under secret:<id>:<variable>; the key is stored per field, so both kinds are read alike.
--
-- The table is secret_entries because secrets is already the per-agent vault.
CREATE TABLE secret_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  sites text[] NOT NULL DEFAULT '{}',
  created_by_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE secret_fields (
  secret_id uuid NOT NULL REFERENCES secret_entries(id) ON DELETE CASCADE,
  position integer NOT NULL,
  label text NOT NULL,
  env_name text NOT NULL UNIQUE,
  sensitive boolean NOT NULL,
  vault_key text NOT NULL,
  PRIMARY KEY (secret_id, env_name)
);
--> statement-breakpoint
CREATE TABLE secret_agents (
  secret_id uuid NOT NULL REFERENCES secret_entries(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  granted_by_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  granted_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (secret_id, profile_id)
);
--> statement-breakpoint
CREATE INDEX secret_agents_profile ON secret_agents (profile_id);
--> statement-breakpoint
-- Made by the owner, as every command secret was. The title is the old name, which the statements
-- below join on: secret_entries is new and empty here, and command secret names are unique.
INSERT INTO secret_entries (title, description, created_at, updated_at, last_used_at)
SELECT name, description, created_at, updated_at, last_used_at FROM command_secrets;
--> statement-breakpoint
INSERT INTO secret_fields (secret_id, position, label, env_name, sensitive, vault_key)
SELECT secret_entries.id, 0, 'Value', command_secrets.name, true, 'command:' || command_secrets.name
FROM command_secrets JOIN secret_entries ON secret_entries.title = command_secrets.name;
--> statement-breakpoint
-- Nobody recorded when an agent was let use a command secret: the secret's own creation stands in.
INSERT INTO secret_agents (secret_id, profile_id, granted_at)
SELECT secret_entries.id, command_secret_agents.profile_id, command_secrets.created_at
FROM command_secret_agents
JOIN command_secrets ON command_secrets.name = command_secret_agents.name
JOIN secret_entries ON secret_entries.title = command_secrets.name;
--> statement-breakpoint
DROP TABLE command_secret_agents;
--> statement-breakpoint
DROP TABLE command_secrets;
