-- Skills belong to the installation now, not to each agent: one library every agent is offered.
-- What each agent had is merged as 0071 merged MCP servers: a skill several agents hold with the
-- same description and instructions becomes one, taken from the newest agent that has it; two
-- skills with one name and different content both stay, the newest agent's under the plain name
-- and the others as name_2, name_3… Who wrote each one is kept: an agent's own skill records
-- that agent, the only one whose tools may still change it. Each starts at version 1, which
-- counts the changes to what it says from here on.
CREATE TABLE skills (
  name text PRIMARY KEY,
  description text NOT NULL,
  instructions text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  origin jsonb,
  written_by text,
  author_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
WITH declared AS (
  SELECT agent.id AS profile_id, agent.updated_at, entry.skill, entry.skill->>'name' AS name,
    entry.skill->>'description' AS description, entry.skill->>'instructions' AS instructions
  FROM profiles agent
  CROSS JOIN LATERAL jsonb_array_elements(agent.skills) AS entry(skill)
),
-- One per distinct content, taken from the newest agent that holds it. The date of an import
-- is left out of the comparison: two agents that imported the same skill hold the same skill.
definitions AS (
  SELECT DISTINCT ON (name, description, instructions) *
  FROM declared
  ORDER BY name, description, instructions, updated_at DESC, profile_id
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY name ORDER BY updated_at DESC, profile_id) AS standing
  FROM definitions
)
INSERT INTO skills (name, description, instructions, origin, written_by, author_profile_id)
SELECT
  -- A name holds 64 characters, so the suffix takes its room from the end.
  CASE WHEN standing = 1 THEN name
    ELSE left(name, 64 - length('_' || standing)) || '_' || standing
  END,
  description, instructions, skill->'origin', skill->>'writtenBy',
  CASE WHEN skill->>'writtenBy' = 'agent' THEN profile_id END
FROM ranked
ORDER BY standing
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
-- Switching a built-in skill off is the installation's too. One stays on if any agent had it on,
-- so only what every agent had switched off stays off. A name the library now holds is left
-- out: an agent's own skill replaced the built-in one and was never off. With no agent there
-- is no row, and the gateway reads its default.
INSERT INTO gateway_settings (key, value)
SELECT 'disabledSkills', coalesce(jsonb_agg(shared.name ORDER BY shared.name), '[]'::jsonb)
FROM (
  SELECT entry.name
  FROM profiles agent
  CROSS JOIN LATERAL jsonb_array_elements_text(agent.disabled_skills) AS entry(name)
  WHERE entry.name NOT IN (SELECT name FROM skills)
  GROUP BY entry.name
  HAVING count(DISTINCT agent.id) = (SELECT count(*) FROM profiles)
) shared
HAVING (SELECT count(*) FROM profiles) > 0
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
UPDATE profile_revisions SET document = document - 'skills' - 'disabledSkills'
WHERE document ? 'skills' OR document ? 'disabledSkills';
--> statement-breakpoint
ALTER TABLE profiles DROP COLUMN skills;
--> statement-breakpoint
ALTER TABLE profiles DROP COLUMN disabled_skills;
