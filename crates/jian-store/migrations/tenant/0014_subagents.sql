-- A subagent: a thread an agent opened for another run, to work on a brief and report back.
-- The child thread is an ordinary thread; this row ties it to the run and thread that asked.
--   parent_run, parent_call: the run and the tool call that spawned it. The pair is unique, so a
--     call run again (after a crash, or on resuming a run that waited) finds its child.
--   child_run: the run that works on the brief (origin 'subagent'), made with the thread.
--   depth: 1 for a child of an ordinary thread, 2 for a child of a child.
--   wait: the parent run parks on the call until the child ends; else the report is only a
--     message in the parent thread.
--   state: 'running' until the child's run ends, then 'done', 'failed' or 'stopped'. Written
--     once, together with `report`: the text that goes back to the parent.
CREATE TABLE subagents (
    child_thread text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    parent_thread text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    parent_run text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    parent_call text NOT NULL,
    child_run text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents (id),
    brief text NOT NULL CHECK (brief <> ''),
    depth integer NOT NULL CHECK (depth >= 1),
    wait boolean NOT NULL,
    state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed', 'stopped')),
    report text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (parent_run, parent_call)
);

CREATE INDEX subagents_by_parent_thread ON subagents (parent_thread, created_at DESC);
