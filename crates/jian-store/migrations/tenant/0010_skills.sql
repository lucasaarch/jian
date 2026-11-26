-- The workspace's skill library: SKILL.md text that an agent reads when it fits the task. A skill
-- is not a plugin and runs nothing. Built-in skills are not here: they ship in the binary.

CREATE TABLE skills (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    -- Unique in the library; the routes and the agent's own switches name a skill by it.
    -- Whether it clashes with a built-in one is the gateway's to say, which knows them.
    name text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9_-]{1,64}$'),
    description text NOT NULL CHECK (btrim(description) <> '' AND char_length(description) <= 1024),
    instructions text NOT NULL
        CHECK (btrim(instructions) <> '' AND char_length(instructions) <= 12000),
    license text CHECK (char_length(license) <= 100),
    -- Tool names (a trailing `*` is a prefix) a run must have for the skill to be offered. Empty:
    -- a skill of text only, always offered.
    requires_tools text[] NOT NULL DEFAULT '{}',
    origin text NOT NULL CHECK (origin IN ('user', 'github')),
    -- Where an imported skill came from, so it can be imported again. Set exactly for `github`;
    -- `source_path` is empty for a SKILL.md at the root of the repository.
    source_repo text,
    source_path text,
    source_ref text,
    CHECK ((origin = 'github') = (source_repo IS NOT NULL AND source_path IS NOT NULL
                                  AND source_ref IS NOT NULL)),
    created_by text NOT NULL,
    updated_by text NOT NULL,
    -- Counts the changes to what the skill says; the superseded ones are in `skill_versions`.
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE
);

-- What a skill said before it changed: one row per superseded version. The current text is the
-- skill's own row. `authored_by` and `authored_at` are who wrote that version and when.
CREATE TABLE skill_versions (
    skill_id text NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    version bigint NOT NULL,
    description text NOT NULL,
    instructions text NOT NULL,
    license text,
    requires_tools text[] NOT NULL,
    authored_by text NOT NULL,
    authored_at timestamptz NOT NULL,
    PRIMARY KEY (skill_id, version)
);

-- The library skills an agent uses: an agent uses a subset, none until someone switches one on.
CREATE TABLE agent_skills (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    skill_id text NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, skill_id)
);
CREATE INDEX agent_skills_skill ON agent_skills (skill_id);

-- The built-in skills switched off for an agent. Every built-in is on unless it is listed here
-- (a name that is no built-in is inert).
CREATE TABLE agent_builtin_skills_off (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (name ~ '^[a-z0-9_-]{1,64}$'),
    PRIMARY KEY (agent_id, name)
);
