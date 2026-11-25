//! The commands that change the install: pair and install, reconfigure, start/stop/restart,
//! uninstall, and update from a GitHub release.

use jian_remote::update::{GITHUB_API, REPOSITORY, UpdateConfig};

use crate::args::Args;
use crate::config::{self, Config};
use crate::output::{self, success};
use crate::{paths, service};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn gateway_and_token(args: &Args, current: Option<&Config>) -> Result<Config, String> {
    let gateway = match (args.option(&["--gateway"]), current) {
        (Some(gateway), _) => config::parse_gateway(gateway)?,
        (None, Some(current)) => current.gateway.clone(),
        (None, None) => {
            return Err(
                "Missing --gateway https://… (the gateway this machine pairs with).".into(),
            );
        }
    };
    let token = match (config::read_token(args)?, current) {
        (Some(token), _) if !token.is_empty() => token,
        (Some(_), _) => return Err("The machine token is empty.".into()),
        (None, Some(current)) => current.token.clone(),
        (None, None) => {
            return Err(
                "Missing the machine token: --token-prompt, --token-stdin or --token VALUE.".into(),
            );
        }
    };
    Ok(Config { gateway, token })
}

/// Pairs and installs: saves the config, puts the binary in place, registers and starts the
/// service. Run again, it replaces what was there.
pub fn install(args: &Args) -> Result<(), String> {
    let config = gateway_and_token(args, None)?;
    config::save(&config)?;
    let binary = service::put_binary()?;
    let started = service::start(true, args.flag(&["--system"]))?;
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
pub fn configure(args: &Args) -> Result<(), String> {
    let current = config::load().ok();
    let config = gateway_and_token(args, current.as_ref())?;
    config::save(&config)?;
    let mut facts = vec![("Gateway", config.gateway)];
    if paths::installed_binary().exists() {
        let started = service::start(false, false)?;
        facts.push(("Service", format!("{} (restarted)", started.service)));
    }
    success("Configuration saved", &facts);
    Ok(())
}

pub fn start() -> Result<(), String> {
    config::load()?;
    let started = service::start(false, false)?;
    success(
        "Jian Remote started",
        &[("Service", started.service), ("Where", started.detail)],
    );
    Ok(())
}

pub fn stop() -> Result<(), String> {
    let kind = service::stop()?;
    success("Jian Remote stopped", &[("Service", kind)]);
    Ok(())
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "every command returns the same result"
)]
pub fn uninstall(args: &Args) -> Result<(), String> {
    let purge = args.flag(&["--purge"]);
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

/// `update [--version X]`: the installed binary from a release, checked against its SHA-256,
/// then the service restarted onto it. The gateway can ask a running worker for the same.
pub async fn update(args: &Args) -> Result<(), String> {
    let version = args.option(&["--version"]).unwrap_or("latest");
    let binary = paths::installed_binary();
    if !binary.exists() {
        return Err(format!(
            "No installed worker at {}. Install it first.",
            binary.display()
        ));
    }
    let config = UpdateConfig {
        api_base: GITHUB_API.into(),
        repository: REPOSITORY.into(),
        binary,
        current: VERSION.into(),
        // The bytes change, so the bundle's ad-hoc signature must be made again.
        after_install: Some(service::refresh_bundle),
    };
    let outcome = jian_remote::update::update(version, &config).await?;
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
