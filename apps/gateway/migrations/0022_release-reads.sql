CREATE TABLE release_reads (
  scope text PRIMARY KEY,
  version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
