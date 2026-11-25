-- The index from a token to the tenant it opens. It has to live here and not in the tenant's
-- schema: a request arrives with a token and nothing else, so the tenant is not known until this
-- table has answered.
--
-- Only the SHA-256 of the token is kept, as lowercase hex: the same form the Node gateway stores,
-- so the old hashes can be copied over and the tokens already handed out keep working. The token
-- is 256 random bits, which is why a plain hash (no salt, no stretching) is enough: there is
-- nothing to guess or to brute-force from the hash.
--
-- `subject_id` names what the token acts as: a machine's or a device's id in the tenant's own
-- schema, and `owner` for the owner's token. A revoked token stays, so a later request with it
-- is still refused and the audit trail is kept; its tenant's deletion removes it.
CREATE TABLE api_tokens (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('owner', 'machine', 'device')),
    subject_id text NOT NULL CHECK (subject_id <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);

-- Revoking or rotating a subject's tokens finds them by who they act as.
CREATE INDEX api_tokens_subject ON api_tokens (tenant_id, kind, subject_id);
