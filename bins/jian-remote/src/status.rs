//! Everything about this worker in one place: where it connects, whether it runs and is
//! connected, versions, what it has run, and how far the gateway is now. `--json` prints the same
//! as one object, for scripts.

use std::time::{Duration, Instant};

use jian_remote::clock::{now_ms, parse_iso};
use serde_json::{Value, json};

use crate::output::{self, GREEN, RED, YELLOW, paint};
use crate::{config, lock, paths, service};

struct Ping {
    ok: bool,
    ms: u128,
    status: Option<u16>,
    version: Option<String>,
    error: Option<String>,
}

async fn ping(gateway: &str) -> Ping {
    let started = Instant::now();
    jian_remote::tls::install_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let answer = match client {
        Ok(client) => client.get(format!("{gateway}/health")).send().await,
        Err(error) => Err(error),
    };
    match answer {
        Ok(response) => {
            let status = response.status();
            let ms = started.elapsed().as_millis();
            let body: Value = response.json().await.unwrap_or_default();
            Ping {
                ok: status.is_success(),
                ms,
                status: Some(status.as_u16()),
                version: body
                    .get("version")
                    .and_then(Value::as_str)
                    .map(String::from),
                error: None,
            }
        }
        Err(error) => Ping {
            ok: false,
            ms: 0,
            status: None,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

fn ago(at: Option<&str>) -> Option<String> {
    let at = parse_iso(at?)?;
    Some(output::since(now_ms().saturating_sub(at)))
}

/// Exits 1 when the worker is not connected, so a script can tell.
pub async fn status(json: bool) -> anyhow::Result<i32> {
    let config = config::load().ok();
    // Written by whichever worker ran last: any field may be missing.
    let state = jian_remote::state::read(&paths::state_path());
    let pid = lock::read_pid(&paths::lock_path()).filter(|pid| lock::alive(*pid));
    let running = pid.is_some();
    let connected = running
        && state
            .as_ref()
            .is_some_and(|state| Some(state.pid) == pid && state.connected);
    let ping = match &config {
        Some(config) => Some(ping(&config.gateway).await),
        None => None,
    };
    let version = env!("CARGO_PKG_VERSION");
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let gateway_version = ping
        .as_ref()
        .and_then(|ping| ping.version.clone())
        .or_else(|| {
            state
                .as_ref()
                .and_then(|state| state.gateway_version.clone())
        });

    if json {
        let report = json!({
            "installed": config.is_some(),
            "running": running,
            "connected": connected,
            "pid": pid,
            "gateway": config.as_ref().map(|config| &config.gateway),
            "machineId": state.as_ref().and_then(|state| state.machine_id.clone()),
            "worker": version,
            "service": service::kind(),
            "gatewayVersion": gateway_version,
            "ping": ping.as_ref().map(|ping| json!({
                "ok": ping.ok, "ms": ping.ms, "status": ping.status, "error": ping.error,
            })),
            "platform": platform,
            "state": state,
            "log": paths::log_path(),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        );
        return Ok(i32::from(!connected));
    }
    let Some(config) = config else {
        output::info(
            "Jian Remote is not installed here. Run the command the panel shows for this machine.",
        );
        return Ok(1);
    };
    let on = output::colour(false);
    let (word, mark) = match (connected, running) {
        (true, _) => (paint("Connected", GREEN, on), paint("✓", GREEN, on)),
        (false, true) => (
            paint("Running, not connected", YELLOW, on),
            paint("!", YELLOW, on),
        ),
        _ => (paint("Stopped", RED, on), paint("✗", RED, on)),
    };
    let ping_text = match &ping {
        Some(ping) if ping.ok => format!("{} ms", ping.ms),
        Some(Ping {
            status: Some(status),
            ..
        }) => format!("unreachable (HTTP {status})"),
        Some(Ping {
            error: Some(error), ..
        }) => format!("unreachable ({error})"),
        _ => "unreachable".into(),
    };
    let mut facts = vec![
        ("Status", word),
        ("Gateway", config.gateway.clone()),
        (
            "Versions",
            format!(
                "worker {version} · gateway {}",
                gateway_version.as_deref().unwrap_or("unknown")
            ),
        ),
        ("Ping", ping_text),
        ("Service", service::kind().to_owned()),
    ];
    if let Some(state) = &state {
        if let Some(machine) = &state.machine_id {
            facts.push(("Machine", machine.clone()));
        }
        let capabilities = state.capabilities.join(", ");
        facts.push(("Platform", format!("{platform} · {capabilities}")));
        if let Some(pid) = pid {
            let up = ago(Some(&state.started_at))
                .map(|up| format!(", up {up}"))
                .unwrap_or_default();
            facts.push(("Process", format!("pid {pid}{up}")));
        }
        if let Some(contact) = ago(state.last_contact_at.as_deref()) {
            facts.push(("Last contact", format!("{contact} ago")));
        }
        let tasks = &state.tasks;
        facts.push((
            "Actions",
            format!(
                "{} run ({} shell, {} files, {} computer), {} failed",
                tasks.total, tasks.shell, tasks.files, tasks.computer, tasks.failed
            ),
        ));
        if let Some(last) = &state.last_task {
            let when = ago(Some(&last.at))
                .map(|at| format!(", {at} ago"))
                .unwrap_or_default();
            let ok = if last.ok { "ok" } else { "failed" };
            facts.push((
                "Last action",
                format!("{}, {ok}, {} ms{when}", last.kind, last.duration_ms),
            ));
        }
        if let Some(error) = &state.last_error {
            let when = ago(state.last_error_at.as_deref())
                .map(|at| format!(" ({at} ago)"))
                .unwrap_or_default();
            facts.push(("Last error", format!("{error}{when}")));
        }
    }
    facts.push(("Log", paths::log_path().to_string_lossy().into_owned()));
    print!("{}", output::block(&mark, "Jian Remote", &facts));
    Ok(i32::from(!connected))
}
