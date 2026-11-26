-- Where an artifact's link goes. The reader of a link has no token and no workspace, so
-- something outside every tenant has to say which workspace a link belongs to, the way
-- `api_tokens` does for a bearer token. Only the SHA-256 of the link's token is kept; the token
-- itself is in the tenant, encrypted.
--
-- This is an index, not the truth: the tenant's own `artifacts.link_hash` says whether the link
-- is live, and the reader checks both. A row left behind by a crash between the two writes
-- therefore opens nothing.
CREATE TABLE public_artifact_links (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    artifact_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_artifact_links_artifact ON public_artifact_links (tenant_id, artifact_id);
