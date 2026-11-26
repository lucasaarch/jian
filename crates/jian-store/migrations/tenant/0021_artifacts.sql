-- Artifacts: what an agent makes for people to look at beside a conversation, with every version
-- it had.

-- A folder the members keep artifacts in. Shared by the workspace, like a project is; deleting
-- one only takes its artifacts out of it.
CREATE TABLE artifact_folders (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE
);

-- `thread_id` and `project_id` say where it was made and have no cascade: an artifact outlives
-- its thread and its project, and is left with none (`SET NULL`). One with neither is seen only
-- by who made it and by an admin. `created_by_account` is null for an agent's, whose id is in
-- `created_by_agent` with no foreign key: an agent that is deleted leaves what it made.
CREATE TABLE artifacts (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind text NOT NULL CHECK (kind IN
        ('html', 'react', 'markdown', 'mermaid', 'deck', 'sheet', 'diagram')),
    title text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
    folder_id text REFERENCES artifact_folders (id) ON DELETE SET NULL,
    pinned boolean NOT NULL DEFAULT false,
    thread_id text REFERENCES threads (id) ON DELETE SET NULL,
    project_id text REFERENCES projects (id) ON DELETE SET NULL,
    created_by_account text,
    created_by_agent text,
    CHECK ((created_by_account IS NULL) <> (created_by_agent IS NULL)),
    -- The number of its latest version. Versions count from 1 with none skipped.
    latest integer NOT NULL DEFAULT 1 CHECK (latest >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    legacy_id text UNIQUE
);
CREATE INDEX artifacts_thread ON artifacts (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX artifacts_project ON artifacts (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX artifacts_folder ON artifacts (folder_id) WHERE folder_id IS NOT NULL;

-- One version. An agent's is never written over; a member's edit is a new version, and only a
-- stretch of autosaves by the same member (same `edit_key`) rewrites the one it began while it
-- is still the latest. `tweaks` is the object a React component declares, as written; the
-- values someone tries it with are not stored anywhere.
CREATE TABLE artifact_versions (
    artifact_id text NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    content text NOT NULL,
    tweaks text,
    author_kind text NOT NULL CHECK (author_kind IN ('agent', 'member')),
    author_id text NOT NULL,
    edit_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (artifact_id, version)
);
