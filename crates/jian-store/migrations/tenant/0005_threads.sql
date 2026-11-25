-- The workspace of people and agents: agents, who may see and use them, and the threads (direct
-- chats, groups and channel conversations) they talk in.
--
-- People are accounts of `platform.members`, which this schema cannot reference: a tenant's role
-- has no right on the platform. So a person is a plain `account_id` text here, and the store
-- checks membership before it writes one. The ids are never trusted from a request.
--
-- `legacy_id` is the id a row had in the old Node Jian. It is how the import finds a row it
-- already wrote, so a second run adds nothing.

-- An agent belongs to the tenant, not to a person. `created_by` is who made it and who may change
-- it besides the admins; `visibility` says who may see and use it.
CREATE TABLE agents (
    id text PRIMARY KEY,
    -- Only grows: the page cursor of the list.
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text NOT NULL DEFAULT '',
    instructions text NOT NULL DEFAULT '',
    avatar text,
    visibility text NOT NULL CHECK (visibility IN ('private', 'members', 'workspace')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    legacy_id text UNIQUE
);

-- Who may see an agent whose visibility is `members`, besides its creator.
CREATE TABLE agent_viewers (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    account_id text NOT NULL,
    PRIMARY KEY (agent_id, account_id)
);

CREATE INDEX agent_viewers_account ON agent_viewers (account_id);

-- What an admin let a member do beyond what every member may. The list is closed on purpose: a
-- new grant is a migration, so no request can invent one.
CREATE TABLE member_grants (
    account_id text NOT NULL,
    grant_name text NOT NULL CHECK (grant_name IN ('agents.create')),
    granted_by text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, grant_name)
);

-- A conversation. `dm`: one member and one agent. `group`: members and agents. `channel`: what an
-- agent's outside channel (WhatsApp, Telegram, e-mail) carries, identified by the agent, the
-- channel and the id the channel gives the chat; its people are outside the workspace.
--
-- `next_seq` is the number the next message takes. Whoever appends locks this row first, which
-- is what makes the numbers of a thread run 1, 2, 3 with no hole and no repeat.
CREATE TABLE threads (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind text NOT NULL CHECK (kind IN ('dm', 'group', 'channel')),
    title text,
    -- The member who started it; null for a channel conversation, which nobody here started.
    created_by text,
    origin_agent_id text REFERENCES agents (id),
    origin_channel text,
    origin_external_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz,
    archived_at timestamptz,
    next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    legacy_id text UNIQUE,
    CHECK (
        (kind = 'channel') = (
            origin_agent_id IS NOT NULL
            AND origin_channel IS NOT NULL
            AND origin_external_id IS NOT NULL
        )
    ),
    CHECK (kind = 'channel' OR (origin_agent_id IS NULL AND origin_channel IS NULL
                                AND origin_external_id IS NULL))
);

-- One thread per chat of an agent's channel: a webhook that arrives twice finds the first.
CREATE UNIQUE INDEX threads_channel_origin
    ON threads (origin_agent_id, origin_channel, origin_external_id) WHERE kind = 'channel';

-- Who is in a thread: exactly one of a member, an agent, or someone outside the workspace (a
-- contact of a channel, with the name the channel showed). A row ends with `left_at`; coming
-- back is a new row, so the history of who was there is kept.
CREATE TABLE thread_participants (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    account_id text,
    agent_id text REFERENCES agents (id),
    external_id text,
    external_label text,
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    CHECK (
        (account_id IS NOT NULL)::int + (agent_id IS NOT NULL)::int
        + (external_id IS NOT NULL)::int = 1
    ),
    CHECK ((external_id IS NULL) = (external_label IS NULL))
);

CREATE UNIQUE INDEX thread_participants_member
    ON thread_participants (thread_id, account_id) WHERE account_id IS NOT NULL AND left_at IS NULL;
CREATE UNIQUE INDEX thread_participants_agent
    ON thread_participants (thread_id, agent_id) WHERE agent_id IS NOT NULL AND left_at IS NULL;
CREATE UNIQUE INDEX thread_participants_external
    ON thread_participants (thread_id, external_id) WHERE external_id IS NOT NULL AND left_at IS NULL;
-- "The threads of member X" and "the threads of agent Y".
CREATE INDEX thread_participants_of_member
    ON thread_participants (account_id, thread_id) WHERE account_id IS NOT NULL AND left_at IS NULL;
CREATE INDEX thread_participants_of_agent
    ON thread_participants (agent_id, thread_id) WHERE agent_id IS NOT NULL AND left_at IS NULL;

-- A message. `parts` is the content as a JSON array of typed parts (text today), so an image, a
-- file or a tool call can come later without a new column. A deleted message keeps its row and
-- its number, and loses its parts.
CREATE TABLE messages (
    id text PRIMARY KEY,
    thread_id text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq >= 1),
    author_kind text NOT NULL CHECK (author_kind IN ('member', 'agent', 'external', 'system')),
    author_account text,
    author_agent text REFERENCES agents (id),
    author_external_id text,
    author_external_label text,
    -- One text for "who", so the idempotency key below can be unique per author.
    author_key text GENERATED ALWAYS AS (
        author_kind || ':' || COALESCE(author_account, author_agent, author_external_id, '')
    ) STORED,
    parts jsonb NOT NULL CHECK (jsonb_typeof(parts) = 'array'),
    reply_to text REFERENCES messages (id) ON DELETE SET NULL,
    client_key text CHECK (client_key IS NULL OR (client_key <> '' AND length(client_key) <= 200)),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    legacy_id text UNIQUE,
    UNIQUE (thread_id, seq),
    CHECK (
        (author_kind = 'member' AND author_account IS NOT NULL AND author_agent IS NULL
            AND author_external_id IS NULL)
        OR (author_kind = 'agent' AND author_agent IS NOT NULL AND author_account IS NULL
            AND author_external_id IS NULL)
        OR (author_kind = 'external' AND author_external_id IS NOT NULL
            AND author_external_label IS NOT NULL AND author_account IS NULL
            AND author_agent IS NULL)
        OR (author_kind = 'system' AND author_account IS NULL AND author_agent IS NULL
            AND author_external_id IS NULL)
    )
);

-- Sending the same `client_key` twice, as the same author, is one message: a retry after a
-- timeout does not post twice.
CREATE UNIQUE INDEX messages_client_key
    ON messages (thread_id, author_key, client_key) WHERE client_key IS NOT NULL;
