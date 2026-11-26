-- What reaches an agent without a person asking it, and the budget that keeps it from spinning.
--
-- `agent_inbox` (0007) already holds what schedules fire. It becomes the agent's event box:
--   kind: 'schedule', 'message' (a group message that did not cite the agent), 'run.failed',
--     'wake_later' (the agent asked to be woken), 'external' (a webhook of the workspace).
--   thread_id: the conversation the event is about, when there is one. An agent can only act in
--     a thread, so an event with none can be read and ignored but never starts a run.
--   available_ms: Unix milliseconds from which the event counts. It is when it arrived, except
--     for a 'wake_later' that waits for the time the agent asked for. An explicit number, not
--     now(), so the wake job and its tests share one clock.
--   dedupe_key: a source's own id for the event, so a retry or a second delivery is one row.
--   created_at is when it was received; consumed_at is when a wake took it (to act or to
--     ignore). An event the budget held back stays unconsumed.
ALTER TABLE agent_inbox
    ADD COLUMN thread_id text REFERENCES threads (id) ON DELETE SET NULL,
    ADD COLUMN available_ms bigint,
    ADD COLUMN dedupe_key text;

UPDATE agent_inbox
SET available_ms = (extract(epoch FROM COALESCE(due_at, created_at)) * 1000)::bigint;

ALTER TABLE agent_inbox ALTER COLUMN available_ms SET NOT NULL;

-- The ceiling on one event's payload. Rows from before are not checked (NOT VALID); every new
-- one is. A schedule's instruction is at most 20 000 characters, which fits.
ALTER TABLE agent_inbox
    ADD CONSTRAINT agent_inbox_payload_size CHECK (octet_length(payload::text) <= 131072) NOT VALID;

CREATE UNIQUE INDEX agent_inbox_dedupe ON agent_inbox (agent_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX agent_inbox_pending ON agent_inbox (agent_id, available_ms)
    WHERE consumed_at IS NULL;

-- How often an agent may be woken and may start a run on its own, per hour. Null is the
-- built-in default of the store.
ALTER TABLE agent_config
    ADD COLUMN max_wakes_per_hour integer CHECK (max_wakes_per_hour >= 0),
    ADD COLUMN max_proactive_runs_per_hour integer CHECK (max_proactive_runs_per_hour >= 0);

-- What the budget has spent: one row per wake or per run that a wake started, by the job or the
-- run it was for, so a job that runs twice spends once. Rows older than a few hours are swept
-- as new ones are written.
CREATE TABLE agent_budget_use (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('wake', 'run')),
    ref text NOT NULL,
    at_ms bigint NOT NULL,
    PRIMARY KEY (agent_id, kind, ref)
);
CREATE INDEX agent_budget_use_recent ON agent_budget_use (agent_id, kind, at_ms);
