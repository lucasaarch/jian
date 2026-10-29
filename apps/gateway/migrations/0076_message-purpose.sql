-- A turn the gateway writes around a pause: the reply that answered a question or decided an
-- approval ('answer'), and the note that tells the agent to carry on ('resume'). The agent
-- reads them as before; the panel shows them inside the question or approval card, or not at
-- all. Older rows carry no purpose and read as ordinary turns.
ALTER TABLE "messages" ADD COLUMN "purpose" text;
