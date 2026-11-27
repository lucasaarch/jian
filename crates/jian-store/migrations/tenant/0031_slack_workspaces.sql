-- A Slack installation identifies one workspace, and an agent may connect to several of them.
-- Keep the old one-provider rule for every other channel; prevent duplicate installations of the
-- same Slack workspace on one agent while allowing an account that has not finished OAuth yet.
ALTER TABLE channel_accounts
    DROP CONSTRAINT channel_accounts_agent_id_provider_key;

CREATE UNIQUE INDEX channel_accounts_one_non_slack_provider
    ON channel_accounts (agent_id, provider)
    WHERE provider <> 'slack';

CREATE UNIQUE INDEX channel_accounts_one_slack_installation_per_agent
    ON channel_accounts (agent_id, provider_address)
    WHERE provider = 'slack' AND provider_address IS NOT NULL;

CREATE INDEX channel_accounts_slack_workspace_lookup
    ON channel_accounts (provider_address, agent_id)
    WHERE provider = 'slack' AND provider_address IS NOT NULL;