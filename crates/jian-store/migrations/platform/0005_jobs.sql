-- The durable job queue: runs, schedules, channel deliveries and webhooks wait here, in Postgres
-- and nowhere else, so a job survives the instance that was going to run it. One table for every
-- tenant (not one per tenant schema): an instance asks "what is ready in the slots I own" in one
-- statement, and 1024 schemas would make that 1024 statements.
--
-- `slot` is `jian_store::slot_of(tenant_id)` written at insertion. It is what ties a job to the
-- instance that owns the tenant, and it never changes, so it can be indexed.
--
-- A job is `queued` until an instance claims it (`running`, with the instance in `locked_by`, a
-- deadline in `locked_until` and the slot's epoch in `lease_epoch`), then `done`, back to
-- `queued` after a failure (with a later `run_at`), or `dead` when it has no attempts left or
-- failed for good. There is no resting "failed" state: a failure either schedules a retry or is
-- dead. `attempts` counts claims, and doubles as the token of one claim: a late answer from an
-- attempt that was taken away carries an older number and is refused.
--
-- `payload` holds ids and small parameters, never a secret: a job is readable by anyone who can
-- read the platform schema, and it is kept after it is dead. `last_error` is cut and holds no
-- secret either. Nothing of the old Jian's pg-boss queue is imported: its jobs are short-lived,
-- and schedules are recreated by the schedules import.
CREATE TABLE jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    slot integer NOT NULL CHECK (slot >= 0 AND slot < 1024),
    kind text NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    payload jsonb NOT NULL DEFAULT '{}',
    idempotency_key text CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'dead')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
    run_at timestamptz NOT NULL DEFAULT now(),
    locked_by uuid,
    locked_until timestamptz,
    lease_epoch bigint,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    -- A lock exists exactly while the job runs.
    CHECK ((state = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL))
);

-- The same work asked twice is one job: enqueue with a key that exists returns the existing row.
-- It holds after the job is done, until the cleanup deletes it.
CREATE UNIQUE INDEX jobs_idempotency ON jobs (tenant_id, kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- What is ready to run, oldest first, and the same per slot: an instance asks for its slots.
CREATE INDEX jobs_ready ON jobs (run_at) WHERE state = 'queued';
CREATE INDEX jobs_ready_slot ON jobs (slot, run_at) WHERE state = 'queued';

-- Jobs whose instance went away: the reaper looks for the deadlines that passed.
CREATE INDEX jobs_running ON jobs (locked_until) WHERE state = 'running';

-- The cleanup of finished jobs, and the release of one instance's jobs when it drains.
CREATE INDEX jobs_done ON jobs (finished_at) WHERE state = 'done';
CREATE INDEX jobs_locked_by ON jobs (locked_by) WHERE state = 'running';
