-- On a message of an agent conversation this profile started: the other profile's run that
-- answers it, so the panel shows that agent working, where it works.
ALTER TABLE "messages" ADD COLUMN "call" jsonb;
