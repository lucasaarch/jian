//! Where the old Jian's data is, and how to open it for reading.

use std::fmt::Write as _;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::str::FromStr as _;

use jian_store::DatabaseUrl;
use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use sha2::{Digest as _, Sha256};
use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions as _, PgConnection};

use crate::ImportError;
use crate::reader::LegacyReader;

/// How many hex digits of a dump's SHA-256 name it in a marker: enough to tell two exports
/// apart, short enough to read.
const DUMP_ID_DIGITS: usize = 16;

/// The old Jian's data.
#[derive(Clone, Debug)]
pub enum Source {
    /// The old gateway's own Postgres (`DATABASE_URL` of a server install). Read in a read-only
    /// transaction; nothing is ever written to it.
    Postgres(DatabaseUrl),
    /// A SQL file made by `pg_dump` from the old desktop app's `PGlite` database. It is loaded
    /// into a scratch Postgres of its own and read from there, so the file is never changed and
    /// the install's own database never holds a copy of the old tables.
    Dump(PathBuf),
}

impl Source {
    /// Reads what a person or a variable gave: a `postgres://` URL, or the path of a SQL file.
    ///
    /// The old desktop app's `PGlite` directory is recognised and refused with the way out, since
    /// a native Postgres cannot open it.
    pub fn parse(text: &str) -> Result<Self, ImportError> {
        let text = text.trim();
        if text.starts_with("postgres://") || text.starts_with("postgresql://") {
            return Ok(Self::Postgres(DatabaseUrl::new(text)));
        }
        let path = PathBuf::from(text);
        if path.join("PG_VERSION").is_file() {
            return Err(ImportError::PgliteDirectory(path));
        }
        if path.is_file() {
            Ok(Self::Dump(path))
        } else {
            Err(ImportError::Missing(path))
        }
    }

    /// What a marker says the data came from, with no password: `postgres:host:port/database`,
    /// or `dump:` and the start of the file's SHA-256, so a different export is a different
    /// source.
    pub fn describe(&self) -> Result<String, ImportError> {
        match self {
            Self::Postgres(url) => {
                let options =
                    PgConnectOptions::from_str(url.expose()).map_err(|_| ImportError::BadUrl)?;
                Ok(format!(
                    "postgres:{}:{}/{}",
                    options.get_host(),
                    options.get_port(),
                    options.get_database().unwrap_or("")
                ))
            }
            Self::Dump(path) => Ok(format!("dump:{}", short_hash(path)?)),
        }
    }

    /// Opens the data for reading, in one read-only transaction that sees one moment of it.
    ///
    /// A dump needs a scratch server: `scratch_dir` is where it lives for the run, emptied
    /// before and removed after. It is ignored for a `Postgres` source.
    pub async fn open(&self, scratch_dir: &Path) -> Result<LegacyReader, ImportError> {
        match self {
            Self::Postgres(url) => {
                let connection = read_only(url).await?;
                Ok(LegacyReader::new(connection, None))
            }
            Self::Dump(path) => {
                // A run that was killed leaves its scratch behind; it is ours to clear.
                let _ = fs::remove_dir_all(scratch_dir);
                let server = EmbeddedPostgres::start(&EmbeddedConfig {
                    data_dir: scratch_dir.to_path_buf(),
                    port: 0,
                })
                .await?;
                server.run_sql_file(path).await?;
                let connection = read_only(server.url()).await?;
                Ok(LegacyReader::new(
                    connection,
                    Some((server, scratch_dir.to_path_buf())),
                ))
            }
        }
    }
}

/// A connection whose every transaction is read-only (the session default, so a statement
/// that starts its own transaction cannot escape it), inside one explicit read-only
/// transaction at `REPEATABLE READ`: every table is read as of the same moment.
async fn read_only(url: &DatabaseUrl) -> Result<PgConnection, ImportError> {
    let options = PgConnectOptions::from_str(url.expose())
        .map_err(|_| ImportError::BadUrl)?
        .options([("default_transaction_read_only", "on")]);
    let mut connection = options.connect().await.map_err(ImportError::Source)?;
    sqlx::query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut connection)
        .await
        .map_err(ImportError::Source)?;
    Ok(connection)
}

/// The first digits of the file's SHA-256, read in blocks so a large export is not held in memory.
fn short_hash(path: &Path) -> Result<String, ImportError> {
    let io = |source| ImportError::File {
        path: path.to_path_buf(),
        source,
    };
    let mut file = fs::File::open(path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut block = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut block).map_err(io)?;
        if read == 0 {
            break;
        }
        hasher.update(&block[..read]);
    }
    let mut hex = String::new();
    for byte in hasher.finalize() {
        // Writing to a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex.truncate(DUMP_ID_DIGITS);
    Ok(hex)
}
