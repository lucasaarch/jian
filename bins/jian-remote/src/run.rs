//! `run`: the worker in the foreground, as every service starts it. Holds the lock while it runs,
//! so a second worker on the same token cannot start beside it.

use std::sync::Arc;

use anyhow::Context as _;
use jian_remote::computer::HelperCommand;
use jian_remote::files::FilesConfig;
use jian_remote::log::Logger;
use jian_remote::state::StateFile;
use jian_remote::transport::WsTransport;
use jian_remote::update::UpdateConfig;
use jian_remote::worker::{Exit, Timings, Worker, WorkerConfig};
use tokio_util::sync::CancellationToken;

use crate::{config, lock, paths};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runs the worker until it is stopped or updated.
pub fn run() -> anyhow::Result<()> {
    let config = config::load()?;
    let lock_path = paths::lock_path();
    lock::acquire(&lock_path)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("Could not start the async runtime");
    let exit = runtime.and_then(|runtime| runtime.block_on(work(config)));
    jian_remote::process::reap_all();
    lock::release(&lock_path);
    exit.map(|_| ())
}

async fn work(config: config::Config) -> anyhow::Result<Exit> {
    let log = Arc::new(Logger::new(paths::log_path()));
    let state = StateFile::new(Some(paths::state_path()), VERSION);
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    state.update(|state| {
        state.gateway = Some(config.gateway.clone());
        state.platform = Some(platform);
    });
    let transport = WsTransport::new(&config.gateway, &config.token)?;
    let worker = Worker::new(
        Box::new(transport),
        WorkerConfig {
            version: VERSION.into(),
            files: FilesConfig::default(),
            helper: HelperCommand::this_binary(),
            update: UpdateConfig::for_this_binary(VERSION, Some(crate::service::refresh_bundle)),
            state: state.clone(),
            log: log.clone(),
            timings: Timings::default(),
        },
    );
    // Held for the life of the worker; dropping it lets the Mac sleep again.
    let _awake = jian_remote::computer::macos::hold_worker_awake();
    let stop = CancellationToken::new();
    tokio::spawn(stop_on_signal(stop.clone()));
    log.info(
        "worker started",
        &[("version", VERSION), ("gateway", &config.gateway)],
    );
    let exit = worker.run(stop).await;
    state.update(|state| {
        state.connected = false;
        state.stopped_at = Some(jian_remote::clock::now_iso());
    });
    let why = if exit == Exit::Updated {
        "updated"
    } else {
        "stopped"
    };
    log.info("worker exiting", &[("reason", why)]);
    Ok(exit)
}

/// SIGTERM is how every service manager stops the worker; SIGINT is Ctrl-C on `run` by hand.
async fn stop_on_signal(stop: CancellationToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut term) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            stop.cancel();
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    stop.cancel();
}
