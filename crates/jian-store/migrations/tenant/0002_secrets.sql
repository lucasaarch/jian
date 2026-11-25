-- Provider keys, OAuth tokens and channel credentials. `envelope` is the encrypted value (see
-- `jian_store::secrets`): nothing in this table is readable without the tenant's data key, which
-- lives in `platform.tenant_keys`, out of this role's reach. `owner` says what the secret belongs
-- to (`provider:openai`) and is also bound into the encryption, so an envelope copied to another
-- row does not decrypt.
CREATE TABLE secrets (
    owner text PRIMARY KEY,
    envelope bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
