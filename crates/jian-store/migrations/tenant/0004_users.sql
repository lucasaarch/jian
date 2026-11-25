-- The people who may sign in to this tenant. There is no sign-up: a row exists because an admin
-- (or the install's owner, from the command line) added it.
--
-- `email` is stored trimmed and lower case by the store, which is what makes the unique
-- constraint mean "the same address". `password_hash` is an argon2id PHC string, null for a
-- person who has been invited and has not chosen a password yet. A user is disabled, never
-- deleted, so whatever refers to them later keeps a name to show.
CREATE TABLE users (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    email text NOT NULL UNIQUE CHECK (email <> '' AND email = btrim(email)),
    name text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    password_hash text,
    -- Set when an admin chose the password: the person must replace it before doing anything.
    must_change_password boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);

-- One-use invitations to choose a password. Only the SHA-256 of the token is kept. A used or
-- expired row stays as a record; the user's removal would take it along.
CREATE TABLE user_invites (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);

CREATE INDEX user_invites_user ON user_invites (user_id);
