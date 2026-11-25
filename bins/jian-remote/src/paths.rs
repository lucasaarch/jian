//! Where Jian Remote keeps its files: all under `~/.config/jian-remote`, the same on every OS,
//! so `status` and `logs` find them whichever service started the worker.

use std::path::PathBuf;

// Each service's names are only read on its own OS (and macOS's in its unit test).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MACOS_LAUNCH_AGENT_LABEL: &str = "com.jian.remote";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MACOS_BUNDLE_ID: &str = "com.jian.remote";
pub const MACOS_APP_NAME: &str = "Jian Remote";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const LINUX_SERVICE_UNIT: &str = "jian-remote.service";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const LINUX_SYSTEM_UNIT_PATH: &str = "/etc/systemd/system/jian-remote.service";
#[cfg_attr(not(windows), allow(dead_code))]
pub const WINDOWS_TASK_NAME: &str = "Jian Remote";
/// launchd's floor between restarts, so a bad update cannot spin-restart every second.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LAUNCH_AGENT_THROTTLE_SECONDS: u32 = 10;

pub fn home() -> PathBuf {
    jian_remote::shell::home_dir()
}

pub fn config_dir() -> PathBuf {
    home().join(".config").join("jian-remote")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Held by the running worker: two on one machine would both answer the same token.
pub fn lock_path() -> PathBuf {
    config_dir().join("worker.pid")
}

pub fn log_path() -> PathBuf {
    config_dir().join("worker.log")
}

pub fn state_path() -> PathBuf {
    config_dir().join("state.json")
}

/// Whether the Linux install used systemd --user or a system unit.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_scope_path() -> PathBuf {
    config_dir().join("linux-service-scope")
}

pub fn macos_app_root() -> PathBuf {
    home()
        .join("Library")
        .join("Application Support")
        .join(MACOS_APP_NAME)
        .join(format!("{MACOS_APP_NAME}.app"))
}

/// Where the service runs the worker from: a stable copy, never the download or build that ran
/// `install`, which may move or vanish. On a Mac it is the app's own executable, so Login Items
/// and the privacy permissions name Jian Remote.
pub fn installed_binary() -> PathBuf {
    if cfg!(target_os = "macos") {
        macos_app_root()
            .join("Contents")
            .join("MacOS")
            .join(MACOS_APP_NAME)
    } else if cfg!(windows) {
        config_dir().join("jian-remote.exe")
    } else {
        config_dir().join("jian-remote")
    }
}
