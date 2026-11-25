use std::path::PathBuf;

use sqlx::migrate::MigrateError;

use crate::TenantId;

/// What can go wrong opening, running or closing the database.
///
/// No variant carries a connection URL or a password, so a message is safe to log.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The data directory was written by a Postgres major this build does not run. Jian never
    /// upgrades a data directory by itself; the files are left as they were.
    #[error(
        "the Postgres data directory {path} is from version {found}, but this build runs {expected}; \
         it is not upgraded automatically"
    )]
    UnsupportedMajor {
        /// The `pgdata` directory that holds the `PG_VERSION` file.
        path: PathBuf,
        /// What `PG_VERSION` says, trimmed (`17`).
        found: String,
        /// The major this build runs.
        expected: u32,
    },
    /// A file or directory of the embedded server could not be read or written.
    #[error("cannot access {path}: {source}")]
    Io {
        /// The file or directory.
        path: PathBuf,
        /// The operating system's reason.
        source: std::io::Error,
    },
    /// The embedded server failed to install, initialise, start or stop.
    #[error("embedded Postgres could not {action}: {source}")]
    Embedded {
        /// What was being done: `install and initialise`, `start`, `stop`.
        action: &'static str,
        /// What the server's tooling said.
        source: postgresql_embedded::Error,
    },
    /// A Postgres of this data directory outlived an earlier gateway and would not stop. It is
    /// left running; stop it by hand (`pg_ctl stop -m fast -D <pgdata>`) and start again.
    #[error(
        "the Postgres of {pgdata} (pid {pid}) is still running from an earlier start and would not stop: {reason}"
    )]
    OrphanedServer {
        /// The postmaster's process id, from `postmaster.pid`.
        pid: u32,
        /// The cluster directory.
        pgdata: PathBuf,
        /// What `pg_ctl stop` printed.
        reason: String,
    },
    /// The database did not accept a connection or answer `SELECT 1`.
    #[error("cannot connect to the database: {0}")]
    Connect(#[source] sqlx::Error),
    /// A statement failed: the tenant's setup, a lookup, or a transaction that would not open.
    #[error("the database failed to {action}: {source}")]
    Query {
        /// What was being done, as a verb phrase: `create a tenant`.
        action: &'static str,
        /// What Postgres said.
        source: sqlx::Error,
    },
    /// Text that is not a valid tenant id (`[a-z0-9]{1,48}`). It is cut to 80 characters.
    #[error("{0:?} is not a tenant id: use 1 to 48 lowercase letters and digits")]
    InvalidTenantId(String),
    /// No tenant has this id.
    #[error("there is no tenant {0}")]
    TenantNotFound(TenantId),
    /// A platform migration failed, was edited after it was applied, or is missing. Nothing of
    /// the platform's migrations stays applied.
    #[error("the platform migrations failed: {0}")]
    PlatformMigration(#[source] MigrateError),
    /// A migration of one tenant failed. Nothing of that tenant's migrations stays applied, and
    /// other tenants are not affected.
    #[error("the migrations of tenant {tenant} failed: {source}")]
    TenantMigration {
        /// The tenant whose schema was being migrated.
        tenant: TenantId,
        /// Which migration, and why. A migration edited after it was applied says so here.
        source: MigrateError,
    },
}

impl StoreError {
    /// The `map_err` argument that names what a failed statement was for.
    pub(crate) fn query(action: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |source| Self::Query { action, source }
    }
}
