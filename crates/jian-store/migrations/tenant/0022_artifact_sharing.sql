-- Who may open an artifact, and its link.
--
-- `owner_member` is the member the artifact belongs to: who made it; for an agent's, the member
-- whose message or action started that run, else whoever made the agent. It is explicit, not read
-- off the thread, because the owner alone (and an agent run in the artifact's thread) decides who
-- else sees it. It is null only for a row older than this column whose maker cannot be found any
-- more; nobody opens such a row but a run of its own thread.
--
-- `visibility`: `owner` (default; only the owner), `members` (the owner and the members in
-- `artifact_members`), `workspace` (every member), `external` (anyone with the link, no sign-in,
-- with a password when `password_hash` is set).
--
-- The link's token is kept encrypted under the tenant's data key so Copy Link can show it again;
-- `link_hash`, its SHA-256, is what a reader's request is matched against (and what
-- `platform.public_artifact_links` routes by). Both are null on a gateway with no links (the
-- desktop app). A new link replaces both, so the old token stops matching.
--
-- `password_hash` is a salted scrypt hash, never the password, and exists only for `external`.
ALTER TABLE artifacts
    ADD COLUMN owner_member text,
    ADD COLUMN visibility text NOT NULL DEFAULT 'owner'
        CHECK (visibility IN ('owner', 'members', 'workspace', 'external')),
    ADD COLUMN link_hash text CHECK (link_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN link_envelope bytea,
    ADD COLUMN password_hash text,
    ADD CONSTRAINT artifacts_link_together CHECK ((link_hash IS NULL) = (link_envelope IS NULL)),
    ADD CONSTRAINT artifacts_password_only_external
        CHECK (password_hash IS NULL OR visibility = 'external');

UPDATE artifacts a
SET owner_member = COALESCE(
    a.created_by_account,
    (SELECT g.created_by FROM agents g WHERE g.id = a.created_by_agent),
    (SELECT t.created_by FROM threads t WHERE t.id = a.thread_id)
);

CREATE UNIQUE INDEX artifacts_link_hash ON artifacts (link_hash) WHERE link_hash IS NOT NULL;
CREATE INDEX artifacts_owner ON artifacts (owner_member);

-- The members an artifact of visibility `members` is shared with, besides its owner.
CREATE TABLE artifact_members (
    artifact_id text NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    account_id text NOT NULL,
    PRIMARY KEY (artifact_id, account_id)
);
CREATE INDEX artifact_members_account ON artifact_members (account_id);
