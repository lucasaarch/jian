-- The note that carries an open objective on was written as if the owner had sent it, and the
-- panel showed it as theirs. It is the gateway's, like the note that resumes a pause: marked so,
-- the agent still reads it and the conversation no longer shows it. Only the note itself: a
-- person's message that joined the same run while it worked keeps no purpose.
UPDATE messages
SET purpose = 'resume'
FROM runs
WHERE messages.run_id = runs.id
  AND runs.request_key LIKE 'objective-continue:%'
  AND messages.role = 'user'
  AND messages.purpose IS NULL
  AND messages.content LIKE 'Continue the open session objective.%';
