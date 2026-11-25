//! `launchd`, and the thin `Jian Remote.app` the `LaunchAgent` runs. macOS gives Login Items and the
//! privacy permissions (Accessibility, Screen Recording) to an app bundle: run as a bare binary,
//! the worker would show up under a meaningless name, if at all. The worker is one static
//! binary, so the bundle is that binary and an Info.plist; nothing else needs copying or
//! relinking.
//!
//! The bundle is signed ad hoc. An ad-hoc signature changes with the binary, so after an update
//! macOS may ask for the permissions again.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths::{
    self, LAUNCH_AGENT_THROTTLE_SECONDS, MACOS_APP_NAME, MACOS_BUNDLE_ID, MACOS_LAUNCH_AGENT_LABEL,
};

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn info_plist(version: &str) -> String {
    let version = xml(version);
    // LSUIElement: the Computer Use pointer is drawn by this binary through AppKit, and an agent
    // app does that without a Dock icon or a menu bar of its own.
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>{MACOS_APP_NAME}</string>
<key>CFBundleExecutable</key><string>{MACOS_APP_NAME}</string>
<key>CFBundleIdentifier</key><string>{MACOS_BUNDLE_ID}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>{MACOS_APP_NAME}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
<key>CFBundleVersion</key><string>{version}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
"#
    )
}

/// ProcessType=Interactive keeps App Nap away: it would freeze the worker while the screen is
/// locked or idle and the gateway would see it go silent. PATH, HOME and TMPDIR are explicit
/// because launchd hands a sparse environment, and a wrong HOME puts the config and every shell
/// in the wrong place. `ThrottleInterval` keeps `KeepAlive` from fighting a restart after an update.
pub fn launch_agent_plist(executable: &Path, log: &Path, home: &Path, tmp: &str) -> String {
    let executable = xml(&executable.to_string_lossy());
    let log = xml(&log.to_string_lossy());
    let home = xml(&home.to_string_lossy());
    let path = xml(jian_remote::shell::MINIMAL_PATH);
    let tmp = xml(tmp);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{MACOS_LAUNCH_AGENT_LABEL}</string>
<key>AssociatedBundleIdentifiers</key>
<array><string>{MACOS_BUNDLE_ID}</string></array>
<key>ProgramArguments</key>
<array>
<string>{executable}</string>
<string>run</string>
</array>
<key>WorkingDirectory</key><string>{home}</string>
<key>EnvironmentVariables</key>
<dict>
<key>PATH</key><string>{path}</string>
<key>HOME</key><string>{home}</string>
<key>TMPDIR</key><string>{tmp}</string>
</dict>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>{LAUNCH_AGENT_THROTTLE_SECONDS}</integer>
<key>StandardOutPath</key><string>{log}</string>
<key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
"#
    )
}

fn plist_path() -> PathBuf {
    paths::home()
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{MACOS_LAUNCH_AGENT_LABEL}.plist"))
}

/// The logged-in user's `launchd` domain, where a `LaunchAgent` lives.
fn domain() -> String {
    format!("gui/{}", rustix::process::getuid().as_raw())
}

fn quiet(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Clears quarantine and signs the bundle ad hoc: an unsigned or quarantined app gets no
/// privacy permissions, and Gatekeeper may refuse to start it from launchd.
pub fn sign(app: &Path, executable: &Path) {
    let app = app.to_string_lossy();
    quiet("/usr/bin/xattr", &["-cr", &app]);
    for target in [executable.to_string_lossy().as_ref(), app.as_ref()] {
        quiet(
            "/usr/bin/codesign",
            &[
                "--force",
                "-s",
                "-",
                "--identifier",
                MACOS_BUNDLE_ID,
                target,
            ],
        );
    }
}

/// Writes the bundle's Info.plist; the executable itself is put there by the install.
pub fn write_bundle(app: &Path, version: &str) -> Result<(), String> {
    let contents = app.join("Contents");
    std::fs::create_dir_all(contents.join("MacOS")).map_err(|error| error.to_string())?;
    std::fs::write(contents.join("Info.plist"), info_plist(version))
        .map_err(|error| error.to_string())
}

pub fn stop() {
    let plist = plist_path().to_string_lossy().into_owned();
    quiet("launchctl", &["bootout", &domain(), &plist]);
    quiet(
        "launchctl",
        &[
            "bootout",
            &format!("{}/{MACOS_LAUNCH_AGENT_LABEL}", domain()),
        ],
    );
}

pub fn start(executable: &Path) -> Result<(String, String), String> {
    let plist = plist_path();
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    let body = launch_agent_plist(executable, &paths::log_path(), &paths::home(), &tmp);
    jian_remote::state::write_private(&plist, &body).map_err(|error| error.to_string())?;
    let plist = plist.to_string_lossy().into_owned();
    // Out again after writing, so KeepAlive cannot bring back the old definition.
    quiet("launchctl", &["bootout", &domain(), &plist]);
    std::thread::sleep(std::time::Duration::from_millis(400));
    let loaded = Command::new("launchctl")
        .args(["bootstrap", &domain(), &plist])
        .status()
        .is_ok_and(|status| status.success());
    if !loaded {
        return Err("Could not start Jian Remote with launchd.".into());
    }
    let app = paths::macos_app_root();
    Ok((
        "LaunchAgent".into(),
        format!(
            "Login Items identity: {MACOS_APP_NAME}.app ({})",
            app.display()
        ),
    ))
}

pub fn uninstall() -> Vec<String> {
    stop();
    let mut removed = Vec::new();
    let plist = plist_path();
    if std::fs::remove_file(&plist).is_ok() {
        removed.push(plist.to_string_lossy().into_owned());
    }
    let app = paths::macos_app_root();
    if let Some(folder) = app.parent()
        && std::fs::remove_dir_all(folder).is_ok()
    {
        removed.push(folder.to_string_lossy().into_owned());
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_runs_the_app_with_a_full_environment() {
        let body = launch_agent_plist(
            Path::new(
                "/Users/a/Library/Application Support/Jian Remote/Jian Remote.app/Contents/MacOS/Jian Remote",
            ),
            Path::new("/Users/a/.config/jian-remote/worker.log"),
            Path::new("/Users/a&b"),
            "/var/folders/x/T/",
        );
        assert!(body.contains("<string>/Users/a/Library/Application Support/Jian Remote/Jian Remote.app/Contents/MacOS/Jian Remote</string>\n<string>run</string>"));
        assert!(body.contains("<key>HOME</key><string>/Users/a&amp;b</string>"));
        assert!(body.contains("<key>ProcessType</key><string>Interactive</string>"));
        assert!(body.contains("<key>ThrottleInterval</key><integer>10</integer>"));
        let info = info_plist("1.2.3");
        assert!(info.contains("<key>CFBundleIdentifier</key><string>com.jian.remote</string>"));
        assert!(info.contains("<key>CFBundleExecutable</key><string>Jian Remote</string>"));
    }
}
