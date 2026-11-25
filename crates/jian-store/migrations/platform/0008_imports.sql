-- What the import of the old Node Jian has done for each tenant, one row per domain (the
-- owner, the secrets, the machines, the phones). It is in `platform` and not in the tenant's
-- schema so the marker survives whatever the import does to the tenant, and so `jian import
-- status` reads one place.
--
--   running  a run started and has not said how it ended; after a crash this is what is left, and
--            the next run takes the domain again;
--   done     every row was written or was already there; automatic runs leave the domain alone;
--   failed   some rows could not be imported (`detail` says why, never a value); the next run
--            tries again, and the rows that went in stay;
--   skipped  the domain needs something the run did not have (an address for the owner, the old
--            master key); supplying it and running again imports it.
--
-- `source` names where the data came from without a password: `postgres:host:port/database` or
-- `dump:<sha256 prefix>`. Counts are of rows: written now, already there from an earlier run, and
-- failed.
CREATE TABLE imports (
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    domain text NOT NULL CHECK (domain ~ '^[a-z_]{1,40}$'),
    source text NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped')),
    imported integer NOT NULL DEFAULT 0 CHECK (imported >= 0),
    already_there integer NOT NULL DEFAULT 0 CHECK (already_there >= 0),
    failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
    detail text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    PRIMARY KEY (tenant_id, domain)
);
