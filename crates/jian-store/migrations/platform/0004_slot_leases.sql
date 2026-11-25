-- Which gateway instance serves which tenants. A tenant maps to one of 1024 fixed slots by a
-- stable hash of its id (`jian_store::slot_of`), and a slot is owned by at most one instance at a
-- time, through a lease that expires. Both tables are ephemeral coordination state: nothing in
-- them is worth keeping across a restart, and nothing of the old Jian is imported into them.
--
-- The 1024 rows are made here, once, with no owner, so that taking, renewing and releasing a slot
-- are all plain UPDATEs of an existing row and two instances that start together can only fight
-- over rows, never over which rows exist. The count is part of the hash, so it cannot change
-- without moving every tenant: changing it is a migration of its own.
--
-- `epoch` rises by one every time a slot changes hands (or is taken again after its lease ran
-- out), and never falls. It is the fencing token: whoever writes on behalf of a slot can carry
-- the epoch it was given, and a stale owner's is lower than the current one.
--
-- `expires_at` is read and written only with the database's `now()`, never an instance's clock,
-- so skewed clocks cannot make two instances believe they both hold a slot. It is NULL exactly
-- when `owner` is NULL.
CREATE TABLE slot_leases (
    slot integer PRIMARY KEY CHECK (slot >= 0 AND slot < 1024),
    owner uuid,
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    expires_at timestamptz,
    CHECK ((owner IS NULL) = (expires_at IS NULL))
);

INSERT INTO slot_leases (slot) SELECT generate_series(0, 1023);

-- Whose slots are looked up when an instance renews, and which instances count as alive.
CREATE INDEX slot_leases_owner ON slot_leases (owner) WHERE owner IS NOT NULL;

-- The instances that are alive: one row per running gateway, refreshed by its heartbeat. The
-- share of slots each instance aims for is 1024 divided by how many rows are fresh and not
-- draining. A row that stops being refreshed is dropped a while after it stops counting.
CREATE TABLE instances (
    id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    draining boolean NOT NULL DEFAULT false
);
