use std::path::PathBuf;

use jian_store::StoreError;

/// Why an import could not start or go on. A domain that fails does not stop the others: that
/// is recorded in its marker. These are the failures that stop the whole run.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    /// The new database refused something.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The old database's URL cannot be read as a connection. The URL itself is never quoted:
    /// it holds a password.
    #[error("the old database's URL is not a usable postgres:// URL")]
    BadUrl,
    /// The old database did not answer, or a query on it failed.
    #[error("cannot read the old database: {0}")]
    Source(#[source] sqlx::Error),
    /// Nothing is at the path given as the old data.
    #[error("there is nothing to import at {0}")]
    Missing(PathBuf),
    /// The path is the old desktop app's `PGlite` data directory. A native Postgres cannot open it
    /// (it is a 32-bit WebAssembly build), so it has to be exported to a SQL file first.
    #[error(
        "{0} is a PGlite data directory, which this program cannot read; export it to a SQL \
         file with the old app's Node (see the `jian-import` crate docs, \"The PGlite bridge\") \
         and give that file instead"
    )]
    PgliteDirectory(PathBuf),
    /// The export file cannot be read.
    #[error("cannot read {path}: {source}")]
    File {
        /// The file or directory.
        path: PathBuf,
        /// The operating system's reason.
        source: std::io::Error,
    },
}
