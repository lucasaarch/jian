-- One row per tenant. The row is written in the same transaction that creates the tenant's schema
-- and role, so a row without a schema (or the reverse) is never committed.
CREATE TABLE tenants (
    id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]{1,48}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);
