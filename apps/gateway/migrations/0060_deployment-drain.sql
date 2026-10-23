CREATE TABLE deployment_drain_generations (
  id text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
--> statement-breakpoint
CREATE TABLE deployment_drain (
  id integer PRIMARY KEY CONSTRAINT deployment_drain_singleton CHECK (id = 1),
  owner text,
  phase text CONSTRAINT deployment_drain_phase CHECK (phase IN ('draining', 'holding')),
  expires_at timestamptz
);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN execution_owner text;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN execution_until timestamptz;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN pending_session_effects jsonb;
--> statement-breakpoint
CREATE INDEX runs_execution_owner ON runs (execution_owner) WHERE execution_owner IS NOT NULL;
