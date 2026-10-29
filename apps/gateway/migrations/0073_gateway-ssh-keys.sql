-- SSH keys belong to the installation now. They lived only as files in each agent's workspace;
-- the gateway imports those at startup, the private half into the gateway vault.
CREATE TABLE ssh_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  public_key text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX ssh_keys_public_key ON ssh_keys (public_key);
