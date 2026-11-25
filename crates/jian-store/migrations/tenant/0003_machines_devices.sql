-- The computers (Jian Remote workers) and phones that may connect to this tenant. What a token
-- opens is in `platform.api_tokens`; these rows hold what the panel shows and the worker reports.
--
-- `seq` is the page cursor: a number that only grows, so a page is "the rows after this one" and
-- stays right while rows are added. `revoked_at` is set when the token is revoked; the row stays,
-- so the panel can show a machine that needs pairing again.
CREATE TABLE machines (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL,
    -- What the worker said in its last hello. Null until the machine has connected once, and for
    -- a machine imported from the old gateway, which kept less.
    os text,
    arch text,
    hostname text,
    system text,
    worker_version text,
    capabilities text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz
);

CREATE TABLE devices (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL,
    -- `ios`, `android`, or `unknown` until the app says.
    platform text NOT NULL DEFAULT 'unknown',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz
);
