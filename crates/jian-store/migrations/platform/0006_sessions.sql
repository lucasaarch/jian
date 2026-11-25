-- Login sessions of the people of a tenant, and tokens that belong to one of them.
--
-- A session is a token like the others: only its SHA-256 is kept, revoking sets `revoked_at`.
-- What is new is that it expires, and that it acts as a user. For a `session` row `subject_id`
-- is the user's id in the tenant's own schema, so "revoke every session of a user" is the same
-- lookup as for a machine. `user_id` is the person a token belongs to: set on a session, and
-- the place a machine's or a phone's token will say whose it is (nullable: the tokens that
-- exist, and the owner's, belong to nobody).
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_kind_check;
ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_kind_check
    CHECK (kind IN ('owner', 'machine', 'device', 'session'));
ALTER TABLE api_tokens ADD COLUMN user_id text CHECK (user_id <> '');
-- Null for a token that does not expire. Checked on every lookup, not by a sweeper, so a
-- session ends on time even if nothing cleans up.
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;
