//! The Postgres that runs inside Jian's own data directory, for a desktop or a self-hosted install
//! that names no external database.
//!
//! The server's binaries are in this crate's build (see `postgresql_embedded`'s `bundled`
//! feature), so nothing is downloaded when it starts. They are unpacked once into the data
//! directory, next to the cluster:
//!
//! ```text
//! <data_dir>/postgres/<version>/   the unpacked server
//! <data_dir>/pgdata/               the cluster; `PG_VERSION` says which major wrote it
//! <data_dir>/password              the superuser's password, mode 0600 on Unix
//! ```

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use postgresql_embedded::{PostgreSQL, Settings};

use crate::{DatabaseUrl, StoreError, orphan};

/// The only Postgres major this build runs. It must match `POSTGRESQL_VERSION` in
/// `.cargo/config.toml`, which decides what is bundled. A cluster is not portable across majors,
/// and upgrading one (`pg_upgrade`) is a decision for a person, not for a boot.
pub const MAJOR_VERSION: u32 = 18;

/// The longest the server's own tools (`initdb`, `pg_ctl start`, `pg_ctl stop`) may take. Far
/// above a normal run so a slow disk or an antivirus scan on first start does not look like a
/// failure; a hang still ends.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Loopback by literal address: `localhost` may resolve to `::1` first, where nothing listens on
/// a machine without IPv6.
const HOST: &str = "127.0.0.1";

/// Where the embedded server lives and which port it takes.
#[derive(Clone, Debug)]
pub struct EmbeddedConfig {
    /// The directory that holds the cluster, the unpacked server and the password. Created when
    /// missing.
    pub data_dir: PathBuf,
    /// The TCP port on loopback. `0` takes a free one at each start; the URL says which.
    pub port: u16,
}

/// A running embedded Postgres. Dropping it stops the server too, but only [`stop`] reports
/// whether that worked.
///
/// [`stop`]: EmbeddedPostgres::stop
pub struct EmbeddedPostgres {
    server: PostgreSQL,
    url: DatabaseUrl,
}

impl EmbeddedPostgres {
    /// Unpacks the server on first use, creates the cluster on first use, and starts it. A second
    /// start in the same directory reuses both, and a server that was killed recovers from its
    /// write-ahead log. A server of this directory that outlived the last gateway (it took
    /// `SIGKILL`) is stopped first, so it does not block the start.
    ///
    /// Fails with [`StoreError::UnsupportedMajor`] before touching any file when the directory
    /// holds a cluster of another major.
    pub async fn start(config: &EmbeddedConfig) -> Result<Self, StoreError> {
        let pgdata = config.data_dir.join("pgdata");
        check_major(&pgdata)?;
        fs::create_dir_all(&config.data_dir).map_err(|source| StoreError::Io {
            path: config.data_dir.clone(),
            source,
        })?;

        let defaults = Settings::default();
        let password_file = config.data_dir.join("password");
        let password = read_or_create_password(&password_file, &defaults.password)?;
        discard_scratch_paths(&defaults);

        let settings = Settings {
            installation_dir: config.data_dir.join("postgres"),
            password_file,
            data_dir: pgdata,
            host: HOST.to_owned(),
            port: config.port,
            password,
            temporary: false,
            timeout: Some(COMMAND_TIMEOUT),
            configuration: server_options(),
            ..defaults
        };
        let mut server = PostgreSQL::new(settings);
        server
            .setup()
            .await
            .map_err(|source| StoreError::Embedded {
                action: "install and initialise",
                source,
            })?;
        // After `setup` so `pg_ctl` is unpacked, before `start` so a leftover server does not
        // fail it.
        orphan::clear(
            &server.settings().data_dir,
            &server.settings().binary_dir().join("pg_ctl"),
        )?;
        server
            .start()
            .await
            .map_err(|source| StoreError::Embedded {
                action: "start",
                source,
            })?;
        // Read after `start`: with port 0 the server picks the port there.
        let url = DatabaseUrl::new(
            server
                .settings()
                .url(postgresql_embedded::BOOTSTRAP_DATABASE),
        );
        tracing::info!(port = server.settings().port, "embedded Postgres started");
        Ok(Self { server, url })
    }

    /// How to connect to it. Holds the password: see [`DatabaseUrl`].
    pub fn url(&self) -> &DatabaseUrl {
        &self.url
    }

    /// Shuts the server down cleanly (a fast shutdown: sessions end, the cluster is checkpointed)
    /// and waits for it.
    pub async fn stop(self) -> Result<(), StoreError> {
        self.server
            .stop()
            .await
            .map_err(|source| StoreError::Embedded {
                action: "stop",
                source,
            })?;
        tracing::info!("embedded Postgres stopped");
        Ok(())
    }
}

/// What the server is started with beyond the defaults: reachable by TCP on loopback only.
fn server_options() -> HashMap<String, String> {
    let mut options = HashMap::new();
    options.insert("listen_addresses".to_owned(), HOST.to_owned());
    // No Unix socket: its default place is /tmp, shared with every other Postgres on the machine
    // and not always writable (a locked-down container fails to start on the lock file there).
    // Windows has no such setting.
    #[cfg(unix)]
    options.insert("unix_socket_directories".to_owned(), String::new());
    options
}

/// Refuses a cluster written by another major. A directory with no cluster yet passes.
fn check_major(pgdata: &Path) -> Result<(), StoreError> {
    let version_file = pgdata.join("PG_VERSION");
    let found = match fs::read_to_string(&version_file) {
        Ok(text) => text.trim().to_owned(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(StoreError::Io {
                path: version_file,
                source,
            });
        }
    };
    if found == MAJOR_VERSION.to_string() {
        return Ok(());
    }
    Err(StoreError::UnsupportedMajor {
        path: pgdata.to_path_buf(),
        found,
        expected: MAJOR_VERSION,
    })
}

/// The superuser's password: the one stored from an earlier start, or `generated` stored now.
/// Generated once, because the cluster keeps the password it was initialised with.
fn read_or_create_password(file: &Path, generated: &str) -> Result<String, StoreError> {
    let io_error = |source| StoreError::Io {
        path: file.to_path_buf(),
        source,
    };
    match fs::read_to_string(file) {
        Ok(text) if !text.trim().is_empty() => return Ok(text.trim().to_owned()),
        Ok(_) => {} // An earlier start died between creating the file and writing it.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    // Set when the file is created, so there is no moment where others can read it.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = options.open(file).map_err(io_error)?;
    handle.write_all(generated.as_bytes()).map_err(io_error)?;
    Ok(generated.to_owned())
}

/// `Settings::default()` creates a temporary data directory and a password folder that this
/// module replaces. Removing them keeps the system temp directory clean at each start.
fn discard_scratch_paths(defaults: &Settings) {
    // Best effort: a leftover empty directory is harmless, so failures are not worth reporting.
    let _ = fs::remove_dir(&defaults.data_dir);
    if let Some(parent) = defaults.password_file.parent() {
        let _ = fs::remove_dir(parent);
    }
}
