//! The flags that say which browser programs the gateway may use for the agent's pages.
//!
//! Obscura is the default and Chromium the fallback for a site Obscura cannot run. A path given
//! here wins; without one the program is looked for on `PATH`. A gateway with neither has no
//! browser: the runs get no `browser_*` tool and PDF and PNG downloads answer 501.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use jian_browser::{
    Browser, CdpBrowser, Engine, EngineConfig, NetworkPolicy, Sessions, WithFallback, discover,
};

/// How long a run's page stays open unused: past it the page is closed, and with it the program
/// can stop.
const PAGE_IDLE: Duration = Duration::from_mins(10);

/// Where the browser programs are.
#[derive(Args, Default)]
pub struct BrowserFlags {
    /// The Obscura program (the default browser). Without it, `obscura` on `PATH`.
    #[arg(long, env = "JIAN_OBSCURA_PATH", value_name = "PATH")]
    obscura_path: Option<PathBuf>,

    /// The Chromium or Chrome program (the fallback). Without it, `chromium` or `google-chrome`
    /// on `PATH`.
    #[arg(long, env = "JIAN_CHROMIUM_PATH", value_name = "PATH")]
    chromium_path: Option<PathBuf>,
}

/// The browser of this gateway, and the programs behind it.
pub struct Browsers {
    /// What pages and artifacts are opened with.
    pub browser: Arc<dyn Browser>,
    programs: Vec<CdpBrowser>,
}

impl Browsers {
    /// The pages the runs hold.
    pub fn sessions(&self) -> Arc<Sessions> {
        Arc::new(Sessions::new(Arc::clone(&self.browser), PAGE_IDLE))
    }

    /// Stops the programs now: the gateway is going down.
    pub async fn shutdown(&self) {
        for program in &self.programs {
            program.shutdown().await;
        }
    }
}

const CHROMIUM_NAMES: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
];

impl BrowserFlags {
    /// The browser, or `None` when no program is there. `path` is where a program is looked for
    /// when no flag names it.
    pub fn find(&self, path: &OsStr, policy: NetworkPolicy) -> Option<Browsers> {
        let make = |engine: Engine, flag: &Option<PathBuf>, names: &[&str]| {
            let binary = match flag {
                Some(binary) if binary.is_file() => Some(binary.clone()),
                Some(binary) => {
                    tracing::warn!(path = %binary.display(), "the browser program named is not a file");
                    None
                }
                None => discover(names, path),
            }?;
            tracing::info!(engine = engine.name(), path = %binary.display(), "browser found");
            Some(CdpBrowser::new(EngineConfig::new(engine, binary, policy)))
        };
        let obscura = make(Engine::Obscura, &self.obscura_path, &["obscura"]);
        let chromium = make(Engine::Chromium, &self.chromium_path, CHROMIUM_NAMES);
        let programs: Vec<CdpBrowser> = obscura.iter().chain(&chromium).cloned().collect();
        let (primary, second) = match (obscura, chromium) {
            (Some(o), c) => (o, c),
            (None, Some(c)) => (c, None),
            (None, None) => return None,
        };
        let second = second.map(|c| Arc::new(c) as Arc<dyn Browser>);
        Some(Browsers {
            browser: Arc::new(WithFallback::new(Arc::new(primary), second)),
            programs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        browser: BrowserFlags,
    }

    #[test]
    fn with_no_program_there_is_no_browser() {
        let cli = Cli::parse_from(["jian"]);
        let empty = tempfile::tempdir().unwrap();
        assert!(
            cli.browser
                .find(empty.path().as_os_str(), NetworkPolicy::AnyNetwork)
                .is_none()
        );
    }

    #[test]
    fn a_path_that_is_not_a_file_is_no_browser() {
        let cli = Cli::parse_from(["jian", "--obscura-path", "/nowhere/obscura"]);
        let empty = tempfile::tempdir().unwrap();
        assert!(
            cli.browser
                .find(empty.path().as_os_str(), NetworkPolicy::AnyNetwork)
                .is_none()
        );
    }

    #[test]
    fn a_program_on_the_path_is_found_and_the_flag_wins() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join("obscura");
        std::fs::write(&named, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let cli = Cli::parse_from(["jian"]);
        let found = cli
            .browser
            .find(dir.path().as_os_str(), NetworkPolicy::AnyNetwork)
            .unwrap();
        assert_eq!(found.browser.engine(), "obscura");
        let cli = Cli::parse_from(["jian", "--chromium-path", named.to_str().unwrap()]);
        let found = cli
            .browser
            .find(OsStr::new(""), NetworkPolicy::AnyNetwork)
            .unwrap();
        assert_eq!(found.browser.engine(), "chromium");
    }
}
