//! Shared startup and drain lifecycle for a locally hosted Jian gateway.

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use jian_channel_api::{Backoff, ChannelKind};
use jian_exec::Executor;
use jian_server::{
    AGENT_WAKE_KIND, AccountModels, AgentMachines, AgentRunner, AgentWaker, AppState, ChannelHub,
    EventBus, JobOptions, JobRegistry, JobRequeue, JobRunner, LlmAccess, MachineHub,
    MemoryEventBus, ModelSource, RUN_KIND, SCHEDULE_FIRE_KIND, SCHEDULE_RUN_KIND, ScheduleFirer,
    ScheduleRunner, Settings, THREAD_COMPACT_KIND, ThreadCompactor,
};
use jian_store::embedded::EmbeddedConfig;
use jian_store::secrets::{LocalKeyring, MasterKeys as _};
use jian_store::{
    Database, DatabaseSource, DiskBlobs, SlotOptions, TenantCtx, TenantId, TenantStatus,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[cfg(feature = "public-url")]
use jian_server::{
    GITHUB_WEBHOOK_KIND, GithubWebhookHandler, INVITE_SEND_KIND, InviteSender, LINEAR_WEBHOOK_KIND,
    LOGIN_LINK_SEND_KIND, LinearWebhookHandler, LoginLinkSender, Plugins, SLACK_EVENT_KIND,
    SlackEventHandler,
};

/// How long requests and jobs may drain after the host asks the gateway to stop.
const DRAIN_DEADLINE: Duration = Duration::from_secs(8);

/// Bound blocking work because a password hash holds tens of MiB while it runs.
pub const MAX_BLOCKING_THREADS: usize = 32;

/// The file in the data directory that holds the master key when no variable gives one.
pub const MASTER_KEY_FILE: &str = "master.key";

/// Installs the same filtered tracing and redacted `WhatsApp` logging for both gateway hosts.
pub fn init_observability() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    if let Err(error) = jian_channel_whatsapp::install_log_redaction() {
        tracing::warn!(%error, "the WhatsApp log redaction was not installed");
    }
}

/// Resolves key material using the same precedence for the CLI and the desktop host.
pub fn master_keys(
    data_dir: &Path,
    master_keys: Option<&str>,
    active_key_id: Option<&str>,
    master_key: Option<&str>,
) -> anyhow::Result<LocalKeyring> {
    let master_keys = master_keys.filter(|text| !text.trim().is_empty());
    let master_key = master_key.filter(|text| !text.trim().is_empty());
    let (keyring, source) = if let Some(list) = master_keys {
        (
            LocalKeyring::from_json(list, active_key_id)
                .context("JIAN_MASTER_KEYS is not usable")?,
            "JIAN_MASTER_KEYS",
        )
    } else if let Some(key) = master_key {
        (
            LocalKeyring::from_single(key).context("JIAN_MASTER_KEY is not usable")?,
            "JIAN_MASTER_KEY",
        )
    } else {
        let path = data_dir.join(MASTER_KEY_FILE);
        let (keyring, created) = LocalKeyring::load_or_create(&path)
            .with_context(|| format!("cannot use the master key file {}", path.display()))?;
        if created {
            tracing::warn!(
                path = %path.display(),
                "generated a master key; back this file up, secrets cannot be read without it"
            );
        }
        (keyring, "the key file")
    };
    tracing::info!(
        source,
        active = keyring.active_key_id(),
        keys = ?keyring.key_ids(),
        "master keys loaded"
    );
    Ok(keyring)
}

/// The default per-user data directory used by the desktop and by the CLI.
pub fn default_data_dir() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("", "", "jian")
        .context("no home directory to keep data in; pass --data-dir")?;
    Ok(dirs.data_dir().to_path_buf())
}

