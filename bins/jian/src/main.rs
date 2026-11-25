//! The gateway binary for a server. The desktop app embeds `jian-server` instead.
//!
//! This is the only place the gateway reads its environment: each flag has a variable that stands
//! in when the flag is absent (`JIAN_ADDR`, `JIAN_DATA_DIR`, `DATABASE_URL`), and `RUST_LOG` sets
//! the log level. The libraries receive the values.

// What a server prints at start-up is this binary's interface to whoever runs it.
#![allow(clippy::print_stdout)]

mod shutdown;

use std::future::IntoFuture as _;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context as _;
use clap::Parser;
use jian_store::embedded::EmbeddedConfig;
use jian_store::{Database, DatabaseSource, DatabaseUrl, TenantId, TenantStatus};
use tokio::sync::oneshot;

use crate::shutdown::Shutdown;

/// Where the gateway listens when nothing says otherwise: loopback only, so an unconfigured
/// install is not reachable from the network.
const DEFAULT_ADDR: &str = "127.0.0.1:4410";

/// How long, after a stop signal, requests in flight may keep running before the server is cut
/// off. Under the 10 s `docker stop` waits before SIGKILL, so the database still gets its clean
/// stop afterwards.
const DRAIN_DEADLINE: Duration = Duration::from_secs(8);

/// The Jian gateway for a server.
#[derive(Parser)]
#[command(name = "jian", version, about)]
struct Cli {
    /// The address to listen on, as `host:port`.
    #[arg(long, env = "JIAN_ADDR", default_value = DEFAULT_ADDR, value_name = "HOST:PORT")]
    addr: String,

    /// Where the embedded Postgres keeps its data. Ignored when a database URL is given. Defaults
    /// to the user's data directory for this operating system.
    #[arg(long, env = "JIAN_DATA_DIR", value_name = "DIR")]
    data_dir: Option<PathBuf>,

    /// A Postgres to use instead of the embedded one, as a `postgres://` URL. It holds a
    /// password, so `--help` does not show its value.
    #[arg(long, env = "DATABASE_URL", value_name = "URL", hide_env_values = true)]
    database_url: Option<String>,
}

impl Cli {
    /// The database to open: the external one when a URL is given (an empty value counts as not
    /// given, as `DATABASE_URL=` in a shell does), otherwise the embedded one.
    fn database_source(self) -> anyhow::Result<DatabaseSource> {
        if let Some(url) = self.database_url.filter(|url| !url.trim().is_empty()) {
            return Ok(DatabaseSource::External(DatabaseUrl::new(url)));
        }
        let data_dir = match self.data_dir {
            Some(dir) => dir,
            None => default_data_dir()?,
        };
        Ok(DatabaseSource::Embedded(EmbeddedConfig {
            data_dir,
            port: 0,
        }))
    }
}

/// `~/.local/share/jian` on Linux, `~/Library/Application Support/jian` on macOS,
/// `%APPDATA%\jian\data` on Windows.
fn default_data_dir() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "jian")
        .context("no home directory to keep data in; pass --data-dir")?;
    Ok(dirs.data_dir().to_path_buf())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let cli = Cli::parse();
    let addr = cli.addr.clone();
    let source = cli.database_source()?;
    match &source {
        DatabaseSource::External(_) => println!("database: external, from DATABASE_URL"),
        DatabaseSource::Embedded(config) => {
            println!(
                "database: embedded Postgres in {}",
                config.data_dir.display()
            );
        }
    }
    let mut shutdown = Shutdown::install().context("cannot listen for stop signals")?;

    let database = Database::open(source)
        .await
        .context("cannot open the database")?;
    // From here the database is up, so every way out goes through `close` below.
    let served = match prepare(&database).await {
        Ok(()) => serve(&addr, &database, &mut shutdown).await,
        Err(error) => Err(error),
    };
    let closed = database
        .close()
        .await
        .context("cannot close the database cleanly");
    served?;
    closed
}

