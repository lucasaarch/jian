//! What only a Mac needs: power assertions, the screen's lock state, and the hints that tell the
//! agent about a locked screen and missing privacy permissions. Elsewhere every call is a no-op
//! and the state is `unknown`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use jian_protocol::machine::{ComputerAction, Permission, UiState};

use super::helper::HelperCommand;
use super::outcome::ActionError;

/// How long a probe answers for: the gateway is told on change, checked every few seconds.
const UI_STATE_CACHE: Duration = Duration::from_secs(5);
const MAC: bool = cfg!(target_os = "macos");
const SETTINGS: &str = "System Settings → Privacy & Security";
const LOCKED_SCREENSHOT_NOTE: &str = "Note: Mac session reports locked — image may be the lock screen (or black if the display stayed asleep). Desktop apps behind loginwindow are often not visible.";
const LOCKED_ACTION_HINT: &str = " Mac session reports locked; if this failed, unlock or keep the display awake (post-login lock ≠ FileVault loginwindow).";

static CACHE: Mutex<Option<(Instant, UiState)>> = Mutex::new(None);

/// A caffeinate process that keeps an assertion for the process named by `-w`; macOS drops the
/// assertion by itself when that process dies, even if this one never gets to.
pub fn caffeinate(flags: &str, pid: u32) -> Option<std::process::Child> {
    if !MAC {
        return None;
    }
    std::process::Command::new("/usr/bin/caffeinate")
        .args([flags, "-w", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
}

/// Keeps the system from idle sleep while the worker runs, so it stays connected with the
/// screen locked. A closed lid still sleeps the machine.
pub fn hold_worker_awake() -> Option<std::process::Child> {
    caffeinate("-i", std::process::id())
}

/// A moment of declared user activity: wakes a sleeping display. Blocks for about 3 s.
fn wake_display() {
    if MAC {
        let _ = std::process::Command::new("/usr/bin/caffeinate")
            .args(["-u", "-t", "3"])
            .status();
    }
}

fn read_ui_state(helper: &HelperCommand) -> UiState {
    let mut command = std::process::Command::new(&helper.program);
    command.args(&helper.args).arg("--session-status");
    let Ok(output) = command.output() else {
        return UiState::Unknown;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(last) = text.trim().lines().last() else {
        return UiState::Unknown;
    };
    let Ok(reply) = serde_json::from_str::<serde_json::Value>(last) else {
        return UiState::Unknown;
    };
    if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return UiState::Unknown;
    }
    reply
        .get("state")
        .cloned()
        .and_then(|state| serde_json::from_value(state).ok())
        .unwrap_or(UiState::Unknown)
}

/// Unlocked, locked or display asleep, as the helper reads it; anything it cannot tell is
/// `unknown`, never a guess. Blocking: a short child process.
pub fn ui_state(helper: Option<&HelperCommand>, force: bool) -> UiState {
    let Some(helper) = helper.filter(|_| MAC) else {
        return UiState::Unknown;
    };
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, state)) = *cache
        && !force
        && at.elapsed() < UI_STATE_CACHE
    {
        return state;
    }
    let state = read_ui_state(helper);
    *cache = Some((Instant::now(), state));
    state
}

/// What a Mac learns just before an action: a locked or sleeping display is woken, and the
/// outcome is worded with what that means.
#[derive(Debug, Default, Clone)]
pub struct Preparation {
    /// The screen was locked when the action was prepared, even after the wake.
    pub locked: bool,
}

/// Wakes a locked or sleeping display before an action; does nothing off a Mac.
pub fn prepare(helper: Option<&HelperCommand>) -> Preparation {
    if !MAC {
        return Preparation::default();
    }
    let mut state = ui_state(helper, true);
    if state != UiState::Unlocked {
        wake_display();
        state = ui_state(helper, true);
    }
    Preparation {
        locked: state == UiState::Locked,
    }
}

impl Preparation {
    /// The sentence to add to a screenshot taken while the screen is locked, or nothing.
    pub fn note(&self) -> &'static str {
        if self.locked {
            LOCKED_SCREENSHOT_NOTE
        } else {
            ""
        }
    }

    /// Screenshots need Screen Recording; input needs Accessibility. The helper names the one
    /// missing; a failure it could not name is read from its wording.
    pub fn explain(&self, error: &mut ActionError, action: ComputerAction) {
        if !MAC {
            return;
        }
        let lower = error.message.to_lowercase();
        let worded = ["accessib", "not permitted", "not authorized"]
            .iter()
            .any(|word| lower.contains(word));
        let hint = match error.permission {
            Some(Permission::ScreenRecording) => {
                format!(" Allow Jian Remote under {SETTINGS} → Screen Recording, then try again.")
            }
            Some(Permission::Accessibility) => {
                format!(" Allow Jian Remote under {SETTINGS} → Accessibility, then try again.")
            }
            _ if action == ComputerAction::Screenshot && (worded || lower.contains("screen recording")) => {
                " Jian Remote needs Screen Recording (and Accessibility for input) in System Settings.".into()
            }
            _ if action != ComputerAction::Screenshot && worded => {
                " Jian Remote needs Accessibility (and Screen Recording for screenshots) in System Settings.".into()
            }
            _ => String::new(),
        };
        let locked = if self.locked { LOCKED_ACTION_HINT } else { "" };
        format!("{}{hint}{locked}", error.message)
            .trim()
            .clone_into(&mut error.message);
    }
}
