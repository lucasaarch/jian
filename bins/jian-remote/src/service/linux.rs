//! systemd: a user unit where the user's bus is reachable, a system unit on a headless or root
//! host where it is not (or when `--system` asks for one).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths::{self, LINUX_SERVICE_UNIT, LINUX_SYSTEM_UNIT_PATH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
}

impl Scope {
    pub fn kind(self) -> &'static str {
        match self {
            Self::User => "systemd --user",
            Self::System => "systemd (system)",
        }
    }
}

/// Each step its own command: `enable --now` can answer 0 even though the start it asked for
/// was refused, which would report a worker running that never started.
const START: [&[&str]; 3] = [
    &["daemon-reload"],
    &["enable", LINUX_SERVICE_UNIT],
    &["start", LINUX_SERVICE_UNIT],
];

const NO_USER_BUS: &str = "Could not reach systemd --user (no user bus). This is common on a headless VPS or root SSH session (\"Failed to connect to bus: No medium found\" / missing XDG_RUNTIME_DIR).

Fix options:
  1. Prefer a normal user + lingering, then reinstall:
       sudo loginctl enable-linger USERNAME
       # as USERNAME:
       export XDG_RUNTIME_DIR=/run/user/$(id -u)
       jian-remote install --gateway … --token-prompt
  2. Install a system unit (as root):
       jian-remote install --system --gateway … --token-prompt
  3. Run it in the foreground to try it:
       jian-remote run";

pub fn user_unit_path() -> PathBuf {
    paths::home()
        .join(".config")
        .join("systemd")
        .join("user")
        .join(LINUX_SERVICE_UNIT)
}

fn systemctl(scope: Scope, args: &[&str]) -> Command {
    let mut command = Command::new("systemctl");
    if scope == Scope::User {
        command.arg("--user");
    }
    command.args(args);
    command
}

