-- Chat channels (WhatsApp first): one signed-in account of a chat provider, and who may talk to
-- the agent through it.
--
-- An account belongs to ONE agent: the number is the agent's. It is not a connector account,
-- which several agents may share. An agent has at most one account per provider.
--
-- The session's keys are NOT here: they live in `secrets` under the owner
-- `channel:<account id>:<key>`. `provider_address` is the account's own id on the provider (the
-- JID), learned when pairing finishes and never changed after: a different phone is refused
-- until the account is disconnected, so queued replies never go out from another number.
-- `owner_address` is the person who owns the agent, as the provider names them: their messages
-- are theirs to give orders, and they are never news to them.
--
-- `status` is what the person is told: `needs_pairing` (new, or the old Jian's account, whose
-- session cannot be carried over), `pairing`, `connected`, `disconnected`, `logged_out`.
CREATE TABLE channel_accounts (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('whatsapp', 'telegram', 'discord', 'slack', 'teams')),
    status text NOT NULL DEFAULT 'needs_pairing'
        CHECK (status IN ('needs_pairing', 'pairing', 'connected', 'disconnected', 'logged_out')),
    provider_address text,
    owner_address text CHECK (owner_address IS NULL OR btrim(owner_address) <> ''),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- The id the old Jian gave this account, so a second import finds it.
    legacy_id text UNIQUE,
    UNIQUE (agent_id, provider)
);

-- Who has written to an account's number, and what its agent's owner decided. A person who is
-- not `approved` gets nothing: not a reply, not an event with what they wrote. They stay
-- `pending` until someone decides, and `declined` is final until it is changed by hand.
-- A contact belongs to the account, never to the workspace: it is not a member.
CREATE TABLE channel_contacts (
    account_id text NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
    address text NOT NULL CHECK (btrim(address) <> ''),
    display_name text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    PRIMARY KEY (account_id, address)
);

-- There is no table for the link between a chat and its thread: a thread of kind `channel`
-- already says where it comes from (`origin_agent_id`, `origin_channel`, `origin_external_id`,
-- unique per chat in `threads_channel_origin`), and the old Jian's import writes the same.