/// Brings the database to the latest migration and makes the one tenant of a self-hosted install.
/// Both are safe to repeat: a second start finds nothing to do.
async fn prepare(database: &Database) -> anyhow::Result<()> {
    let report = database
        .migrate()
        .await
        .context("cannot migrate the database")?;
    // A tenant that cannot be migrated is left as it was and the others are served: the store
    // refuses the one that is behind or ahead when someone asks for it. Only the platform failing
    // (the `?` above) stops the start.
    tracing::info!(
        migrated = report.migrated.len(),
        failed = report.failed.len(),
        behind = report.behind().count(),
        ahead = report.ahead().count(),
        "tenant migrations finished"
    );
    for version in report.behind().chain(report.ahead()) {
        tracing::error!(
            tenant = %version.tenant,
            found = version.found,
            expected = version.expected,
            "tenant schema does not match this build; it will not be served"
        );
    }
    let tenant = TenantId::self_hosted();
    let status = database
        .create_tenant(&tenant)
        .await
        .context("cannot create the tenant")?;
    if status == TenantStatus::Created {
        tracing::info!(%tenant, "created the tenant of this install");
    }
    Ok(())
}

/// Serves until a stop signal, then drains. Returns `Ok` after a clean drain or a drain that hit
/// the deadline; an error only when the address cannot be bound or the server fails by itself.
async fn serve(addr: &str, database: &Database, shutdown: &mut Shutdown) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    println!("jian listening on http://{addr}");
    // There is no authentication in the core yet, so there is no token to print: every route is
    // open on loopback. When one exists, its dev token goes here.
    for route in jian_server::ROUTES {
        let (method, path) = route.split_once(' ').unwrap_or(("GET", route));
        println!("  {method} http://{addr}{path}");
    }

    let (stop, stopped) = oneshot::channel::<()>();
    let mut server = tokio::spawn(
        axum::serve(listener, jian_server::router(database.health()))
            .with_graceful_shutdown(async {
                // A dropped sender counts as a stop as well.
                let _ = stopped.await;
            })
            .into_future(),
    );

    tokio::select! {
        () = shutdown.wait() => {
            tracing::info!("stop signal received; draining requests");
            // The receiver is gone only if the server already ended, which is what we want anyway.
            let _ = stop.send(());
            if let Ok(joined) = tokio::time::timeout(DRAIN_DEADLINE, &mut server).await {
                joined.context("the server task failed")?.context("the server stopped")
            } else {
                tracing::warn!(?DRAIN_DEADLINE, "requests still running at the deadline; cutting them off");
                server.abort();
                Ok(())
            }
        }
        joined = &mut server => joined.context("the server task failed")?.context("the server stopped"),
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory as _;

    use super::*;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn the_flags_set_the_address_the_data_directory_and_the_database() {
        let given = Cli::try_parse_from([
            "jian",
            "--addr",
            "0.0.0.0:9000",
            "--data-dir",
            "/srv/jian",
            "--database-url",
            "postgres://u:p@db.example.test/jian",
        ])
        .unwrap();
        assert_eq!(given.addr, "0.0.0.0:9000");
        assert_eq!(
            given.data_dir.as_deref(),
            Some(std::path::Path::new("/srv/jian"))
        );
        assert!(matches!(
            given.database_source().unwrap(),
            DatabaseSource::External(_)
        ));
        // JIAN_ADDR may be set in the environment running the tests, so only the flag is asserted
        // against a fixed value; the default is checked on the constant.
        assert_eq!(DEFAULT_ADDR, "127.0.0.1:4410");
    }

    #[test]
    fn without_a_database_url_the_embedded_server_is_used_in_the_given_directory() {
        let mut cli = Cli::try_parse_from(["jian", "--data-dir", "/srv/jian"]).unwrap();
        // DATABASE_URL may be set where the tests run; the flag's absence is what is under test.
        cli.database_url = None;
        let DatabaseSource::Embedded(config) = cli.database_source().unwrap() else {
            panic!("expected the embedded database");
        };
        assert_eq!(config.data_dir, PathBuf::from("/srv/jian"));
        assert_eq!(config.port, 0);
    }

    #[test]
    fn an_empty_database_url_means_none() {
        let mut cli = Cli::try_parse_from(["jian", "--data-dir", "/srv/jian"]).unwrap();
        cli.database_url = Some("  ".to_owned());
        assert!(matches!(
            cli.database_source().unwrap(),
            DatabaseSource::Embedded(_)
        ));
    }
}