fn quiet(mut command: Command) -> bool {
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Headless and root SSH sessions often have no `XDG_RUNTIME_DIR`, and no user bus with it.
fn user_bus_available() -> bool {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    runtime.is_some_and(|dir| dir.is_dir()) && quiet(systemctl(Scope::User, &["show-environment"]))
}

fn can_install_system_unit() -> bool {
    // SAFETY: geteuid has no preconditions; access only reads a path we own the string of.
    if unsafe { libc::geteuid() } == 0 {
        return true;
    }
    let dir = std::ffi::CString::new("/etc/systemd/system").expect("no NUL");
    unsafe { libc::access(dir.as_ptr(), libc::W_OK) == 0 }
}

/// A fresh install probes the bus (and honours `--system`); every later start keeps the saved
/// scope, so a system-unit install does not flip back when a user bus appears.
pub fn choose_scope(prefer_system: bool, fresh: bool) -> Result<Scope, String> {
    if prefer_system {
        return if can_install_system_unit() {
            Ok(Scope::System)
        } else {
            Err("install --system needs write access to /etc/systemd/system (run as root, or use sudo).".into())
        };
    }
    if !fresh {
        match saved_scope() {
            Some(Scope::System) if can_install_system_unit() => return Ok(Scope::System),
            Some(Scope::User) if user_bus_available() => return Ok(Scope::User),
            _ => {}
        }
    }
    if user_bus_available() {
        Ok(Scope::User)
    } else if can_install_system_unit() {
        Ok(Scope::System)
    } else {
        Err(NO_USER_BUS.into())
    }
}

fn saved_scope() -> Option<Scope> {
    match std::fs::read_to_string(paths::linux_scope_path())
        .ok()?
        .trim()
    {
        "system" => Some(Scope::System),
        "user" => Some(Scope::User),
        _ => None,
    }
}

/// The scope a stop or uninstall acts on: as saved, or guessed from which unit exists.
pub fn current_scope() -> Scope {
    saved_scope().unwrap_or_else(|| {
        if Path::new(LINUX_SYSTEM_UNIT_PATH).exists() {
            Scope::System
        } else {
            Scope::User
        }
    })
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn unit(binary: &Path, home: &Path, scope: Scope, user: Option<&str>) -> String {
    let home = home.to_string_lossy();
    let mut lines = vec![
        "[Unit]".to_owned(),
        "Description=Jian Remote worker".into(),
        "After=network-online.target".into(),
        "Wants=network-online.target".into(),
        String::new(),
        "[Service]".into(),
        format!("ExecStart={} run", systemd_quote(&binary.to_string_lossy())),
        "Restart=always".into(),
        "RestartSec=3".into(),
        // A system unit does not inherit the installing shell's HOME; pinned, so the config
        // stays findable.
        format!("Environment={}", systemd_quote(&format!("HOME={home}"))),
        // Taken whole and never unquoted, unlike the lines above: quotes would make it a relative
        // path, which systemd refuses with the whole unit. `%` is the one character it expands.
        format!("WorkingDirectory={}", home.replace('%', "%%")),
    ];
    if scope == Scope::System
        && let Some(user) = user
    {
        lines.push(format!("User={user}"));
    }
    lines.extend([String::new(), "[Install]".into()]);
    lines.push(format!(
        "WantedBy={}",
        if scope == Scope::System {
            "multi-user.target"
        } else {
            "default.target"
        }
    ));
    lines.push(String::new());
    lines.join("\n")
}

/// The user a system unit runs as, when root is not the one installing it.
fn invoking_user() -> Option<String> {
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return None;
    }
    std::env::var("USER").ok().filter(|user| !user.is_empty())
}

pub fn stop() {
    let scope = current_scope();
    quiet(systemctl(scope, &["stop", LINUX_SERVICE_UNIT]));
}

pub fn start(binary: &Path, scope: Scope) -> Result<(String, String), String> {
    let body = unit(binary, &paths::home(), scope, invoking_user().as_deref());
    let write = |path: &Path, mode: u32| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(path, &body)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        Ok(())
    };
    if scope == Scope::System {
        // A leftover user unit would fight this one over the same token.
        quiet(systemctl(
            Scope::User,
            &["disable", "--now", LINUX_SERVICE_UNIT],
        ));
        let _ = std::fs::remove_file(user_unit_path());
        write(Path::new(LINUX_SYSTEM_UNIT_PATH), 0o644)?;
    } else {
        write(&user_unit_path(), 0o600)?;
        if Path::new(LINUX_SYSTEM_UNIT_PATH).exists() && can_install_system_unit() {
            quiet(systemctl(
                Scope::System,
                &["disable", "--now", LINUX_SERVICE_UNIT],
            ));
            if std::fs::remove_file(LINUX_SYSTEM_UNIT_PATH).is_ok() {
                quiet(systemctl(Scope::System, &["daemon-reload"]));
            }
        }
    }
    let saved = if scope == Scope::System {
        "system\n"
    } else {
        "user\n"
    };
    jian_remote::state::write_private(&paths::linux_scope_path(), saved)
        .map_err(|error| error.to_string())?;
    for step in START {
        let ok = systemctl(scope, step)
            .status()
            .is_ok_and(|status| status.success());
        if !ok && scope == Scope::User {
            return Err("Could not install/start Jian Remote with systemd --user. If you see \"Failed to connect to bus: No medium found\", the user bus is missing (common on headless VPS / root SSH). Retry with: jian-remote install --system …, or enable lingering: sudo loginctl enable-linger \"$(whoami)\" && export XDG_RUNTIME_DIR=/run/user/$(id -u)".into());
        }
        if !ok {
            return Err("Could not install/start Jian Remote with systemd (system unit).".into());
        }
    }
    let detail = if scope == Scope::System {
        LINUX_SYSTEM_UNIT_PATH.to_owned()
    } else {
        user_unit_path().to_string_lossy().into_owned()
    };
    Ok((scope.kind().into(), detail))
}

pub fn uninstall() -> Vec<String> {
    let scope = current_scope();
    quiet(systemctl(scope, &["disable", "--now", LINUX_SERVICE_UNIT]));
    let unit = if scope == Scope::System {
        PathBuf::from(LINUX_SYSTEM_UNIT_PATH)
    } else {
        user_unit_path()
    };
    let mut removed = Vec::new();
    if std::fs::remove_file(&unit).is_ok() {
        removed.push(unit.to_string_lossy().into_owned());
    }
    quiet(systemctl(scope, &["daemon-reload"]));
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_systemd_accepts() {
        let body = unit(
            Path::new("/home/a b/.config/jian-remote/jian-remote"),
            Path::new("/home/a b"),
            Scope::User,
            None,
        );
        assert!(body.contains("ExecStart=\"/home/a b/.config/jian-remote/jian-remote\" run\n"));
        assert!(body.contains("Environment=\"HOME=/home/a b\"\n"));
        assert!(body.contains("WorkingDirectory=/home/a b\n"));
        assert!(body.contains("WantedBy=default.target\n"));
        assert!(!body.contains("User="));

        let system = unit(
            Path::new("/opt/jr"),
            Path::new("/home/100%"),
            Scope::System,
            Some("dev"),
        );
        assert!(system.contains("WorkingDirectory=/home/100%%\n"));
        assert!(system.contains("User=dev\n"));
        assert!(system.contains("WantedBy=multi-user.target\n"));
    }
}
