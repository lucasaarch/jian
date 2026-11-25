-- What a tenant may use at most, and the places its runs hold under that limit.

-- A tenant with no row, or a null column, has no limit there.
CREATE TABLE tenant_quotas (
    tenant_id text PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    max_concurrent_runs integer CHECK (max_concurrent_runs >= 0),
    monthly_tokens bigint CHECK (monthly_tokens >= 0),
    disk_bytes bigint CHECK (disk_bytes >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per run in flight. A run that dies stops renewing `expires_at`, and the next run to
-- ask for a place deletes the row, so a crash never holds a tenant at its limit.
CREATE TABLE run_leases (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX run_leases_tenant ON run_leases (tenant_id, expires_at);
