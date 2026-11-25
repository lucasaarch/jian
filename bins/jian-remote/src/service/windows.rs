//! Task Scheduler: a task at logon, in the user's interactive session, since Computer Use needs
//! the user's desktop and a Windows service has none.

use anyhow::bail;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::paths::WINDOWS_TASK_NAME;

fn schtasks(args: &[&str]) -> bool {
    Command::new("schtasks.exe")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub fn stop() {
    schtasks(&["/End", "/TN", WINDOWS_TASK_NAME]);
}

pub fn start(binary: &Path) -> anyhow::Result<(String, String)> {
    let action = format!("\"{}\" run", binary.display());
    let created = schtasks(&[
        "/Create",
        "/SC",
        "ONLOGON",
        "/TN",
        WINDOWS_TASK_NAME,
        "/TR",
        &action,
        "/F",
        "/RL",
        "LIMITED",
        "/IT",
    ]);
    if !created {
        bail!("Could not install the Jian Remote logon task with Task Scheduler.");
    }
    if !schtasks(&["/Run", "/TN", WINDOWS_TASK_NAME]) {
        bail!("Could not start the Jian Remote scheduled task.");
    }
    Ok((
        "Task Scheduler".into(),
        format!("{WINDOWS_TASK_NAME} (ONLOGON)"),
    ))
}

pub fn uninstall() -> Vec<String> {
    stop();
    if schtasks(&["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]) {
        vec![format!("Scheduled task {WINDOWS_TASK_NAME}")]
    } else {
        Vec::new()
    }
}
