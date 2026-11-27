//! The browser program, started when a page is first wanted and stopped when it has been idle.
//!
//! One program serves the whole gateway; what keeps tenants apart is the browser context each
//! [`Browser::open`] makes (`session`). Starting is single-file (`launch` lock), so two runs that
//! ask at once start one program. A program that died is noticed at the next open and replaced.

use std::ffi::OsString;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;

use crate::cdp::Cdp;
use crate::process::Sidecar;
use crate::session::CdpSession;
use crate::{
    Browser, BrowserError, COMMAND_TIMEOUT_MS, IDLE_SECONDS, LAUNCH_TIMEOUT_MS,
    NAVIGATION_TIMEOUT_MS, NetworkPolicy, Session,
};

/// Which engine a program is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// Obscura: small, fast, and refuses a private network by itself.
    Obscura,
    /// Chromium (or Chrome): runs what Obscura cannot.
    Chromium,
}

impl Engine {
    /// The name the logs and the agent use.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Obscura => "obscura",
            Self::Chromium => "chromium",
        }
    }
}

/// How to run one engine.
#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// Which engine the program is.
    pub engine: Engine,
    /// The program.
    pub binary: PathBuf,
    /// What network a page may reach.
    pub policy: NetworkPolicy,
    /// How long the program stays up with no page open.
    pub idle: Duration,
}

impl EngineConfig {
    /// The usual settings for a program: stopped after [`IDLE_SECONDS`] with no page open.
    #[must_use]
    pub fn new(engine: Engine, binary: PathBuf, policy: NetworkPolicy) -> Self {
        Self {
            engine,
            binary,
            policy,
            idle: Duration::from_secs(IDLE_SECONDS),
        }
    }
}

struct Running {
    sidecar: Sidecar,
    cdp: Arc<Cdp>,
    /// Pages open now.
    sessions: usize,
    /// Which start this is, so an idle timer of an earlier one never stops a later one.
    generation: u64,
    last_used: Instant,
}

pub(crate) struct Shared {
    pub(crate) cfg: EngineConfig,
    state: Mutex<Option<Running>>,
    launch: tokio::sync::Mutex<()>,
    generation: AtomicU64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere must not make the browser unusable for everyone after it.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A page's hold on the program: while one exists the program is not stopped as idle.
pub(crate) struct Lease {
    shared: Arc<Shared>,
    generation: u64,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let idle = {
            let mut state = locked(&self.shared.state);
            match state.as_mut() {
                Some(r) if r.generation == self.generation => {
                    r.sessions = r.sessions.saturating_sub(1);
                    r.last_used = Instant::now();
                    r.sessions == 0
                }
                _ => false,
            }
        };
        if !idle {
            return;
        }
        // Outside a runtime (the process is going down) the program is killed by its own drop.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (shared, generation) = (Arc::clone(&self.shared), self.generation);
        runtime.spawn(async move {
            tokio::time::sleep(shared.cfg.idle).await;
            let taken = {
                let mut state = locked(&shared.state);
                let due = state.as_ref().is_some_and(|r| {
                    r.generation == generation
                        && r.sessions == 0
                        && r.last_used.elapsed() >= shared.cfg.idle
                });
                if due { state.take() } else { None }
            };
            if let Some(running) = taken {
                tracing::debug!(
                    engine = shared.cfg.engine.name(),
                    "stopping an idle browser"
                );
                running.sidecar.stop().await;
            }
        });
    }
}

/// An engine reached over CDP. Cheap to clone: it is a handle.
#[derive(Clone)]
pub struct CdpBrowser {
    shared: Arc<Shared>,
}

impl CdpBrowser {
    /// A browser that starts its program at the first [`open`](Browser::open).
    #[must_use]
    pub fn new(cfg: EngineConfig) -> Self {
        Self {
            shared: Arc::new(Shared {
                cfg,
                state: Mutex::new(None),
                launch: tokio::sync::Mutex::new(()),
                generation: AtomicU64::new(1),
            }),
        }
    }

    /// Whether the program is running now.
    #[must_use]
    pub fn running(&self) -> bool {
        locked(&self.shared.state).is_some()
    }

    /// Stops the program now, whatever is open (the gateway is going down).
    pub async fn shutdown(&self) {
        let taken = locked(&self.shared.state).take();
        if let Some(running) = taken {
            running.sidecar.stop().await;
        }
    }

    /// The program's process id while it runs.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        locked(&self.shared.state)
            .as_ref()
            .and_then(|r| r.sidecar.pid())
    }

    async fn acquire(&self) -> Result<(Arc<Cdp>, Lease), BrowserError> {
        let shared = &self.shared;
        let _starting = shared.launch.lock().await;
        let stale = {
            let mut state = locked(&shared.state);
            if let Some(r) = state.as_mut()
                && r.cdp.alive()
                && !r.sidecar.exited()
            {
                r.sessions += 1;
                let lease = Lease {
                    shared: Arc::clone(shared),
                    generation: r.generation,
                };
                return Ok((Arc::clone(&r.cdp), lease));
            }
            state.take()
        };
        if let Some(old) = stale {
            old.sidecar.stop().await;
        }
        let (sidecar, cdp) = launch(&shared.cfg).await?;
        let cdp = Arc::new(cdp);
        let generation = shared.generation.fetch_add(1, Ordering::SeqCst);
        *locked(&shared.state) = Some(Running {
            sidecar,
            cdp: Arc::clone(&cdp),
            sessions: 1,
            generation,
            last_used: Instant::now(),
        });
        Ok((
            cdp,
            Lease {
                shared: Arc::clone(shared),
                generation,
            },
        ))
    }
}

