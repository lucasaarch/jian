-- The pull requests an agent was asked to review, one row per head commit: the primary key is what
-- makes a review happen once per push, however many times GitHub delivers the webhook and
-- whether it was asked for by hand or because the pull request was opened. A new push is a new
-- commit and so a new row. The repository is kept in lower case, as GitHub treats it.
--
-- Rows go with the connector account (an installation that is removed) and with the agent.
CREATE TABLE github_reviews (
    account_id text NOT NULL REFERENCES connector_accounts (id) ON DELETE CASCADE,
    repo text NOT NULL,
    pull_number bigint NOT NULL CHECK (pull_number > 0),
    head_sha text NOT NULL CHECK (head_sha <> ''),
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    requested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, repo, pull_number, head_sha)
);
