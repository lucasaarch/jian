-- What an agent works toward in a thread, until it is done or a person is needed.
--   state: 'open' (keep working: a run that ends without finishing queues the next one),
--     'blocked' (waits for a person; nothing continues it but a new objective), 'done', or
--     'cancelled' (a person dropped it).
--   idle_runs: runs in a row that ended with the objective still open and nothing to show for
--     it (no tool call, nobody else wrote). A person's message sets it back to 0.
--   set_by: the account that set it; null when the agent set it itself.
CREATE TABLE objectives (
    thread_id text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id),
    text text NOT NULL CHECK (text <> ''),
    state text NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'blocked', 'done', 'cancelled')),
    note text,
    idle_runs integer NOT NULL DEFAULT 0 CHECK (idle_runs >= 0),
    set_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, agent_id)
);

-- Tool calls a run made, to tell a run that worked from one that only talked.
ALTER TABLE runs ADD COLUMN tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0);
