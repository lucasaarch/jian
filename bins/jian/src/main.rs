//! The gateway binary for a server. The desktop app embeds `jian-server` instead.
//!
//! This is the only place the gateway reads its environment: each flag has a variable that stands
//! in when the flag is absent (`JIAN_ADDR`, `JIAN_DATA_DIR`, `DATABASE_URL`), and `RUST_LOG` sets
//! the log level. The master key variables (`JIAN_MASTER_KEYS`, `JIAN_ACTIVE_KEY_ID`,
//! `JIAN_MASTER_KEY`) and the owner's token (`JIAN_API_TOKEN`) are read here too and handed to the store as a keyring. The libraries
//! receive the values.

// What a server prints at start-up is this binary's interface to whoever runs it.
#![allow(clippy::print_stdout)]

mod debug_jobs;
mod github_flags;
mod import_cli;
mod mail_flags;
mod owner_token;
mod shutdown;
mod users_cli;

use std::future::IntoFuture as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use clap::{Parser, Subcommand};
use jian_server::{
    AGENT_WAKE_KIND, AccountModels, AgentRunner, AgentWaker, AppState, EventBus, INVITE_SEND_KIND,
    InviteSender, JobOptions, JobRegistry, JobRequeue, JobRunner, LOGIN_LINK_SEND_KIND, LlmAccess,
    LoginLinkSender, MemoryEventBus, ModelSource, PublicUrl, RUN_KIND, SCHEDULE_FIRE_KIND,
    ScheduleFirer, Settings, SlotKeeper, THREAD_COMPACT_KIND, ThreadCompactor,
};
use jian_store::embedded::EmbeddedConfig;
use jian_store::secrets::{LocalKeyring, MasterKeys as _};
use jian_store::{
    Database, DatabaseSource, DatabaseUrl, DiskBlobs, NewJob, SlotOptions, TenantCtx, TenantId,
    TenantStatus,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use jian_auth::{Auth, AuthPolicy, CredentialKind, PasswordParams};

use crate::import_cli::{ImportArgs, ImportFlags};
use crate::owner_token::Source;
use crate::shutdown::Shutdown;
use crate::users_cli::UsersAction;

/// Where the gateway listens when nothing says otherwise: loopback only, so an unconfigured
/// install is not reachable from the network.
const DEFAULT_ADDR: &str = "127.0.0.1:4410";

/// The file in the data directory that holds the master key when no variable gives one. Losing it
/// loses every secret: back it up with the database.
const MASTER_KEY_FILE: &str = "master.key";

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
    #[arg(long, env = "JIAN_DATA_DIR", value_name = "DIR", global = true)]
    data_dir: Option<PathBuf>,

    /// A Postgres to use instead of the embedded one, as a `postgres://` URL. It holds a
    /// password, so `--help` does not show its value.
    #[arg(
        long,
        env = "DATABASE_URL",
        value_name = "URL",
        hide_env_values = true,
        global = true
    )]
    database_url: Option<String>,

    /// Master keys as JSON, `{"<keyId>": "<base64 of 32 bytes>"}`, as the Node Jian takes them.
    /// With more than one key, `--active-key-id` says which wraps. Holds keys, so `--help` does
    /// not show its value.
    #[arg(
        long,
        env = "JIAN_MASTER_KEYS",
        value_name = "JSON",
        hide_env_values = true,
        global = true
    )]
    master_keys: Option<String>,

    /// Which of the `--master-keys` wraps new data keys, and the one `jian keys rotate` moves
    /// every data key to.
    #[arg(long, env = "JIAN_ACTIVE_KEY_ID", value_name = "ID", global = true)]
    active_key_id: Option<String>,

    /// One master key, the base64 of 32 bytes, with the id `local`, as the desktop app takes it.
    /// Holds a key, so `--help` does not show its value.
    #[arg(
        long,
        env = "JIAN_MASTER_KEY",
        value_name = "BASE64",
        hide_env_values = true,
        global = true
    )]
    master_key: Option<String>,

    /// The owner's token, at least 32 characters. Without one, the first start generates a token
    /// into `owner.token` in the data directory and later starts reuse it. Holds a secret, so
    /// `--help` does not show its value.
    #[arg(
        long,
        env = "JIAN_API_TOKEN",
        value_name = "TOKEN",
        hide_env_values = true,
        global = true
    )]
    api_token: Option<String>,

    /// How people sign in: a comma-separated list of `password`, `github`, `email_link`,
    /// `passkey`, `totp`. `password`, `github` (needs the `--github-*` flags and `--public-url`)
    /// and `email_link` (needs `--public-url` and e-mail) are implemented. Leaving `password`
    /// out turns password sign-in off; a method that is off is a 404. GitHub and the link only
    /// let in people who are already members.
    #[arg(
        long,
        env = "JIAN_AUTH_METHODS",
        default_value = "password",
        value_name = "LIST"
    )]
    auth_methods: AuthPolicy,

    /// Where the panel is on the internet, such as `https://jian.example.com`: what the link in
    /// an invitation points at. Without it an invitation is only a token, and sending one by
    /// e-mail is refused.
    #[arg(long, env = "JIAN_PUBLIC_URL", value_name = "URL", value_parser = PublicUrl::parse, global = true)]
    public_url: Option<PublicUrl>,

    #[command(flatten)]
    import: ImportFlags,

    #[command(flatten)]
    mail: mail_flags::MailFlags,

    #[command(flatten)]
    github: github_flags::GithubFlags,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Master key maintenance.
    Keys {
        #[command(subcommand)]
        action: KeysAction,
    },
    /// The people who can sign in. With the embedded Postgres, stop the gateway first: this
    /// starts that database itself.
    Users {
        #[command(subcommand)]
        action: UsersAction,
    },
    /// Bring the old Node Jian's data over: `--from <dump.sql | postgres://...>`, or `status`.
    /// With the embedded Postgres, stop the gateway first: this starts that database itself.
    Import(ImportArgs),
    /// The job queue, for trying it by hand.
    Jobs {
        #[command(subcommand)]
        action: JobsAction,
    },
}

