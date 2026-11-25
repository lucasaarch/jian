//! The commands that change the install: pair and install, reconfigure, start/stop/restart,
//! uninstall, and update from a GitHub release.

use anyhow::{Context as _, bail};
use jian_remote::update::{GITHUB_API, REPOSITORY, UpdateConfig};

use crate::args::{ConfigureArgs, InstallArgs, TokenArgs};
use crate::config::{self, Config};
use crate::output::{self, success};
use crate::{paths, service};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The gateway is already validated by the parser; whatever is left out comes from `current`.
fn gateway_and_token(
    gateway: Option<String>,
    token: &TokenArgs,
    current: Option<&Config>,
) -> anyhow::Result<Config> {
    let gateway = match (gateway, current) {
        (Some(gateway), _) => gateway,
        (None, Some(current)) => current.gateway.clone(),
        (None, None) => {
            bail!("Missing --gateway https://… (the gateway this machine pairs with).");
        }
    };
    let token = match (config::read_token(token)?, current) {
        (Some(token), _) if !token.is_empty() => token,
        (Some(_), _) => bail!("The machine token is empty."),
        (None, Some(current)) => current.token.clone(),
        (None, None) => {
            bail!("Missing the machine token: --token-prompt, --token-stdin or --token VALUE.");
        }
    };
    Ok(Config { gateway, token })
}

/// Pairs and installs: saves the config, puts the binary in place, registers and starts the
/// service. Run again, it replaces what was there.
pub fn install(args: InstallArgs) -> anyhow::Result<()> {
    let config = gateway_and_token(Some(args.gateway), &args.token, None)?;
    config::save(&config)?;
    let binary = service::put_binary()?;
    let started = service::start(true, args.system)?;
    success(
        "Jian Remote is installed and running",
        &[
            ("Gateway", config.gateway),
            ("Service", started.service),
            ("Where", started.detail),
            ("Binary", binary.to_string_lossy().into_owned()),
            ("Log", paths::log_path().to_string_lossy().into_owned()),
        ],
    );
    output::info("Check it with: jian-remote status");
    Ok(())
}

/// A new gateway or token without reinstalling; restarts the worker if it is installed.
pub fn configure(args: ConfigureArgs) -> anyhow::Result<()> {
    let current = config::load().ok();
    let config = gateway_and_token(args.gateway, &args.token, current.as_ref())?;
    config::save(&config)?;
    let mut facts = vec![("Gateway", config.gateway)];
    if paths::installed_binary().exists() {
        let started = service::start(false, false)?;
        facts.push(("Service", format!("{} (restarted)", started.service)));
    }
    success("Configuration saved", &facts);
    Ok(())
}

/// Starts (or restarts) the installed service.
pub fn start() -> anyhow::Result<()> {
    config::load()?;
    let started = service::start(false, false)?;
    success(
        "Jian Remote started",
        &[("Service", started.service), ("Where", started.detail)],
    );
    Ok(())
}

/// Stops the service and any worker still holding the lock.
pub fn stop() -> anyhow::Result<()> {
    let kind = service::stop()?;
    success("Jian Remote stopped", &[("Service", kind)]);
    Ok(())
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "every command returns the same result"
)]
pub fn uninstall(purge: bool) -> anyhow::Result<()> {
    let removed = service::uninstall(purge);
    let mut facts: Vec<(&str, String)> =
        removed.into_iter().map(|path| ("Removed", path)).collect();
    if !purge {
        facts.push(("Kept", paths::config_dir().to_string_lossy().into_owned()));
    }
    success("Jian Remote uninstalled", &facts);
    if !purge {
        output::info(
            "The config and log stay; remove them too with: jian-remote uninstall --purge",
        );
    }
    Ok(())
}

/// `update --version X`: the installed binary from a release, checked against its SHA-256,
/// then the service restarted onto it. The gateway can ask a running worker for the same.
pub async fn update(version: &str) -> anyhow::Result<()> {
    let binary = paths::installed_binary();
    if !binary.exists() {
        bail!(
            "No installed worker at {}. Install it first.",
            binary.display()
        );
    }
    let config = UpdateConfig {
        api_base: GITHUB_API.into(),
        repository: REPOSITORY.into(),
        binary,
        current: VERSION.into(),
        // The bytes change, so the bundle's ad-hoc signature must be made again.
        after_install: Some(service::refresh_bundle),
    };
    let outcome = jian_remote::update::update(version, &config)
        .await
        .context("The update failed")?;
    if outcome.from == outcome.to {
        success("Jian Remote is up to date", &[("Version", outcome.to)]);
        return Ok(());
    }
    let started = service::start(false, false)?;
    success(
        "Jian Remote updated",
        &[
            ("From", outcome.from),
            ("To", outcome.to),
            ("Service", started.service),
        ],
    );
    Ok(())
}
