-- What an agent is to do later, and the inbox where each time it comes lands.

-- A schedule belongs to an agent and is either one-shot (`run_at`) or repeating (`cron`, read in
-- `time_zone`): exactly one of the two. `next_run_at` is the next time it is due, null once a
-- one-shot has fired or when it is off. `thread_id` is the conversation the instruction was made
-- in, if any; it is set null when that thread goes.
CREATE TABLE schedules (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    thread_id text REFERENCES threads (id) ON DELETE SET NULL,
    name text NOT NULL,
    instruction text NOT NULL,
    run_at timestamptz,
    cron text,
    time_zone text NOT NULL DEFAULT 'UTC',
    enabled boolean NOT NULL DEFAULT true,
    next_run_at timestamptz,
    last_run_at timestamptz,
    last_error text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE,
    CHECK ((run_at IS NOT NULL) <> (cron IS NOT NULL))
);
CREATE INDEX schedules_agent ON schedules (agent_id, seq);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

-- What reaches an agent without a person typing it. The runtime reads it (LUC-78); here it is
-- only written. One row per schedule and due time, so a job that runs twice writes it once.
CREATE TABLE agent_inbox (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    schedule_id text REFERENCES schedules (id) ON DELETE SET NULL,
    due_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    UNIQUE (schedule_id, due_at)
);
CREATE INDEX agent_inbox_agent ON agent_inbox (agent_id, seq);
