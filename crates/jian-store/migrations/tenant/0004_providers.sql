-- Model provider accounts, and what calls to them used.
--
-- An account holds NO key: the key is a secret of this tenant's vault under the owner
-- `provider:<id>` (see `jian_store::secrets`), so a dump of this table holds nothing to sign in
-- with. `has_key` is derived from the vault's own table when read.
--
-- A vendor can have an account per mode (`api`, `subscription`) and many accounts of each, and
-- exactly one of them active: the partial unique index is what makes two active accounts
-- impossible however two requests interleave. A revoked account is never active.
CREATE TABLE provider_accounts (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    provider text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('api', 'subscription')),
    label text NOT NULL,
    -- Where the server is, for the accounts that name one (Ollama, OpenAI-compatible, or a proxy
    -- in front of a vendor). Null: the vendor's own address.
    base_url text,
    active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CHECK (NOT active OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX provider_accounts_one_active
    ON provider_accounts (provider, mode) WHERE active;

-- One row per model call, written by whoever made the call. Counts do not overlap (see
-- `jian_llm::Usage`). `source` says what the call was for, when the caller knows (a session id,
-- `title`, `schedule:<id>`); it is free text and the store never reads it back as an id.
CREATE TABLE token_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL CHECK (cache_write_tokens >= 0),
    source text
);

CREATE INDEX token_usage_at ON token_usage (at);
