-- A thread started from an issue or a pull request, and which one. The link goes both ways: from
-- the thread to the item (what the thread is about) and from the item to its threads (where its
-- webhook events are sent). The repository is kept in lower case, as GitHub treats it.
--
-- Rows go with the thread, the connector account (an installation that is removed) and the agent.
CREATE TABLE github_threads (
    thread_id text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES connector_accounts (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    repo text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('issue', 'pull')),
    number bigint NOT NULL CHECK (number > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_threads_item ON github_threads (account_id, repo, kind, number);
