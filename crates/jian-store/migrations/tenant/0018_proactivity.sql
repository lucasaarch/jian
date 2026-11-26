-- How much an agent may do on its own, and a smaller budget for it.
--
-- `proactivity` is the agent's mode: 'off' (events wait in its box, no wake, no model call),
-- 'suggest' (a wake run has only tools that change nothing, so what it answers is a suggestion a
-- person acts on) and 'act' (a wake run has every tool). 'suggest' is the default: an agent
-- never just arrives and does, unless someone allowed it.
ALTER TABLE agent_config
    ADD COLUMN proactivity text NOT NULL DEFAULT 'suggest'
        CHECK (proactivity IN ('off', 'suggest', 'act'));

-- The budget's window goes from one hour to one day. An hourly number does not say what a daily
-- one should be, so an agent's own limit is reset to the default (null), except 0, which was
-- "switched off" and stays so.
ALTER TABLE agent_config
    ADD COLUMN max_wakes_per_day integer CHECK (max_wakes_per_day >= 0),
    ADD COLUMN max_proactive_runs_per_day integer CHECK (max_proactive_runs_per_day >= 0);

UPDATE agent_config
   SET max_wakes_per_day = CASE WHEN max_wakes_per_hour = 0 THEN 0 END,
       max_proactive_runs_per_day = CASE WHEN max_proactive_runs_per_hour = 0 THEN 0 END;

ALTER TABLE agent_config
    DROP COLUMN max_wakes_per_hour,
    DROP COLUMN max_proactive_runs_per_hour;