#[derive(Subcommand)]
enum JobsAction {
    /// Enqueue a `debug.log` job for the install's tenant: the running gateway picks it up and
    /// logs the message. The gateway must have run once on this database. With the embedded
    /// Postgres, stop the gateway first, because the command starts that database itself; with
    /// `DATABASE_URL` or `--database-url` it runs beside the gateway.
    EnqueueTest {
        /// What the job logs.
        #[arg(long, default_value = "hello from the queue")]
        message: String,
        /// How many milliseconds the job pretends to work, so a SIGTERM can find it running.
        #[arg(long, value_name = "MS")]
        work_ms: Option<u64>,
    },
}

#[derive(Subcommand)]
enum KeysAction {
    /// Rewrap every tenant's data key with the active master key. Make the new key active
    /// (`JIAN_ACTIVE_KEY_ID`), keep the old one in `JIAN_MASTER_KEYS`, run this, and only then
    /// remove the old key. Secrets are not touched, and a second run changes nothing. With the
    /// embedded Postgres, stop the gateway first: this starts that database itself.
    Rotate,
}

impl Cli {
    /// The directory of the embedded database and of the master key file.
    fn data_dir(&self) -> anyhow::Result<PathBuf> {
        match &self.data_dir {
            Some(dir) => Ok(dir.clone()),
            None => default_data_dir(),
        }
    }

    /// The master keys: the server's list, else the desktop's single key, else the file in the
    /// data directory, made on the first start. An empty variable counts as not given. Only key
    /// ids are logged.
    fn master_keys(&self) -> anyhow::Result<LocalKeyring> {
        let given = |value: &Option<String>| value.clone().filter(|text| !text.trim().is_empty());
        let (keyring, source) = if let Some(list) = given(&self.master_keys) {
            let ring = LocalKeyring::from_json(&list, self.active_key_id.as_deref())
                .context("JIAN_MASTER_KEYS is not usable")?;
            (ring, "JIAN_MASTER_KEYS")
        } else if let Some(key) = given(&self.master_key) {
            let ring = LocalKeyring::from_single(&key).context("JIAN_MASTER_KEY is not usable")?;
            (ring, "JIAN_MASTER_KEY")
        } else {
            let path = self.data_dir()?.join(MASTER_KEY_FILE);
            let (ring, created) = LocalKeyring::load_or_create(&path)
                .with_context(|| format!("cannot use the master key file {}", path.display()))?;
            if created {
                tracing::warn!(
                    path = %path.display(),
                    "generated a master key; back this file up, secrets cannot be read without it"
                );
            }
            (ring, "the key file")
        };
        tracing::info!(
            source,
            active = keyring.active_key_id(),
            keys = ?keyring.key_ids(),
            "master keys loaded"
        );
        Ok(keyring)
    }

