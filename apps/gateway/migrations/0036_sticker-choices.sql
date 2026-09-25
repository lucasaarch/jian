-- A sticker the cataloguing model declined is kept only as its fingerprint: it is never offered
-- and never described again when someone sends it anew.
ALTER TABLE "stickers" ADD COLUMN "declined" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Off, nothing is kept or described, and the agent has no sticker tools.
ALTER TABLE "profiles" ADD COLUMN "use_stickers" boolean NOT NULL DEFAULT true;
