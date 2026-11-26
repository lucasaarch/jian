-- Signing in with GitHub and with a link sent by e-mail.
--
-- A GitHub sign-in is one more `credentials` row (kind `github`): `subject` is GitHub's numeric
-- user id, which never changes, and `label` is the login as it was when linked, only for showing:
-- people rename themselves. An account has at most one, and a GitHub user belongs to at most one
-- account (`credentials_subject` already holds that for every kind).
ALTER TABLE credentials ADD COLUMN label text CHECK (label <> '');
CREATE UNIQUE INDEX credentials_one_github ON credentials (account_id) WHERE kind = 'github';

-- One row per OAuth round trip. Only the SHA-256 of `state` is kept, so a copy of the table
-- cannot finish a sign-in that is under way. The PKCE verifier has to be sent back to GitHub
-- with the code, so it is kept as it is: it is useless without the code and the app's secret,
-- lives ten minutes and is deleted when the state is used.
--   sign_in  the browser is not signed in; `account_id` is empty. `tenant_id` is the workspace
--            it asked to open, if it said.
--   link     a signed-in member is adding GitHub; `account_id` is them and the callback is only
--            honoured for that account.
-- Used once: `used_at` is set by the statement that reads it.
CREATE TABLE login_states (
    state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    purpose text NOT NULL CHECK (purpose IN ('sign_in', 'link')),
    tenant_id text REFERENCES tenants (id) ON DELETE CASCADE,
    account_id text REFERENCES accounts (id),
    pkce_verifier text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CHECK ((purpose = 'link') = (account_id IS NOT NULL))
);
CREATE INDEX login_states_expiry ON login_states (expires_at);

-- A link sent by e-mail, one use. Only the hash of the token is kept. The request that asks for
-- a link writes nothing here and costs the same for every address: a job makes the row, and only
-- for a member, so the answer to the request does not tell who is one. At most one is live for
-- an address in a workspace: making another revokes the earlier one.
CREATE TABLE login_links (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz
);
CREATE UNIQUE INDEX login_links_one_live ON login_links (tenant_id, email)
    WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX login_links_expiry ON login_links (expires_at);
