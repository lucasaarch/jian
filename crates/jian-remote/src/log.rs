//! The worker's log: one line per event, so `logs` can cut, filter and follow it without parsing.

use std::fmt::Write as _;
use std::io::{IsTerminal, Write as _};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::clock::now_iso;

/// A log past this size, in bytes, moves aside to `worker.log.1`, so a busy worker never fills
/// the disk.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    pub const ALL: [Level; 4] = [Level::Debug, Level::Info, Level::Warn, Level::Error];

    pub fn name(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|level| level.name() == name)
    }

    /// The level of a log line, or `None` for a line this format did not write (a crash the
    /// service manager caught).
    pub fn of_line(line: &str) -> Option<Self> {
        let word = line.split(' ').nth(1)?;
        Self::ALL
            .into_iter()
            .find(|level| level.name().eq_ignore_ascii_case(word))
    }
}

/// A value bare when it can be, quoted when it holds spaces, quotes or `=`.
fn value(text: &str) -> String {
    let bare = !text.is_empty()
        && !text
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '=');
    if bare {
        text.to_owned()
    } else {
        serde_json::to_string(text).unwrap_or_default()
    }
}

pub fn format_line(level: Level, message: &str, fields: &[(&str, &str)], at: &str) -> String {
    let mut line = format!("{at} {:<5} {message}", level.name().to_ascii_uppercase());
    for (key, field) in fields.iter().filter(|(_, field)| !field.is_empty()) {
        let _ = write!(line, " {key}={}", value(field));
    }
    line.push('\n');
    line
}

/// Writes to `path` whoever runs the worker; in a terminal (`run` by hand) the lines show there
/// too, while a service reads the file. Cloned freely: every clone writes to the same file.
#[derive(Clone)]
pub struct Logger {
    path: Option<PathBuf>,
    echo: bool,
    lock: Arc<Mutex<()>>,
}

impl Logger {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            echo: std::io::stdout().is_terminal(),
            lock: Arc::default(),
        }
    }

    /// Writes nowhere: for tests and for a worker embedded elsewhere.
    pub fn silent() -> Self {
        Self {
            path: None,
            echo: false,
            lock: Arc::default(),
        }
    }

    pub fn write(&self, level: Level, message: &str, fields: &[(&str, &str)]) {
        let line = format_line(level, message, fields, &now_iso());
        let _guard = self.lock.lock();
        if let Some(path) = &self.path {
            // A log that cannot be written must never stop the worker.
            if std::fs::metadata(path).is_ok_and(|meta| meta.len() > LOG_MAX_BYTES) {
                let _ = std::fs::rename(path, path.with_extension("log.1"));
            }
            let _ = append(path, &line);
        }
        if self.echo {
            if level >= Level::Warn {
                let _ = std::io::stderr().write_all(line.as_bytes());
            } else {
                let _ = std::io::stdout().write_all(line.as_bytes());
            }
        }
    }

    pub fn debug(&self, message: &str, fields: &[(&str, &str)]) {
        self.write(Level::Debug, message, fields);
    }
    pub fn info(&self, message: &str, fields: &[(&str, &str)]) {
        self.write(Level::Info, message, fields);
    }
    pub fn warn(&self, message: &str, fields: &[(&str, &str)]) {
        self.write(Level::Warn, message, fields);
    }
    pub fn error(&self, message: &str, fields: &[(&str, &str)]) {
        self.write(Level::Error, message, fields);
    }
}

fn append(path: &std::path::Path, line: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_reads_back_with_its_level() {
        let line = format_line(
            Level::Warn,
            "lost the gateway",
            &[
                ("error", "connection reset"),
                ("empty", ""),
                ("code", "4001"),
            ],
            "2026-01-01T00:00:00.000Z",
        );
        assert_eq!(
            line,
            "2026-01-01T00:00:00.000Z WARN  lost the gateway error=\"connection reset\" code=4001\n"
        );
        assert_eq!(Level::of_line(&line), Some(Level::Warn));
        assert_eq!(Level::of_line("panicked at main.rs"), None);
    }
}
