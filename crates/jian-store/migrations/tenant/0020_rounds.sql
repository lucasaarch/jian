-- The round: now and then an agent looks over its usual work and brings one suggestion, without
-- an event and without a schedule.
--
-- `round_every_hours` is how often (1 to 168), null for the default, 0 for never. `last_round_ms`
-- is when the last round was queued, in Unix milliseconds: the tick moves it with a compare and
-- set, so two gateways ticking together queue one round per window. A round is an `agent_inbox`
-- event of kind 'round'; the wake handles it like any other event (mode, budget and quotas
-- included).
ALTER TABLE agent_config
    ADD COLUMN round_every_hours integer CHECK (round_every_hours BETWEEN 0 AND 168),
    ADD COLUMN last_round_ms bigint;
