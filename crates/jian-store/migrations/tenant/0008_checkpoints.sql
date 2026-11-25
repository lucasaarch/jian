-- A summary of a thread's older messages, so an agent need not read the whole thread.

-- `upto_seq` is the last message the summary covers; what the agent reads is the latest summary
-- plus the messages after it. Messages are never changed or removed by this: the summary is an
-- addition, and a thread that is deleted takes its checkpoints with it.
CREATE TABLE thread_checkpoints (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    upto_seq bigint NOT NULL CHECK (upto_seq >= 1),
    summary text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id, upto_seq)
);

-- A thread being compacted right now. One row per thread, so two compactions never run at once;
-- `lease_until` lets one that died be taken over.
CREATE TABLE thread_compactions (
    thread_id text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    lease_until timestamptz NOT NULL
);
