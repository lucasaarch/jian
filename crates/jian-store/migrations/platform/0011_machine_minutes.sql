-- Minutes of machine time a tenant may use in a UTC calendar month: the time its runs held a
-- machine awake. Null is no limit, which is what a self-hosted install keeps.
-- The limit lives here, in `platform`, with the other quotas: a tenant must not edit its own.
ALTER TABLE tenant_quotas
    ADD COLUMN machine_minutes bigint CHECK (machine_minutes >= 0);
