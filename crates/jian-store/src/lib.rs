//! Persistence through sqlx on Postgres: one the gateway embeds and runs itself, or an external
//! one named by a connection URL, with a schema and a role for each tenant.
//!
//! It owns the single connection pool, the embedded server's life (data directory, credentials,
//! start and stop), the migrations, and the way every query reaches a tenant's data. It does not
//! decide anything about the domain (that is `jian-core`), authenticate anyone, call a model or
//! run a command, and it reads no environment: the binary passes the data directory and the URL
//! in. `jian-runtime` and `jian-server` talk to it.
//!
//! # Tenants
//!
//! A tenant is a schema `tenant_<id>` and a role of the same name that cannot log in, owns the
//! schema and has no right anywhere else. The platform's own data (the list of tenants) is in
//! the schema `platform`, owned by the role `jian_platform`, which no tenant can reach. A shared
//! Cloud gateway has many tenants; a desktop or self-hosted install has one,
//! [`TenantId::self_hosted`].
//!
//! There is one pool, and its user is the database's owner. Every tenant transaction starts with
//! `SET LOCAL ROLE tenant_<id>` and `SET LOCAL search_path TO tenant_<id>` ([`Database::begin`]),
//! and it takes a [`TenantCtx`] to do so, which only [`Database::tenant`] makes. `LOCAL` ends both
//! with the transaction, so a pooled connection never carries one tenant's role to the next.
//!
//! # Slots
//!
//! A tenant hashes to one of 1024 slots ([`slot_of`]), and a slot is owned by at most one
//! gateway instance at a time through a lease in `platform.slot_leases` that expires
//! ([`Database::claim_slots`]). The store holds the SQL and the numbers; keeping the leases
//! renewed and stopping to serve when one is lost is `jian-server`'s. The tables are ephemeral
//! coordination state, so there is nothing of the old Jian to import into them.
//!
//! # Jobs
//!
//! The durable job queue is the table `platform.jobs` ([`Database::enqueue_job`],
//! [`Database::claim_jobs`] and the calls that answer for a job). An instance takes only the jobs
//! of the slots it owns, with `FOR UPDATE SKIP LOCKED`, and an answer counts only from the
//! instance and attempt that holds the job. A payload holds ids and never a secret. The polling
//! loop, the handlers and the drain are `jian-server`'s. Jobs of the old Node gateway's pg-boss
//! are not imported.
//!
//! # Users and sessions
//!
//! A tenant's people are rows of its `users` table: an email address, a role (`admin` or
//! `member`) and an argon2id password hash ([`PasswordParams`]). Nobody signs themselves up: a
//! user is added by an admin ([`Database::add_user`], [`Database::invite_user`]) or is the first
//! admin ([`Database::create_first_admin`]), which is also what the import of the old Jian calls.
//! [`Database::login`] turns an address and a password into a session, a token of kind
//! `session` in `platform.api_tokens` that expires, belongs to the user and ends when the user
//! signs out, changes their password, is reset or is disabled. Everything but the login itself
//! runs as the tenant's role, so another tenant cannot reach a user. Login by password is for a
//! self-hosted install; the Cloud signs people in by other means and leaves the password
//! column empty.
//!
//! # Migrations and schema versions
//!
//! [`Database::migrate`] brings the platform and then every tenant to the last migration, a few
//! tenants at a time ([`MigrateOptions::concurrency`], 4 by default), each in its own transaction:
//! one that fails is left as it was, named in the [`MigrationReport`], and does not stop the rest.
//! One connection holds the advisory lock for the whole run and the tenants use others, so two
//! gateways still take turns. The report also says which version each schema is at, and which
//! are behind or ahead of the build ([`Database::schema_versions`] reads the same without
//! migrating).
//!
//! [`Database::tenant`] and [`Database::begin`] refuse a tenant that is not at the version the
//! build expects, behind or ahead, with [`StoreError::SchemaBehind`] or
//! [`StoreError::SchemaAhead`]. The check is remembered per tenant, so a request pays for it once
//! after each `migrate`, not on every call.
//!
//! # Secrets
//!
//! Provider keys, OAuth tokens and channel credentials live in each tenant's `secrets` table,
//! only as AES-256-GCM envelopes ([`secrets`]). A tenant has one random data key, kept in
//! `platform.tenant_keys` wrapped by a master key; the master key sits behind
//! [`secrets::MasterKeys`], and [`Database::with_master_keys`] gives the database one. A dump of
//! the database holds ciphertext and wrapped keys, nothing readable. Rotating the master key
//! ([`Database::rotate_master_keys`]) rewraps the data keys and leaves every secret as it is.
//!
//! The library reads no environment. The `jian` binary builds a [`secrets::LocalKeyring`] from
//! `JIAN_MASTER_KEYS` (JSON of key ids to base64 keys) with `JIAN_ACTIVE_KEY_ID`, or from
//! `JIAN_MASTER_KEY` (one base64 key, id `local`), and when neither is set from `master.key` in
//! the data directory, generated on the first start (mode 0600 on Unix). A tenant made before
//! secrets existed, or without master keys, gets its data key with its first secret.
//!
//! # What this protects against, and what it does not
//!
//! The role is the wall: a query as `tenant_b` cannot read or write `tenant_a` or `platform`
//! whatever its `search_path` says or however it names a table. PUBLIC's rights on the `public`
//! schema and to create temporary tables are revoked, so there is no shared place to leave data.
//!
//! The wall holds against a mistake in the store's code, such as a query that forgets the
//! schema. It does **not** hold against SQL written by someone else. The pool's user is the
//! owner, and a transaction can `RESET ROLE` back to it or `SET ROLE` to any other tenant's role:
//! Postgres checks `SET ROLE` against the user that logged in, not the current role, and
//! `SET SESSION AUTHORIZATION` would not change that. So the SQL a tenant transaction runs is the
//! store's own, with parameters bound, and never text a user or a model wrote. Tenant names stay
//! visible to every role in the catalog (`pg_namespace`), and any role may take advisory locks.
//!
//! # Database user
//!
//! The embedded server's user is a superuser. An external one must be able to create roles
//! (`CREATEROLE`) and own the database: it creates, grants and drops the tenant roles.

