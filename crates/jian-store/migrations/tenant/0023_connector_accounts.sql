-- Connector accounts: one sign-in to one service (a GitHub token, a Linear workspace, an MCP
-- server), made by a plugin. Several of the same plugin may exist.
--
-- `scope` says which agents reach the account: `shared` (every agent of the workspace) or
-- `agents` (only those in `connector_account_agents`). The list is emptied whenever the scope is
-- `shared`, so an account is never half of each.
--
-- The account's secret (a token, an OAuth grant) is NOT here: it lives in `secrets`, under the
-- owner `connector:<id>`. `config` holds what is not secret (a URL, a workspace name).
--
-- `legacy_id` is the name of the old `mcp_servers` row an imported account came from, so a second
-- import finds it.
CREATE TABLE connector_accounts (
    id text PRIMARY KEY,
    -- Only grows: the page cursor of the list.
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    plugin text NOT NULL CHECK (btrim(plugin) <> ''),
    kind text NOT NULL CHECK (btrim(kind) <> ''),
    name text NOT NULL CHECK (btrim(name) <> ''),
    scope text NOT NULL CHECK (scope IN ('shared', 'agents')),
    config jsonb NOT NULL DEFAULT '{}',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE
);

CREATE TABLE connector_account_agents (
    account_id text NOT NULL REFERENCES connector_accounts (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, agent_id)
);

CREATE INDEX connector_account_agents_agent ON connector_account_agents (agent_id);
