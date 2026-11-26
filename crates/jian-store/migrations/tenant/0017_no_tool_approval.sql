-- Agents are bots: no run waits for a person to allow a tool call. The `waiting_approval` run
-- state becomes the generic `waiting` (parked on a call with no answer yet: a subagent's report
-- today), and the approvals table goes.
--
-- A run parked on an approval nobody answered cannot go on: its tool call is in the thread
-- without a result, and the decision it waited for no longer exists. It ends `failed` with a
-- reason (nothing is lost: its messages stay, and the agent can be asked again). A subagent
-- whose run ends this way is closed with it, so it stops counting as running.
UPDATE runs
   SET state = 'failed',
       error = 'the run waited on a tool approval, which no longer exists',
       resume = NULL,
       finished_at = now(),
       updated_at = now()
 WHERE state = 'waiting_approval'
   AND EXISTS (SELECT 1 FROM run_approvals a WHERE a.run_id = runs.id AND a.state = 'pending');

UPDATE subagents
   SET state = 'failed',
       report = 'the subagent failed: the run waited on a tool approval, which no longer exists',
       finished_at = now()
 WHERE state = 'running'
   AND child_run IN (
       SELECT id FROM runs
        WHERE state = 'failed'
          AND error = 'the run waited on a tool approval, which no longer exists');

DROP TABLE run_approvals;

-- What is left in `waiting_approval` waits on a subagent: the same pause, under its new name.
DROP INDEX runs_one_active;
ALTER TABLE runs DROP CONSTRAINT runs_state_check;
UPDATE runs SET state = 'waiting' WHERE state = 'waiting_approval';
ALTER TABLE runs
    ADD CONSTRAINT runs_state_check
        CHECK (state IN ('queued', 'running', 'waiting', 'done', 'failed', 'stopped'));
CREATE UNIQUE INDEX runs_one_active ON runs (thread_id, agent_id)
    WHERE state IN ('queued', 'running', 'waiting');
