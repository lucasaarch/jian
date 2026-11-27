-- A Linear account's name is what the agent uses to pick the workspace (`linear__<name>__...`),
-- so two of them may not share one, whatever the capitals. The store turns a violation into a
-- conflict (as for GitHub, migration 0024).
CREATE UNIQUE INDEX connector_accounts_linear_name ON connector_accounts (lower(name))
    WHERE plugin = 'linear';

-- A thread started from a Linear issue, and which one. The link goes both ways: from the thread
-- to the issue (what the thread is about) and from the issue to its threads (where its webhook
-- events are sent). `issue_id` is Linear's own id (what a webhook names), never the identifier
-- (`ENG-12`), which changes when the issue moves to another team; `identifier` is only what was
-- shown when the thread started.
--
-- Rows go with the thread, the connector account (a workspace that is removed) and the agent.
CREATE TABLE linear_threads (
    thread_id text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES connector_accounts (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    issue_id text NOT NULL,
    identifier text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX linear_threads_issue ON linear_threads (account_id, issue_id);
