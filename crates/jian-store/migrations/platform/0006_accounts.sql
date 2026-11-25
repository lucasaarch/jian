-- People, the ways they sign in, and the workspaces they belong to.
--
-- One person is one account, in three layers, and none of them lives in a tenant's schema:
--   accounts     who the person is (the email address);
--   credentials  how they prove it: one row per way (a password, a GitHub login, ...);
--   members      which tenants they may open, and as what.
-- They are in `platform` so that a membership is a real foreign key to a real account, and so
-- that "the workspaces of this person" is one query. Every query on `members` and `invites`
-- carries the tenant it is for, taken from the caller's token: that filter is the isolation.

-- `email` is stored trimmed and lower case by the store, which is what makes the unique
-- constraint mean "the same address". An account is disabled, never deleted, so whatever
-- refers to it later keeps a name to show. A disabled account signs in nowhere.
CREATE TABLE accounts (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email <> '' AND email = lower(btrim(email))),
    name text NOT NULL CHECK (name <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);

-- The kinds are the ones planned. Only `password` has code behind it today; the others are
-- allowed here so adding them is no migration. `subject` is the id on the other side (a GitHub
-- user id, a passkey's credential id). `secret` is a password's argon2id hash in PHC form,
-- never the password. The material of a future passkey or TOTP is stored encrypted, through
-- the vault, and not in clear text here.
CREATE TABLE credentials (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('password', 'github', 'email_link', 'passkey', 'totp')),
    subject text CHECK (subject <> ''),
    secret text,
    -- An admin chose this password: the person must replace it before doing anything else.
    must_change boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    CHECK (kind <> 'password' OR (secret IS NOT NULL AND subject IS NULL))
);

CREATE UNIQUE INDEX credentials_one_password ON credentials (account_id) WHERE kind = 'password';
CREATE UNIQUE INDEX credentials_subject ON credentials (kind, subject) WHERE subject IS NOT NULL;
CREATE INDEX credentials_account ON credentials (account_id);

-- `seq` only grows and is the page cursor of a tenant's list. A member is disabled, never
-- removed. The tenant's removal takes its members along; the account stays.
CREATE TABLE members (
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES accounts (id),
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    invited_by text REFERENCES accounts (id),
    disabled_at timestamptz,
    PRIMARY KEY (tenant_id, account_id)
);

CREATE INDEX members_account ON members (account_id);

-- One-use invitations. Only the SHA-256 of the token is kept (it is also the invitation's id
-- for listing and revoking: it cannot be turned back into the token). At most one is live for
-- an address in a tenant: issuing again revokes the earlier one, which is what "copy the link"
-- and "send it again" do. A used, revoked or expired row stays as a record.
CREATE TABLE invites (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    invited_by text REFERENCES accounts (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz
);

CREATE UNIQUE INDEX invites_one_live ON invites (tenant_id, email)
    WHERE used_at IS NULL AND revoked_at IS NULL;

-- Login sessions are tokens like the others (only the hash is kept, revoking sets
-- `revoked_at`), with two additions: they expire, and they act as an account. For a `session`
-- row `subject_id` is the account's id and the tenant is the ONE workspace it opens. A machine's
-- or a phone's token may name the account it belongs to too (nullable: those that exist, and
-- the owner's, belong to nobody).
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_kind_check;
ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_kind_check
    CHECK (kind IN ('owner', 'machine', 'device', 'session'));
ALTER TABLE api_tokens ADD COLUMN account_id text REFERENCES accounts (id);
-- Null for a token that does not expire. Checked on every lookup, not by a sweeper, so a
-- session ends on time even if nothing cleans up.
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;
ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_session_shape
    CHECK (kind <> 'session' OR (account_id IS NOT NULL AND expires_at IS NOT NULL));

CREATE INDEX api_tokens_account ON api_tokens (account_id) WHERE account_id IS NOT NULL;
