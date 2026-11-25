//! What this computer is, for the gateway's machine record.

use jian_protocol::machine::{
    CAP_COMPUTER_LINUX, CAP_COMPUTER_MACOS, CAP_COMPUTER_WINDOWS, CAP_FILES, CAP_FORWARDS,
    CAP_SHELL, CAP_UPDATE,
};

/// The longest description sent, in characters; the gateway keeps no more.
const SYSTEM_MAX_LENGTH: usize = 100;

fn printable(value: &str) -> String {
    let spaced: String = value
        .chars()
        .map(|c| if (' '..='~').contains(&c) { c } else { ' ' })
        .collect();
    let joined = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    joined
        .chars()
        .take(SYSTEM_MAX_LENGTH)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `sw_vers -productVersion` (`15.4.1`) as `macOS 15.4.1`; `None` when it said nothing usable.
pub fn macos_system(product_version: &str) -> Option<String> {
    let version = product_version.trim();
    let shaped = !version.is_empty()
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    shaped.then(|| format!("macOS {version}"))
}

/// Windows from its kernel version (`10.0.26100`). Windows 11 still reports 10.0 and differs only
/// in its build, from 22000 on.
pub fn windows_system(kernel: &str) -> String {
    let parts: Vec<&str> = kernel.trim().split('.').collect();
    match parts.as_slice() {
        [major, _, build, ..] if build.parse::<u32>().is_ok() => {
            let build: u32 = build.parse().unwrap_or_default();
            if *major == "10" {
                format!(
                    "Windows {} ({build})",
                    if build >= 22_000 { "11" } else { "10" }
                )
            } else {
                format!("Windows {}", kernel.trim())
            }
        }
        _ => printable(&format!("Windows {kernel}")),
    }
}

/// os-release(5) values may be quoted and backslash-escaped.
fn os_release_value(text: &str, key: &str) -> Option<String> {
    let line = text
        .lines()
        .find(|line| line.trim_start().starts_with(&format!("{key}=")))?;
    let raw = line[line.find('=')? + 1..].trim();
    let quoted = raw.len() >= 2
        && (raw.starts_with('"') && raw.ends_with('"')
            || raw.starts_with('\'') && raw.ends_with('\''));
    let value = if quoted {
        let mut out = String::new();
        let mut chars = raw[1..raw.len() - 1].chars();
        while let Some(c) = chars.next() {
            out.push(if c == '\\' {
                chars.next().unwrap_or('\\')
            } else {
                c
            });
        }
        out
    } else {
        raw.to_owned()
    };
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// PRETTY_NAME (`Ubuntu 24.04.1 LTS`), else NAME and VERSION_ID, else the kernel.
pub fn linux_system(os_release: Option<&str>, kernel: &str) -> String {
    if let Some(text) = os_release {
        if let Some(pretty) = os_release_value(text, "PRETTY_NAME") {
            return pretty;
        }
        if let Some(name) = os_release_value(text, "NAME") {
            return match os_release_value(text, "VERSION_ID") {
                Some(version) => format!("{name} {version}"),
                None => name,
            };
        }
    }
    format!("Linux {}", kernel.trim())
}

fn output(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .unwrap_or_default()
}

/// This computer's OS by name and version as a person reads it. Never fails: what cannot be read
/// falls back to the OS family.
pub fn detect_system() -> String {
    let described = if cfg!(target_os = "macos") {
        macos_system(&output("/usr/bin/sw_vers", &["-productVersion"]))
            .unwrap_or_else(|| format!("macOS (Darwin {})", output("uname", &["-r"])))
    } else if cfg!(windows) {
        let ver = output("cmd", &["/C", "ver"]);
        let kernel = ver
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .find(|part| part.matches('.').count() >= 2)
            .unwrap_or_default()
            .to_owned();
        windows_system(&kernel)
    } else {
        let release = ["/etc/os-release", "/usr/lib/os-release"]
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok());
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
        linux_system(release.as_deref(), &kernel)
    };
    printable(&described)
}

pub fn hostname() -> String {
    if let Ok(name) = std::env::var(if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    }) && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    let read = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
    if !read.trim().is_empty() {
        return read.trim().to_owned();
    }
    let named = output("hostname", &[]);
    if named.is_empty() {
        "unknown".into()
    } else {
        named
    }
}

/// What this worker can do here. Computer Use is advertised by OS; whether the screen can be
/// used is told by `ui_state` and by each action's own answer. A Linux worker with no X display
/// (a server, a container) has no screen to offer, and says so up front.
pub fn capabilities() -> Vec<String> {
    let computer = if cfg!(target_os = "macos") {
        Some(CAP_COMPUTER_MACOS)
    } else if cfg!(windows) {
        Some(CAP_COMPUTER_WINDOWS)
    } else {
        std::env::var_os("DISPLAY")
            .filter(|display| !display.is_empty())
            .map(|_| CAP_COMPUTER_LINUX)
    };
    [CAP_SHELL, CAP_FILES, CAP_FORWARDS, CAP_UPDATE]
        .into_iter()
        .chain(computer)
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_each_system_as_a_person_reads_it() {
        assert_eq!(macos_system("15.4.1\n").as_deref(), Some("macOS 15.4.1"));
        assert_eq!(macos_system(""), None);
        assert_eq!(windows_system("10.0.26100"), "Windows 11 (26100)");
        assert_eq!(windows_system("10.0.19045"), "Windows 10 (19045)");
        assert_eq!(
            linux_system(
                Some("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"),
                "6.8"
            ),
            "Ubuntu 24.04.1 LTS"
        );
        assert_eq!(
            linux_system(Some("NAME=Arch\nVERSION_ID=1\n"), "6.8"),
            "Arch 1"
        );
        assert_eq!(linux_system(None, "6.8.0\n"), "Linux 6.8.0");
        assert_eq!(printable("a\u{7f}b\n  c"), "a b c");
    }
}
