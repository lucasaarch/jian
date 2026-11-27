//! The gateway binary for a server. The desktop app uses the same local gateway lifecycle.
//!
//! The CLI maps flags and environment variables into server settings and commands. The shared
//! `desktop` module owns the local gateway lifecycle and key setup for both this binary and Tauri.

// What a server prints at start-up is this binary's interface to whoever runs it.
#![allow(clippy::print_stdout)]

mod github_flags;
mod import_cli;
mod mail_flags;
mod shutdown;
mod slack_flags;
mod users_cli;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use clap::{ArgAction, Parser, Subcommand};
use jian::browser_flags;
use jian::debug_jobs;
use jian::desktop;
use jian::owner_token;
use jian_auth::{Auth, AuthPolicy, PasswordParams};
use jian_server::{PublicUrl, Settings};
use jian_store::embedded::EmbeddedConfig;
use jian_store::secrets::LocalKeyring;
use jian_store::{Database, DatabaseSource, DatabaseUrl, DiskBlobs, NewJob, TenantId};

use crate::import_cli::{ImportArgs, ImportFlags};
use crate::shutdown::Shutdown;
use crate::users_cli::UsersAction;

/// Where the gateway listens when nothing says otherwise: loopback only, so an unconfigured
/// install is not reachable from the network.
const DEFAULT_ADDR: &str = "127.0.0.1:4410";

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

    /// Whether agents may run their shell and file tools on this machine, when their workspace
    /// chose it, in a folder of their own under the data directory. On for a self-hosted or
    /// desktop install, where this machine is the owner's; a shared deployment turns it off, and
    /// its agents then use connected machines only.
    #[arg(
        long,
        env = "JIAN_LOCAL_MACHINE",
        default_value_t = true,
        action = ArgAction::Set,
        value_name = "BOOL"
    )]
    local_machine: bool,

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

    #[command(flatten)]
    slack: slack_flags::SlackFlags,

    #[command(flatten)]
    browser: browser_flags::BrowserFlags,

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
    /// Enqueue a `debug.log` job for the installation's tenant: the running gateway picks it up and
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
        desktop::master_keys(
            &self.data_dir()?,
            self.master_keys.as_deref(),
            self.active_key_id.as_deref(),
            self.master_key.as_deref(),
        )
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
    desktop::default_data_dir()
}

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(desktop::MAX_BLOCKING_THREADS)
        .build()
        .context("start the async runtime")?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    desktop::init_observability();
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
        slack: cli.slack.config(cli.public_url.as_ref())?,
        mail: cli.mail.config()?,
        workspace_name: cli.mail.workspace_name.clone(),
        local_machine: cli.local_machine,
        ..Settings::default()
    };
    let source = cli.database_source()?;
    let data_dir = cli.data_dir()?;
    let (owner, owner_source) = owner_token::resolve(cli.api_token.as_deref(), &data_dir)
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
            // A server is reachable from outside, so its artifacts have links; the desktop app
            // embeds the store itself and keeps the default (none).
            .with_artifact_links(true)
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
        None => match desktop::prepare(&database, &owner).await {
            Ok(ctx) => {
                import_cli::at_boot(&database, &ctx, &cli.import, &data_dir).await;
                desktop::serve(
                    &addr,
                    &database,
                    &owner_source,
                    settings,
                    &data_dir,
                    &cli.browser,
                    shutdown.wait(),
                )
                .await
            }
            Err(error) => Err(error),
        },
    };
    let closed = desktop::close(database).await;
    served?;
    closed
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

/// `jian import`: the installation's tenant must exist, so the gateway has run once on this database.
async fn import_command(database: &Database, cli: &Cli, args: ImportArgs) -> anyhow::Result<()> {
    let ctx = database
        .tenant(TenantId::self_hosted())
        .await
        .context("cannot open the tenant; has the gateway run once on this database?")?;
    import_cli::run(database, &ctx, &cli.import, &cli.data_dir()?, args).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::CommandFactory as _;
    use jian::desktop::MASTER_KEY_FILE;
    use jian_auth::CredentialKind;
    use jian_store::secrets::MasterKeys as _;

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
        assert_eq!(given.data_dir.as_deref(), Some(Path::new("/srv/jian")));
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
    fn with_keys(dir: &Path, list: Option<&str>, single: Option<&str>) -> Cli {
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