impl Browser for CdpBrowser {
    fn engine(&self) -> &'static str {
        self.shared.cfg.engine.name()
    }

    fn open(&self) -> BoxFuture<'_, Result<Box<dyn Session>, BrowserError>> {
        Box::pin(async move {
            let (cdp, lease) = self.acquire().await?;
            let session = CdpSession::open(cdp, lease, self.shared.cfg.clone()).await?;
            Ok(Box::new(session) as Box<dyn Session>)
        })
    }
}

/// A port nobody listens on now. Another process may take it before the browser does, which
/// shows as a failed start and is tried again.
fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn launch_error(what: impl std::fmt::Display) -> BrowserError {
    BrowserError::Launch(what.to_string())
}

/// Starts the program and connects to it.
async fn launch(cfg: &EngineConfig) -> Result<(Sidecar, Cdp), BrowserError> {
    let deadline = Instant::now() + Duration::from_millis(LAUNCH_TIMEOUT_MS);
    let mut last = launch_error("no answer");
    // A port taken between choosing it and listening on it is the only failure worth a retry.
    for _ in 0..3 {
        match launch_once(cfg, deadline).await {
            Ok(started) => return Ok(started),
            Err(error) => last = error,
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    Err(last)
}

async fn launch_once(
    cfg: &EngineConfig,
    deadline: Instant,
) -> Result<(Sidecar, Cdp), BrowserError> {
    let mut env: Vec<(&str, String)> = Vec::new();
    let (args, scratch, fixed): (Vec<OsString>, _, Option<String>) = match cfg.engine {
        Engine::Obscura => {
            let port = free_port().map_err(launch_error)?;
            let mut args = vec!["serve".into(), "--port".into(), port.to_string().into()];
            if cfg.policy == NetworkPolicy::AnyNetwork {
                args.push("--allow-private-network".into());
            }
            // Obscura's own limits, set under ours so it gives up before we do.
            env.push(("OBSCURA_NAV_TIMEOUT_MS", NAVIGATION_TIMEOUT_MS.to_string()));
            env.push((
                "OBSCURA_CDP_COMMAND_TIMEOUT_MS",
                COMMAND_TIMEOUT_MS.to_string(),
            ));
            (
                args,
                None,
                Some(format!("ws://127.0.0.1:{port}/devtools/browser")),
            )
        }
        Engine::Chromium => {
            let scratch = tempfile::tempdir().map_err(launch_error)?;
            let mut args: Vec<OsString> = [
                "--headless=new",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--mute-audio",
                // No guessing ahead: a page is fetched only when it is asked for, so what the
                // request gate refuses is not connected to anyway.
                "--disable-background-networking",
                "--dns-prefetch-disable",
                // Sites in one process, so the page's own request interception sees an iframe's
                // requests too.
                "--disable-features=IsolateOrigins,site-per-process,Translate",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "about:blank",
            ]
            .into_iter()
            .map(OsString::from)
            .collect();
            let mut profile = OsString::from("--user-data-dir=");
            profile.push(scratch.path());
            args.push(profile);
            // Chromium will not start as root with its sandbox on, and a container runs as root.
            #[cfg(unix)]
            if rustix::process::getuid().is_root() {
                args.push("--no-sandbox".into());
            }
            (args, Some(scratch), None)
        }
    };
    let profile = scratch.as_ref().map(|s| s.path().to_path_buf());
    let mut sidecar = Sidecar::spawn(&cfg.binary, &args, &env, scratch)
        .map_err(|e| launch_error(format!("{}: {e}", cfg.binary.display())))?;
    loop {
        if sidecar.exited() {
            return Err(launch_error("the program exited"));
        }
        if Instant::now() >= deadline {
            sidecar.stop().await;
            return Err(launch_error("it did not answer in time"));
        }
        let url = match (&fixed, &profile) {
            (Some(url), _) => Some(url.clone()),
            (None, Some(dir)) => chromium_endpoint(dir).await,
            (None, None) => None,
        };
        if let Some(url) = url
            && let Ok(cdp) = Cdp::connect(&url).await
        {
            return Ok((sidecar, cdp));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Where Chromium listens, from the file it writes in its profile once it does: the port on the
/// first line and the socket's path on the second.
async fn chromium_endpoint(profile: &std::path::Path) -> Option<String> {
    let text = tokio::fs::read_to_string(profile.join("DevToolsActivePort"))
        .await
        .ok()?;
    let mut lines = text.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    Some(format!("ws://127.0.0.1:{port}{path}"))
}
