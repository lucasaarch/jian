-- Why a run exists beyond a person's message, where a run paused on an approval stands, and the
-- model an agent answers with.
--   origin: 'message' (a person wrote), 'continue' (an objective is still open), 'subagent' (a
--     brief from another run), 'wake' (the agent's inbox told it to). Only 'message' is made today;
--     the rest are the room the next runs of the loop grow into.
--   resume: set while the run waits on an approval and nothing holds its job. It says which call
--     waits (`callId`) and what the loop needs to go on from that call, so whichever worker takes
--     the answer up does not ask the model again.
ALTER TABLE runs
    ADD COLUMN origin text NOT NULL DEFAULT 'message'
        CHECK (origin IN ('message', 'continue', 'subagent', 'wake')),
    ADD COLUMN resume jsonb;

-- What an agent is set up with. No row, or no model, is the workspace default.
CREATE TABLE agent_config (
    agent_id text PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
    model_account text,
    model text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((model_account IS NULL) = (model IS NULL))
);
