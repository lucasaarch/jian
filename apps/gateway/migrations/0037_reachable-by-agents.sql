-- Off, the profile leaves the list other agents read and can no longer call or be called.
ALTER TABLE "profiles" ADD COLUMN "reachable_by_agents" boolean NOT NULL DEFAULT true;
