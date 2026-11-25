//! The OS service that keeps the worker running: launchd on macOS, systemd on Linux, Task
//! Scheduler on Windows. Every start stops what ran before, so there is only ever one worker.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "macos", all(test, unix)))]
mod macos;
#[cfg(windows)]
mod windows;

use anyhow::{Context as _, bail};
use std::path::{Path, PathBuf};

use jian_remote::error::UpdateError;

use crate::{lock, paths};

pub struct Started {
    pub service: String,
    pub detail: String,
}

pub fn kind() -> &'static str {
    #[cfg(target_os = "linux")]
    return linux::current_scope().kind();
    #[cfg(target_os = "macos")]
    return "LaunchAgent";
    #[cfg(windows)]
    return "Task Scheduler";
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    return "none";
}

/// Stops the service, and any worker still holding the lock however it was started.
pub fn stop() -> anyhow::Result<String> {
    #[cfg(target_os = "linux")]
    linux::stop();
    #[cfg(target_os = "macos")]
    macos::stop();
    #[cfg(windows)]
    windows::stop();
    let lock = paths::lock_path();
    if let Some(pid) = lock::read_pid(&lock)
        && pid != std::process::id()
        && !lock::terminate(pid)
    {
        bail!(
            "Stopped the {} job but worker pid {pid} is still running. Try again or kill it.",
            kind()
        );
    }
    let _ = std::fs::remove_file(&lock);
    Ok(kind().to_owned())
}

/// Puts this binary where the service runs it. On a Mac that is inside the app bundle, which is
/// written and signed around it.
pub fn put_binary() -> anyhow::Result<PathBuf> {
    let source = std::env::current_exe().context("Could not find this binary")?;
    let target = paths::installed_binary();
    let same = std::fs::canonicalize(&source).ok() == std::fs::canonicalize(&target).ok();
    if !same {
        copy_binary(&source, &target)?;
    }
    refresh_bundle(env!("CARGO_PKG_VERSION"))?;
    Ok(target)
}

/// On a Mac, the bundle's Info.plist and its ad-hoc signature, which must be made again whenever
/// the binary's bytes change. Nothing elsewhere.
#[allow(
    clippy::unnecessary_wraps,
    reason = "the signature the updater calls; only a Mac can fail"
)]
pub fn refresh_bundle(version: &str) -> Result<(), UpdateError> {
    #[cfg(target_os = "macos")]
    {
        let app = paths::macos_app_root();
        macos::write_bundle(&app, version)?;
        macos::sign(&app, &paths::installed_binary());
    }
    let _ = version;
    Ok(())
}

/// Through a temporary file and a rename: the old binary may be running, and a half-copied one
/// must never be what the service starts.
fn copy_binary(source: &Path, target: &Path) -> anyhow::Result<()> {
    let parent = target.parent().context("The install path has no folder.")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("Could not create {}", parent.display()))?;
    let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::copy(source, &temporary)
        .with_context(|| format!("Could not copy {}", source.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755));
    }
    if cfg!(windows) && target.exists() {
        let _ = std::fs::remove_file(target);
    }
    std::fs::rename(&temporary, target)
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&temporary);
        })
        .with_context(|| format!("Could not install {}", target.display()))
}

/// Registers and starts the installed binary. `fresh` is a new install, which may pick a new
/// Linux scope; `prefer_system` is `--system`.
pub fn start(fresh: bool, prefer_system: bool) -> anyhow::Result<Started> {
    // A worker that would not die must not be started over; any other stop failure is moot, the
    // start below replaces what ran.
    if let Err(error) = stop()
        && error.to_string().contains("still running")
    {
        return Err(error);
    }
    let binary = paths::installed_binary();
    if !binary.exists() {
        bail!(
            "No installed worker at {}. Run: jian-remote install --gateway … --token-prompt",
            binary.display()
        );
    }
    let _ = (fresh, prefer_system);
    #[cfg(target_os = "linux")]
    let started = linux::start(&binary, linux::choose_scope(prefer_system, fresh)?);
    #[cfg(target_os = "macos")]
    let started = macos::start(&binary);
    #[cfg(windows)]
    let started = windows::start(&binary);
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    let started: anyhow::Result<(String, String)> = Err(anyhow::anyhow!(
        "No service manager is supported here. Run: {} run",
        binary.display()
    ));
    started.map(|(service, detail)| Started { service, detail })
}

/// Stops and unregisters the service and removes what install put in place, keeping the config
/// and the log unless `purge`.
pub fn uninstall(purge: bool) -> Vec<String> {
    let _ = stop();
    #[cfg(target_os = "linux")]
    let mut removed = linux::uninstall();
    #[cfg(target_os = "macos")]
    let mut removed = macos::uninstall();
    #[cfg(windows)]
    let mut removed = windows::uninstall();
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    let mut removed = Vec::new();
    let binary = paths::installed_binary();
    if binary.exists() && std::fs::remove_file(&binary).is_ok() {
        removed.push(binary.to_string_lossy().into_owned());
    }
    if purge {
        let dir = paths::config_dir();
        if std::fs::remove_dir_all(&dir).is_ok() {
            removed.push(dir.to_string_lossy().into_owned());
        }
    }
    removed
}
