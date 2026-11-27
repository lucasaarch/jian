-- People: what one agent knows about someone, across every channel. A person is a profile of
-- KNOWLEDGE, never of access: it says who someone is to this agent, not what they may reach.
--
-- A person belongs to ONE agent. Another agent, or another tenant, does not see it, and a person
-- outside the workspace never becomes a member. `creator` is the agent's own creator (one per
-- agent); `known` is someone the agent talks to; `blocked` gets no answer at all.
CREATE TABLE people (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (btrim(name) <> ''),
    role text NOT NULL CHECK (role IN ('creator', 'known', 'blocked')),
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_by_agent ON people (agent_id, seq);
CREATE UNIQUE INDEX people_one_creator ON people (agent_id) WHERE role = 'creator';

-- How a person is reached. An address is the provider's own id for them (a number, a chat id,
-- a handle) and `jian` is a member's account id. One address is ONE person of an agent: that is
-- what lets a message from any channel find the same person.
CREATE TABLE person_identities (
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    channel text NOT NULL
        CHECK (channel IN ('whatsapp', 'telegram', 'discord', 'slack', 'teams', 'jian')),
    address text NOT NULL CHECK (btrim(address) <> ''),
    person_id text NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, channel, address)
);
CREATE INDEX person_identities_person ON person_identities (person_id);

-- The agent's notes about a person are memories of the agent, linked here. The memory stays the
-- one place a note is stored; deleting it takes the link with it.
CREATE TABLE person_notes (
    person_id text NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    agent_id text NOT NULL,
    memory_key text NOT NULL,
    PRIMARY KEY (person_id, memory_key),
    FOREIGN KEY (agent_id, memory_key) REFERENCES memories (agent_id, key) ON DELETE CASCADE
);

-- A new identity for a person that exists is only asked for: it is linked when the agent's
-- creator confirms (`code` is what they send back). Without this, "it's me, I changed number"
-- from a stranger would be enough to inherit someone's standing.
CREATE TABLE identity_link_requests (
    id text PRIMARY KEY,
    agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    code text NOT NULL,
    person_id text NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    channel text NOT NULL
        CHECK (channel IN ('whatsapp', 'telegram', 'discord', 'slack', 'teams', 'jian')),
    address text NOT NULL CHECK (btrim(address) <> ''),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'declined')),
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz
);
CREATE UNIQUE INDEX identity_link_pending
    ON identity_link_requests (agent_id, channel, address) WHERE state = 'pending';
CREATE UNIQUE INDEX identity_link_code ON identity_link_requests (agent_id, code);

-- A run for someone the agent does not know: a few tools, none of them data (see `run_job`).
ALTER TABLE runs
    DROP CONSTRAINT runs_origin_check,
    ADD CONSTRAINT runs_origin_check
        CHECK (origin IN ('message', 'continue', 'subagent', 'wake', 'schedule', 'stranger'));

-- Every agent has its creator as a person, with the account they sign in with and the number
-- an agent's channel account named as its owner.
INSERT INTO people (id, agent_id, name, role, created_by)
SELECT 'per_c_' || md5(id), id, 'Creator', 'creator', created_by FROM agents
ON CONFLICT DO NOTHING;

INSERT INTO person_identities (agent_id, channel, address, person_id)
SELECT id, 'jian', created_by, 'per_c_' || md5(id) FROM agents
ON CONFLICT DO NOTHING;

INSERT INTO person_identities (agent_id, channel, address, person_id)
SELECT a.agent_id, a.provider, a.owner_address, 'per_c_' || md5(a.agent_id)
FROM channel_accounts a WHERE a.owner_address IS NOT NULL
ON CONFLICT DO NOTHING;

-- What `channel_contacts` decided is not lost: approved becomes `known`, declined `blocked`. A
-- `pending` one becomes nobody and is a stranger again, which is what it was. The ids come from
-- the contact, so nothing needs to be remembered between the two statements.
-- `channel_contacts` itself stays, no longer written or read: a table is dropped in a release
-- after the one that stopped using it.
INSERT INTO people (id, agent_id, name, role, created_by)
SELECT 'per_m_' || md5(c.account_id || ':' || c.address), a.agent_id,
       COALESCE(NULLIF(btrim(c.display_name), ''), c.address),
       CASE c.status WHEN 'approved' THEN 'known' ELSE 'blocked' END,
       c.decided_by
FROM channel_contacts c
JOIN channel_accounts a ON a.id = c.account_id
WHERE c.status IN ('approved', 'declined')
  AND NOT EXISTS (
      SELECT 1 FROM person_identities i
      WHERE i.agent_id = a.agent_id AND i.channel = a.provider AND i.address = c.address)
ON CONFLICT DO NOTHING;

INSERT INTO person_identities (agent_id, channel, address, person_id, display_name)
SELECT a.agent_id, a.provider, c.address,
       'per_m_' || md5(c.account_id || ':' || c.address), c.display_name
FROM channel_contacts c
JOIN channel_accounts a ON a.id = c.account_id
WHERE c.status IN ('approved', 'declined')
  AND EXISTS (SELECT 1 FROM people p WHERE p.id = 'per_m_' || md5(c.account_id || ':' || c.address))
ON CONFLICT DO NOTHING;