    /// The database to open: the external one when a URL is given (an empty value counts as not
    /// given, as `DATABASE_URL=` in a shell does), otherwise the embedded one.
    fn database_source(&self) -> anyhow::Result<DatabaseSource> {
        if let Some(url) = self
            .database_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
        {
            return Ok(DatabaseSource::External(DatabaseUrl::new(url)));
        }
        let data_dir = self.data_dir()?;
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

/// The most threads the blocking pool may run at once (tokio's default is 512). Everything that
/// blocks runs there (password hashing, hashing uploads, git and file work on a machine), and an
/// argon2id hash alone holds tens of MiB while it runs, so an unbounded pool lets one tenant's
/// burst of sign-ins exhaust the host's memory for every tenant. Past the limit work queues
/// instead of failing. Raise it only with the memory to match.
const MAX_BLOCKING_THREADS: usize = 32;

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(MAX_BLOCKING_THREADS)
        .build()
        .context("start the async runtime")?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let mut cli = Cli::parse();
    let addr = cli.addr.clone();
    let keys = cli.master_keys()?;
    let command = cli.command.take();
    let mut auth = Auth::new(cli.auth_methods.clone(), PasswordParams::default());
    if let Some(app) = cli.github.app(cli.public_url.as_ref())? {
        auth = auth.with_github(app);
    }
    let settings = Settings {
        gateway_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        auth: auth.clone(),
        public_url: cli.public_url.clone(),
        mail: cli.mail.config()?,
        workspace_name: cli.mail.workspace_name.clone(),
        ..Settings::default()
    };
    let source = cli.database_source()?;
    let data_dir = cli.data_dir()?;
    let (owner, owner_source) = owner_token::resolve(cli.api_token.as_deref(), &cli.data_dir()?)
        .context("cannot get the owner's token")?;
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

    let database = Arc::new(
        Database::open(source)
            .await
            .context("cannot open the database")?
            .with_master_keys(Arc::new(keys))
            .with_blobs(Arc::new(DiskBlobs::new(data_dir.join("files")))),
    );
    // From here the database is up, so every way out goes through `close` below.
    let served = match command {
        Some(Command::Keys {
            action: KeysAction::Rotate,
        }) => rotate(&database).await,
        Some(Command::Users { action }) => {
            users_cli::run(&database, &auth, cli.public_url.as_ref(), action).await
        }
        Some(Command::Jobs {
            action: JobsAction::EnqueueTest { message, work_ms },
        }) => enqueue_test(&database, &message, work_ms).await,
        Some(Command::Import(args)) => import_command(&database, &cli, args).await,
        None => match prepare(&database, &owner).await {
            Ok(ctx) => {
                import_cli::at_boot(&database, &ctx, &cli.import, &data_dir).await;
                serve(&addr, &database, &owner_source, settings, &mut shutdown).await
            }
            Err(error) => Err(error),
        },
    };
    let closed = close(database).await;
    served?;
    closed
}

/// Closes the database once the last connection that held it is gone. The server's tasks hold a
/// handle until they end, and an open WebSocket is one of them: it was told to close when the
/// stop signal came, so this waits only for them to notice.
async fn close(mut database: Arc<Database>) -> anyhow::Result<()> {
    for _ in 0..50 {
        match Arc::try_unwrap(database) {
            Ok(database) => {
                return database
                    .close()
                    .await
                    .context("cannot close the database cleanly");
            }
            Err(still_shared) => database = still_shared,
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("connections still use the database after 5 s; it was not closed")
}

/// `jian keys rotate`: moves every data key to the active master key and says how many.
async fn rotate(database: &Database) -> anyhow::Result<()> {
    let report = database
        .rotate_master_keys()
        .await
        .context("cannot rotate the master key; has the gateway run once on this database?")?;
    println!(
        "data keys rewrapped: {}, already on the active key: {}",
        report.rewrapped, report.already_current
    );
    Ok(())
}

/// `jian jobs enqueue-test`: puts one `debug.log` job on the queue and prints its id.
async fn enqueue_test(
    database: &Database,
    message: &str,
    work_ms: Option<u64>,
) -> anyhow::Result<()> {
    let tenant = database
        .tenant(TenantId::self_hosted())
        .await
        .context("cannot open the tenant; has the gateway run once on this database?")?;
    let mut payload = serde_json::json!({ "message": message });
    if let Some(work_ms) = work_ms {
        payload["workMs"] = work_ms.into();
    }
    let made = database
        .enqueue_job(&tenant, NewJob::new(debug_jobs::KIND, payload))
        .await
        .context("cannot enqueue the job")?;
    println!("enqueued job {}", made.job.id);
    Ok(())
}

/// Brings the database to the latest migration and makes the one tenant of a self-hosted install.
/// Both are safe to repeat: a second start finds nothing to do.
async fn prepare(database: &Database, owner_token: &str) -> anyhow::Result<TenantCtx> {
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
    // Every start sets it, so changing JIAN_API_TOKEN replaces the token the database knows.
    let ctx = database
        .tenant(tenant)
        .await
        .context("cannot open the tenant")?;
    database
        .set_owner_token(&ctx, owner_token)
        .await
        .context("cannot set the owner's token (JIAN_API_TOKEN needs at least 32 characters)")?;
    Ok(ctx)
}

/// `jian import`: the install's tenant must exist, so the gateway has run once on this database.
async fn import_command(database: &Database, cli: &Cli, args: ImportArgs) -> anyhow::Result<()> {
    let ctx = database
        .tenant(TenantId::self_hosted())
        .await
        .context("cannot open the tenant; has the gateway run once on this database?")?;
    import_cli::run(database, &ctx, &cli.import, &cli.data_dir()?, args).await
}

/// Every job kind this binary runs.
fn job_registry(
    settings: &Settings,
    models: &Arc<dyn ModelSource>,
    events: &Arc<dyn EventBus>,
) -> JobRegistry {
    debug_jobs::registry()
        .register(INVITE_SEND_KIND, Arc::new(InviteSender::new(settings)))
        .register(
            LOGIN_LINK_SEND_KIND,
            Arc::new(LoginLinkSender::new(settings)),
        )
        .register(SCHEDULE_FIRE_KIND, Arc::new(ScheduleFirer))
        .register(
            AGENT_WAKE_KIND,
            Arc::new(AgentWaker::new(models.clone(), events.clone())),
        )
        .register(
            THREAD_COMPACT_KIND,
            Arc::new(ThreadCompactor::new(models.clone())),
        )
        // No hub-backed machine yet: a run that needs one fails that tool call, and the light
        // tools still work.
        .register(
            RUN_KIND,
            Arc::new(AgentRunner::new(
                models.clone(),
                Arc::new(jian_exec::NoMachine),
                events.clone(),
            )),
        )
}

/// Serves until a stop signal, then drains: it stops serving tenants (every open socket is told
/// to reconnect), stops accepting, gives the slot leases back and returns, and only then does the
/// caller stop the database. Returns `Ok` after a clean drain or a drain that hit the deadline; an
/// error only when the address cannot be bound, the slots cannot be taken or the server fails by
/// itself.
async fn serve(
    addr: &str,
    database: &Arc<Database>,
    owner_source: &Source,
    settings: Settings,
    shutdown: &mut Shutdown,
) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    println!("jian listening on http://{addr}");
    match owner_source {
        Source::Variable => println!("owner token: from JIAN_API_TOKEN"),
        Source::NewFile(path) => println!("owner token: generated into {}", path.display()),
        Source::File(path) => println!("owner token: in {}", path.display()),
    }
    println!(
        "sign-in methods: {}{}",
        settings.auth.policy(),
        if settings.auth.policy().allows(CredentialKind::Password) {
            " (add the first admin with `jian users add --admin --email ... --password-stdin`)"
        } else {
            ""
        }
    );
    for route in jian_server::ROUTES {
        let (method, path) = route.split_once(' ').unwrap_or(("GET", route));
        println!("  {method} http://{addr}{path}");
    }

    // Before the first request: a lone instance (every self-hosted install) takes all the slots in
    // this one round, and a replica of a fleet takes its share.
    let mut keeper = SlotKeeper::start(database.clone(), SlotOptions::default())
        .await
        .context("cannot take the slot leases")?;
    let slots = keeper.ownership();
    tracing::info!(
        instance = %keeper.instance(),
        slots = slots.count(),
        "this instance serves its slots"
    );
    // After the slots: the runner takes jobs only from slots this instance holds.
    let llm = LlmAccess::default();
    let events: Arc<dyn EventBus> = Arc::new(MemoryEventBus::new());
    let models: Arc<dyn ModelSource> = Arc::new(AccountModels::new(database.clone(), llm.clone()));
    let runner = JobRunner::start(
        database.clone(),
        keeper.instance().clone(),
        slots.clone(),
        job_registry(&settings, &models, &events),
        JobOptions::default(),
    )
    .await;
    let closing = CancellationToken::new();
    // Time-keeping for schedules; it holds nothing a restart loses, and is joined below because it
    // holds the database, which must be closable after the drain.
    let ticking = CancellationToken::new();
    let ticker = tokio::spawn(jian_server::run_ticker(database.clone(), ticking.clone()));
    let mut state = AppState::new(database.clone(), slots, closing.clone(), settings);
    // The runs' deltas and the routes' must meet on one bus, and the models on one set of
    // breakers.
    state.events = events;
    state.llm = llm;
    let (stop, stopped) = oneshot::channel::<()>();
    let mut server = tokio::spawn(
        // Connect info is how the server tells callers apart for its rate limit.
        axum::serve(
            listener,
            jian_server::router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            // A dropped sender counts as a stop as well.
            let _ = stopped.await;
        })
        .into_future(),
    );

    // Until when the jobs that are running may finish: the same deadline as the requests.
    let mut jobs_until = Instant::now() + DRAIN_DEADLINE;
    let outcome = tokio::select! {
        () = shutdown.wait() => {
            tracing::info!("stop signal received; draining");
            jobs_until = Instant::now() + DRAIN_DEADLINE;
            // Open sockets are told to reconnect first, because a graceful stop waits for them.
            keeper.begin_drain().await;
            tracing::info!("no longer serving tenants; open connections told to reconnect");
            // The receiver is gone only if the server already ended, which is what we want anyway.
            let _ = stop.send(());
            if let Ok(joined) = tokio::time::timeout(DRAIN_DEADLINE, &mut server).await {
                tracing::info!("accepting stopped; connections closed");
                joined
                    .context("the server task failed")
                    .and_then(|ended| ended.context("the server stopped"))
            } else {
                tracing::warn!(?DRAIN_DEADLINE, "requests still running at the deadline; cutting them off");
                closing.cancel();
                server.abort();
                Ok(())
            }
        }
        joined = &mut server => {
            keeper.begin_drain().await;
            joined
                .context("the server task failed")
                .and_then(|ended| ended.context("the server stopped"))
        }
    };
    ticking.cancel();
    let _ = ticker.await;
    // No new job is taken (the slots are no longer served); the ones running get until the
    // deadline, and what is left is stopped and handed back to the queue below.
    let stopped = runner.shutdown(jobs_until).await;
    // Nothing serves a tenant now, so the slots can go to another instance without waiting for
    // their leases to run out, once the jobs still running are back in the queue.
    match keeper
        .finish_drain(&JobRequeue::new(database.clone()))
        .await
    {
        Ok(report) => tracing::info!(
            released = report.released,
            requeued = report.requeued,
            stopped,
            "slot leases released"
        ),
        Err(error) => {
            tracing::warn!(%error, "could not release the slot leases; they run out on their own");
        }
    }
    outcome
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

    /// A `Cli` with the key variables set as given, whatever the environment running the tests has.
    fn with_keys(dir: &std::path::Path, list: Option<&str>, single: Option<&str>) -> Cli {
        let mut cli = Cli::try_parse_from(["jian", "--data-dir", dir.to_str().unwrap()]).unwrap();
        cli.master_keys = list.map(str::to_owned);
        cli.master_key = single.map(str::to_owned);
        cli.active_key_id = None;
        cli
    }

    // 32 bytes of 0x01, base64.
    const KEY: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

    #[test]
    fn without_a_master_key_variable_a_key_file_is_made_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = with_keys(dir.path(), None, None).master_keys().unwrap();
        assert_eq!(first.active_key_id(), "local");
        assert!(dir.path().join(MASTER_KEY_FILE).is_file());
        let before = std::fs::read(dir.path().join(MASTER_KEY_FILE)).unwrap();
        with_keys(dir.path(), Some("  "), Some(""))
            .master_keys()
            .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(MASTER_KEY_FILE)).unwrap(),
            before
        );
    }

    #[test]
    fn a_master_key_variable_wins_over_the_file_and_a_bad_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let json = format!(r#"{{"prod":"{KEY}"}}"#);
        let keyring = with_keys(dir.path(), Some(&json), None)
            .master_keys()
            .unwrap();
        assert_eq!(keyring.key_ids(), ["prod"]);
        let keyring = with_keys(dir.path(), None, Some(KEY))
            .master_keys()
            .unwrap();
        assert_eq!(keyring.active_key_id(), "local");
        // Neither made a file: the variables are the source of truth.
        assert!(!dir.path().join(MASTER_KEY_FILE).exists());
        let error = with_keys(dir.path(), None, Some("short"))
            .master_keys()
            .unwrap_err();
        assert!(format!("{error:#}").contains("JIAN_MASTER_KEY is not usable"));
    }

    #[test]
    fn sign_in_methods_default_to_a_password_and_can_be_changed() {
        // JIAN_AUTH_METHODS may be set where the tests run; the flag wins over it.
        let policy = |list: &str| {
            Cli::try_parse_from(["jian", "--auth-methods", list]).map(|cli| cli.auth_methods)
        };
        assert!(policy("password").unwrap().allows(CredentialKind::Password));
        assert!(!policy("github").unwrap().allows(CredentialKind::Password));
        assert!(policy("telepathy").is_err());
    }

    #[test]
    fn users_add_is_a_subcommand() {
        let cli = Cli::try_parse_from([
            "jian",
            "users",
            "add",
            "--email",
            "a@b.test",
            "--admin",
            "--password-stdin",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Users {
                action: UsersAction::Add(_)
            })
        ));
    }

    #[test]
    fn keys_rotate_is_a_subcommand() {
        let cli =
            Cli::try_parse_from(["jian", "keys", "rotate", "--data-dir", "/srv/jian"]).unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Keys {
                action: KeysAction::Rotate
            })
        ));
    }

    #[test]
    fn jobs_enqueue_test_is_a_subcommand() {
        let cli = Cli::try_parse_from([
            "jian",
            "jobs",
            "enqueue-test",
            "--message",
            "hi",
            "--work-ms",
            "2000",
        ])
        .unwrap();
        let Some(Command::Jobs {
            action: JobsAction::EnqueueTest { message, work_ms },
        }) = cli.command
        else {
            panic!("expected jobs enqueue-test");
        };
        assert_eq!((message.as_str(), work_ms), ("hi", Some(2000)));
    }

    #[test]
    fn import_takes_a_source_or_status() {
        let cli = Cli::try_parse_from(["jian", "import", "--from", "old.sql"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Import(_))));
        let cli = Cli::try_parse_from(["jian", "import", "status"]).unwrap();
        assert!(matches!(cli.command, Some(Command::Import(_))));
    }
}
