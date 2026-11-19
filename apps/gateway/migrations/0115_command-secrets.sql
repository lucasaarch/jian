-- Secrets the owner keeps for agents' commands, each named as the environment variable a command
-- reads it as. The value is encrypted in gateway_secrets under command:<name>; these rows hold
-- only what the panel shows, and which agents may hand the secret to a command.
CREATE TABLE command_secrets (
  name text PRIMARY KEY,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE command_secret_agents (
  name text NOT NULL REFERENCES command_secrets(name) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (name, profile_id)
);
--> statement-breakpoint
CREATE INDEX command_secret_agents_profile ON command_secret_agents (profile_id);
