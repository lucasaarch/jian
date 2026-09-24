CREATE TABLE gateway_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE schedules (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  instruction text NOT NULL,
  at timestamptz,
  cron text,
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_id uuid,
  last_error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((at IS NULL) <> (cron IS NULL))
);
--> statement-breakpoint
CREATE INDEX schedules_profile ON schedules (profile_id, created_at);
--> statement-breakpoint
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;
--> statement-breakpoint
CREATE TABLE schedule_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  manual boolean NOT NULL DEFAULT false,
  run_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, created_at DESC);
