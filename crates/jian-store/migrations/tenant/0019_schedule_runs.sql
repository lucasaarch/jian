-- A schedule is work a person authorised, so a firing opens a run of its own (`origin =
-- 'schedule'`) instead of going through the proactive wake.
--
-- `schedule_id` is the schedule that made the run, kept so the schedule's `last_error` can say
-- how the run ended. `inbox_id` is the firing's row in `agent_inbox`, which stays the queue of
-- firings that have not opened a run yet (one waits there while its thread is busy); it is
-- unique, so a firing opens at most one run however many jobs look at it.
--
-- Firings already waiting in `agent_inbox` from before this migration need no conversion: the
-- wake no longer reads kind 'schedule' and the ticker dispatches every unconsumed one.
ALTER TABLE runs
    DROP CONSTRAINT runs_origin_check,
    ADD CONSTRAINT runs_origin_check
        CHECK (origin IN ('message', 'continue', 'subagent', 'wake', 'schedule')),
    ADD COLUMN schedule_id text REFERENCES schedules (id) ON DELETE SET NULL,
    ADD COLUMN inbox_id text REFERENCES agent_inbox (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX runs_inbox ON runs (inbox_id) WHERE inbox_id IS NOT NULL;
