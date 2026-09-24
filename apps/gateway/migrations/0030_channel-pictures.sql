-- What profile picture each channel last showed, as `<address>:<hash>`, or `<address>:none`
-- once removed; a new account on the channel, or a new picture, no longer matches.
ALTER TABLE "channels" ADD COLUMN "picture_synced" text;