mod backup;
mod database;
mod devices;
pub mod embedded;
mod error;
mod jobs;
mod legacy;
mod machines;
mod migrate;
#[cfg(unix)]
mod orphan;
mod passwords;
mod platform;
mod schema_version;
pub mod secrets;
mod slots;
mod subjects;
mod tenant;
mod tenants;
mod tokens;
mod users;

pub use backup::tenant_dump_args;
pub use database::{Database, DatabaseHealth, DatabaseSource, DatabaseUrl};
pub use devices::Device;
pub use error::StoreError;
pub use jobs::{
    Enqueued, Failure, Job, JobId, JobState, JobWakeups, MAX_ATTEMPTS, MAX_ERROR_CHARS,
    MAX_PAYLOAD_BYTES, NewJob, PURGE_BATCH, RetryPolicy,
};
pub use legacy::{DeviceImport, ImportOutcome, LegacyDevice, LegacyMachine, MachineImport};
pub use machines::{MAX_PAGE, Machine, MachineReport, Page};
pub use migrate::{MigrateOptions, MigrationReport, Migrations};
pub use passwords::{MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS, PasswordParams};
pub use schema_version::{SchemaState, TenantVersion};
pub use slots::{
    HeldSlot, InstanceId, SLOT_COUNT, SlotClaim, SlotId, SlotOptions, SlotRow, slot_of,
};
pub use tenant::{TenantCtx, TenantId};
pub use tenants::TenantStatus;
pub use tokens::{
    Authenticated, DeviceId, MachineId, Subject, TokenHash, TokenKind, UserId, generate_token,
};
pub use users::{Invite, Login, LoginOutcome, NewUser, Role, User, normalize_email};
