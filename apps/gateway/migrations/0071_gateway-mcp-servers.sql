-- MCP servers belong to the installation now, not to each agent. What each agent had is merged:
-- a definition several agents share becomes one server; two servers with one name and different
-- settings both stay, the newest agent's under the plain name and the others as name_2, name_3…
-- Each kept server's secrets are still bound to the agent they were typed for, so this records
-- where they go and the gateway moves them when it starts (mcp/move-secrets.ts).
CREATE TABLE mcp_servers (
  name text PRIMARY KEY,
  server jsonb NOT NULL,
  position integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE mcp_secret_moves (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_name text NOT NULL,
  to_name text NOT NULL,
  PRIMARY KEY (profile_id, from_name)
);
--> statement-breakpoint
WITH declared AS (
  SELECT agent.id AS profile_id, agent.updated_at, entry.server, entry.server->>'name' AS name,
    entry.ordinal
  FROM profiles agent
  CROSS JOIN LATERAL jsonb_array_elements(agent.mcp_servers) WITH ORDINALITY AS entry(server, ordinal)
),
-- One per distinct definition, taken from the newest agent that declares it.
definitions AS (
  SELECT DISTINCT ON (name, server) profile_id, updated_at, name, server, ordinal
  FROM declared
  ORDER BY name, server, updated_at DESC, profile_id
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY name ORDER BY updated_at DESC, profile_id) AS standing
  FROM definitions
),
named AS (
  SELECT *,
    CASE WHEN standing = 1 THEN name
      ELSE left(name, 30 - length('_' || standing)) || '_' || standing
    END AS target
  FROM ranked
),
kept AS (
  INSERT INTO mcp_servers (name, server, position)
  SELECT target, jsonb_set(server, '{name}', to_jsonb(target)),
    (row_number() OVER (ORDER BY updated_at DESC, profile_id, ordinal)) - 1
  FROM named
  ON CONFLICT (name) DO NOTHING
  RETURNING name
)
INSERT INTO mcp_secret_moves (profile_id, from_name, to_name)
SELECT profile_id, name, target FROM named WHERE target IN (SELECT name FROM kept);
--> statement-breakpoint
-- What the merge did not keep loses its secrets: a duplicate's are the kept server's copy.
DELETE FROM secrets
WHERE left(name, 4) = 'mcp:'
  AND NOT EXISTS (
    SELECT 1 FROM mcp_secret_moves move
    WHERE move.profile_id = secrets.profile_id
      AND (
        secrets.name = 'mcp:' || move.from_name
        OR left(secrets.name, length(move.from_name) + 5) = 'mcp:' || move.from_name || ':'
      )
  );
--> statement-breakpoint
UPDATE profile_revisions SET document = document - 'mcpServers' WHERE document ? 'mcpServers';
--> statement-breakpoint
ALTER TABLE profiles DROP COLUMN mcp_servers;
