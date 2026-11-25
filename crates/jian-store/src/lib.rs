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
pub mod embedded;
mod error;
mod migrate;
mod platform;
mod tenant;
mod tenants;

pub use backup::tenant_dump_args;
pub use database::{Database, DatabaseHealth, DatabaseSource, DatabaseUrl};
pub use error::StoreError;
pub use migrate::{MigrationReport, Migrations};
pub use tenant::{TenantCtx, TenantId};
pub use tenants::TenantStatus;
