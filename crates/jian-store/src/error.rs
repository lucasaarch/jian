use std::path::PathBuf;

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
    /// The database did not accept a connection or answer `SELECT 1`.
    #[error("cannot connect to the database: {0}")]
    Connect(#[source] sqlx::Error),
}
