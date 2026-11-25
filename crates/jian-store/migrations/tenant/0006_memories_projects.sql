-- What an agent remembers, and the projects a workspace's conversations can be about.

-- A memory belongs to its AGENT, not to a person: it is what the agent knows, whoever taught it.
-- `origin_*` says where it was learned (see `RecallScope` in the store): the thread, its kind and
-- who was in it then, so a fact learned in a direct chat is not repeated to others by default.
-- `imported` is the origin of a memory from the old Jian, whose conversation is unknown; `manual`
-- is one written outside any thread. A thread that is deleted leaves the memory with no thread
-- and the same kind.
CREATE TABLE memories (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-z0-9_-]{1,100}$'),
    content text NOT NULL CHECK (length(content) <= 20000),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    -- Null: permanent. A flash memory is gone to every read once this passes.
    expires_at timestamptz,
    origin_thread_id text REFERENCES threads (id) ON DELETE SET NULL,
    origin_kind text NOT NULL CHECK (origin_kind IN ('dm', 'group', 'channel', 'manual', 'imported')),
    -- Who was in the origin thread when this was written, as `member:<id>`, `agent:<id>` or
    -- `external:<id>`.
    origin_participants text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE,
    PRIMARY KEY (agent_id, key)
);

CREATE INDEX memories_search ON memories
    USING gin (to_tsvector('simple', key || ' ' || content));
CREATE INDEX memories_expiry ON memories (expires_at) WHERE expires_at IS NOT NULL;

-- Two memories that belong together. One row per pair, the smaller key first.
CREATE TABLE memory_links (
    agent_id text NOT NULL,
    a_key text NOT NULL,
    b_key text NOT NULL,
    PRIMARY KEY (agent_id, a_key, b_key),
    CHECK (a_key < b_key),
    FOREIGN KEY (agent_id, a_key) REFERENCES memories (agent_id, key) ON DELETE CASCADE,
    FOREIGN KEY (agent_id, b_key) REFERENCES memories (agent_id, key) ON DELETE CASCADE
);
CREATE INDEX memory_links_b ON memory_links (agent_id, b_key);

CREATE TABLE projects (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL,
    repository_url text,
    instructions text NOT NULL DEFAULT '',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE
);

-- A thread is about at most one project. Deleting either side ends the link.
CREATE TABLE thread_projects (
    thread_id text PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE
);
CREATE INDEX thread_projects_project ON thread_projects (project_id);
