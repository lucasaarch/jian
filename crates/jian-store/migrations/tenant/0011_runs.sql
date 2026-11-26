-- An agent's run: one pass of the agent loop over a thread, from the message that started it to
-- its answer. The run is a job in the queue; this row is what a person and the next worker read.

CREATE TABLE runs (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    thread_id text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id),
    -- The account that started it; null for a run no person started (a schedule, an event).
    started_by text,
    -- The seq of the message that started it. `seen_seq` is the newest message the run has read:
    -- a message past it joins the next step.
    trigger_seq bigint NOT NULL,
    seen_seq bigint NOT NULL,
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'waiting_approval', 'done', 'failed', 'stopped')),
    steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
    -- Tokens of every model call of the run, counted against the monthly quota.
    tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    -- Whether the run ever woke a machine, and for how long: the base of machine billing.
    used_machine boolean NOT NULL DEFAULT false,
    machine_ms bigint NOT NULL DEFAULT 0 CHECK (machine_ms >= 0),
    error text,
    -- A stop asked for; the worker running it polls this when no stop signal can reach it.
    stop_requested boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

-- One active run per thread and agent, whatever the number of workers.
CREATE UNIQUE INDEX runs_one_active ON runs (thread_id, agent_id)
    WHERE state IN ('queued', 'running', 'waiting_approval');
CREATE INDEX runs_by_thread ON runs (thread_id, seq DESC);

-- A tool call that waits for a person. At most one is pending per run: the loop stops there.
CREATE TABLE run_approvals (
    id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    call_id text NOT NULL,
    tool text NOT NULL,
    input text NOT NULL,
    state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'approved', 'refused', 'expired')),
    expires_at timestamptz NOT NULL,
    decided_by text,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    UNIQUE (run_id, call_id)
);
