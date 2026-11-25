-- One data key (DEK) per tenant, kept only encrypted by a master key (KEK). The DEK in the clear
-- never reaches the database. The row goes when its tenant does, so a deleted tenant leaves no
-- key behind. Rotating the master key rewrites `master_key_id` and `wrapped_dek` and nothing else:
-- the secrets in tenant schemas are encrypted by the DEK, so they are not touched.
CREATE TABLE tenant_keys (
    tenant_id text PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    master_key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    rotated_at timestamptz
);