/// Brings the local tenant to the current schema and provisions its owner token.
pub async fn prepare(database: &Database, owner_token: &str) -> anyhow::Result<TenantCtx> {
    let report = database
        .migrate()
        .await
        .context("cannot migrate the database")?;
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

/// Closes the database once every request, socket, and worker has released its handle.
pub async fn close(mut database: Arc<Database>) -> anyhow::Result<()> {
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

/// Every job kind served by this gateway runtime.
pub fn job_registry(
    settings: &Settings,
    models: &Arc<dyn ModelSource>,
    events: &Arc<dyn EventBus>,
    executor: &Arc<dyn Executor>,
    pages: Option<Arc<jian_browser::Sessions>>,
    chat: Option<&ChannelHub>,
) -> JobRegistry {
    let registry = crate::debug_jobs::registry();
    #[cfg(feature = "public-url")]
    let registry = if let Some(chat) = chat {
        registry.register(
            SLACK_EVENT_KIND,
            Arc::new(SlackEventHandler::new(chat.clone())),
        )
    } else {
        registry
    };
    #[cfg(not(feature = "public-url"))]
    let _ = settings;
    #[cfg(feature = "public-url")]
    let registry = registry
        .register(INVITE_SEND_KIND, Arc::new(InviteSender::new(settings)))
        .register(
            LOGIN_LINK_SEND_KIND,
            Arc::new(LoginLinkSender::new(settings)),
        )
        .register(
            GITHUB_WEBHOOK_KIND,
            Arc::new(GithubWebhookHandler::new(Plugins::new(
                jian_server::builtin_plugins(),
            ))),
        )
        .register(
            LINEAR_WEBHOOK_KIND,
            Arc::new(LinearWebhookHandler::new(Plugins::new(
                jian_server::builtin_plugins(),
            ))),
        );
    let mut runner = AgentRunner::new(models.clone(), executor.clone(), events.clone())
        .with_plugins(jian_server::builtin_plugins());
    if let Some(chat) = chat {
        runner = runner.with_channels(chat.clone());
    }
    if let Some(pages) = pages {
        runner = runner.with_browser(pages);
    }
    registry
        .register(SCHEDULE_FIRE_KIND, Arc::new(ScheduleFirer))
        .register(
            SCHEDULE_RUN_KIND,
            Arc::new(ScheduleRunner::new(events.clone())),
        )
        .register(
            AGENT_WAKE_KIND,
            Arc::new(AgentWaker::new(models.clone(), events.clone())),
        )
        .register(
            THREAD_COMPACT_KIND,
            Arc::new(ThreadCompactor::new(models.clone())),
        )
        .register(RUN_KIND, Arc::new(runner))
}

/// Serves until the supplied host signal resolves, then drains leases, channels, jobs, and sockets.
pub async fn serve<F>(
    addr: &str,
    database: &Arc<Database>,
    owner_source: &crate::owner_token::Source,
    settings: Settings,
    data_dir: &Path,
    browser: &crate::browser_flags::BrowserFlags,
    shutdown: F,
) -> anyhow::Result<()>
where
    F: Future<Output = ()> + Send,
{
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    println!("jian listening on http://{addr}");
    match owner_source {
        crate::owner_token::Source::Variable => println!("owner token: from JIAN_API_TOKEN"),
        crate::owner_token::Source::NewFile(path) => {
            println!("owner token: generated into {}", path.display());
        }
        crate::owner_token::Source::File(path) => {
            println!("owner token: in {}", path.display());
        }
    }
    println!(
        "sign-in methods: {}{}",
        settings.auth.policy(),
        if settings
            .auth
            .policy()
            .allows(jian_auth::CredentialKind::Password)
        {
            " (add the first admin with `jian users add --admin --email ... --password-stdin`)"
        } else {
            ""
        }
    );
    for route in jian_server::ROUTES {
        let (method, path) = route.split_once(' ').unwrap_or(("GET", route));
        println!("  {method} http://{addr}{path}");
    }

    let mut keeper = jian_server::SlotKeeper::start(database.clone(), SlotOptions::default())
        .await
        .context("cannot take the slot leases")?;
    let slots = keeper.ownership();
    tracing::info!(
        instance = %keeper.instance(),
        slots = slots.count(),
        "this instance serves its slots"
    );
    let llm = LlmAccess::default();
    let events: Arc<dyn EventBus> = Arc::new(MemoryEventBus::new());
    let models: Arc<dyn ModelSource> = Arc::new(AccountModels::new(database.clone(), llm.clone()));
    let hub = MachineHub::new();
    let executor: Arc<dyn Executor> = Arc::new(AgentMachines::from_settings(
        database.clone(),
        hub.clone(),
        &settings,
        &data_dir.join("work"),
    ));
    let browsers = browser.find(
        &std::env::var_os("PATH").unwrap_or_default(),
        jian_server::browser_policy(),
    );
    if browsers.is_none() {
        tracing::info!("no browser program found; agents have no browser and PDF/PNG are off");
    }
    let closing = CancellationToken::new();
    let chat = ChannelHub::new(
        database.clone(),
        slots.clone(),
        closing.clone(),
        Backoff::DEFAULT,
    );
    chat.register(
        ChannelKind::Whatsapp,
        Arc::new(|_, store| jian_channel_whatsapp::open(store)),
    );
    chat.register(
        ChannelKind::Telegram,
        Arc::new(|_, store| {
            jian_channel_telegram::open(store, jian_channel_telegram::TelegramConfig::default())
        }),
    );
    chat.register(
        ChannelKind::Discord,
        Arc::new(|_, store| {
            jian_channel_discord::open(store, jian_channel_discord::DiscordConfig::default())
        }),
    );
    if let Some(slack_config) = settings.slack.clone() {
        chat.register(
            ChannelKind::Slack,
            Arc::new(move |_, store| jian_channel_slack::open(store, slack_config.clone())),
        );
    }
    #[cfg(feature = "public-url")]
    if let Some(url) = &settings.public_url {
        chat.push_through(url.clone());
    }
    let runner = JobRunner::start(
        database.clone(),
        keeper.instance().clone(),
        slots.clone(),
        job_registry(
            &settings,
            &models,
            &events,
            &executor,
            browsers
                .as_ref()
                .map(crate::browser_flags::Browsers::sessions),
            Some(&chat),
        ),
        JobOptions::default(),
    )
    .await;
    let ticking = CancellationToken::new();
    let ticker = tokio::spawn(jian_server::run_ticker(database.clone(), ticking.clone()));
    let mut state = AppState::new(database.clone(), slots, closing.clone(), settings);
    state.channels = chat;
    let channels = state.channels.clone();
    let reconciling = tokio::spawn({
        let (channels, ticking) = (channels.clone(), ticking.clone());
        async move {
            loop {
                if let Err(error) = channels.reconcile().await {
                    tracing::warn!(%error, "starting the chat channels failed");
                }
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(10)) => {}
                    () = ticking.cancelled() => break,
                }
            }
        }
    });
    state.events = events;
    state.hub = hub;
    state.llm = llm;
    state.renderer = browsers
        .as_ref()
        .map(|b| Arc::new(jian_server::BrowserRenderer::new(Arc::clone(&b.browser))) as _);
    let (stop, stopped) = oneshot::channel::<()>();
    let mut server = tokio::spawn(
        axum::serve(
            listener,
            jian_server::router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future(),
    );

    let mut jobs_until = Instant::now() + DRAIN_DEADLINE;
    let outcome = tokio::select! {
        () = shutdown => {
            tracing::info!("stop signal received; draining");
            jobs_until = Instant::now() + DRAIN_DEADLINE;
            keeper.begin_drain().await;
            tracing::info!("no longer serving tenants; open connections told to reconnect");
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
    let _ = reconciling.await;
    channels.shutdown().await;
    let stopped = runner.shutdown(jobs_until).await;
    if let Some(browsers) = &browsers {
        browsers.shutdown().await;
    }
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

/// Starts the local edition embedded by the desktop host and waits for its shutdown token.
pub async fn run_desktop_gateway(shutdown: CancellationToken) -> anyhow::Result<()> {
    let data_dir = default_data_dir()?;
    let master_keys_json = std::env::var("JIAN_MASTER_KEYS").ok();
    let active_key_id = std::env::var("JIAN_ACTIVE_KEY_ID").ok();
    let master_key = std::env::var("JIAN_MASTER_KEY").ok();
    let keys = master_keys(
        &data_dir,
        master_keys_json.as_deref(),
        active_key_id.as_deref(),
        master_key.as_deref(),
    )?;
    let api_token = std::env::var("JIAN_API_TOKEN").ok();
    let (owner, owner_source) = crate::owner_token::resolve(api_token.as_deref(), &data_dir)
        .context("cannot get the owner's token")?;
    let source = DatabaseSource::Embedded(EmbeddedConfig {
        data_dir: data_dir.clone(),
        port: 0,
    });
    let database = Arc::new(
        Database::open(source)
            .await
            .context("cannot open the local database")?
            .with_master_keys(Arc::new(keys))
            .with_blobs(Arc::new(DiskBlobs::new(data_dir.join("files")))),
    );
    let settings = Settings {
        gateway_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        ..Settings::default()
    };
    let browser = crate::browser_flags::BrowserFlags::default();
    let served = match prepare(&database, &owner).await {
        Ok(_) => {
            serve(
                "127.0.0.1:4410",
                &database,
                &owner_source,
                settings,
                &data_dir,
                &browser,
                shutdown.cancelled_owned(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    let closed = close(database).await;
    served?;
    closed
}
