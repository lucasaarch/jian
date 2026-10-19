-- Agent-operated event subscriptions (GitHub CI/merge wake MVP).
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  instruction text NOT NULL,
  source text NOT NULL,
  filter jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  secret_hash text NOT NULL,
  last_wake_at timestamptz,
  last_run_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX subscriptions_profile ON subscriptions (profile_id, created_at);
--> statement-breakpoint
CREATE TABLE subscription_deliveries (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  delivery_key text NOT NULL,
  event text NOT NULL,
  run_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, delivery_key)
);
--> statement-breakpoint
CREATE INDEX subscription_deliveries_subscription ON subscription_deliveries (
  subscription_id,
  created_at DESC
);
