//! Listing a folder and finding files by glob. Blocking: run off the async threads.

use std::path::{MAIN_SEPARATOR, Path};
use std::time::{Instant, SystemTime};

use globset::GlobBuilder;
use jian_protocol::machine::{EntryKind, FILES_MAX_FIND_CHARS, FilesDone, FilesProblem, ListEntry};

use super::Problem;
use super::paths::{is_refused, real_location};

/// Never what someone searching a codebase means, and large enough to drown the answer.
pub const SKIPPED: [&str; 2] = [".git", "node_modules"];

/// Kernel folders of a Unix machine: endless or slow to walk, and never files anyone looks for.
pub const SYSTEM_FOLDERS: &[&str] = if cfg!(windows) {
    &[]
} else {
    &["/proc", "/sys", "/dev"]
};

/// How answers show paths: as the agent gave them when that is a plain absolute path, else the
/// real ones. The work itself runs on the real path, which is what the checks saw.
pub struct Shower {
    real: String,
    shown: String,
}

impl Shower {
    pub fn new(given: &str, real: &Path) -> Self {
        let real = real.to_string_lossy().into_owned();
        let plain = !given
            .split(['/', '\\'])
            .any(|part| part == "." || part == "..");
        let trimmed = given.trim_end_matches(['/', '\\']);
        let shown = if plain {
            if trimmed.is_empty() { given } else { trimmed }.to_owned()
        } else {
            real.clone()
        };
        Self { real, shown }
    }

    pub fn show(&self, path: &str) -> String {
        if self.shown == self.real {
            return path.to_owned();
        }
        let under = path == self.real
            || path.starts_with(&format!(
                "{}{MAIN_SEPARATOR}",
                self.real.trim_end_matches(MAIN_SEPARATOR)
            ));
        if under {
            format!("{}{}", self.shown, &path[self.real.len()..])
        } else {
            path.to_owned()
        }
    }
}

fn folder(real: &Path) -> Result<(), Problem> {
    if std::fs::metadata(real)?.is_dir() {
        Ok(())
    } else {
        Err(Problem::new(
            FilesProblem::NotDirectory,
            "That path is not a folder.",
        ))
    }
}

pub fn list(real: &Path, limit: usize) -> Result<FilesDone, Problem> {
    folder(real)?;
    let mut entries: Vec<ListEntry> = std::fs::read_dir(real)?
        .filter_map(Result::ok)
        .map(|entry| {
            let kind = match entry.file_type() {
                Ok(kind) if kind.is_dir() => EntryKind::Directory,
                Ok(kind) if kind.is_file() => EntryKind::File,
                Ok(kind) if kind.is_symlink() => EntryKind::Symlink,
                _ => EntryKind::Other,
            };
            ListEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                kind,
            }
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(FilesDone::List { entries, truncated })
}

fn is_system(path: &Path) -> bool {
    SYSTEM_FOLDERS.iter().any(|root| path.starts_with(root))
}

/// The path from the walk's root, with `/` between names, as globs are written.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|inner| {
            inner
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// Files matching a glob under `real`, newest first. The walk stops at `deadline` or once it has
/// ten times what was asked, and answers with what it found, marked truncated. Links to folders
/// are not followed; a link to a file is listed only when it does not lead to a refused folder.
pub fn find(
    real: &Path,
    pattern: &str,
    limit: usize,
    roots: &[String],
    shower: &Shower,
    deadline: Instant,
) -> Result<FilesDone, Problem> {
    folder(real)?;
    let matcher = GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|error| {
            Problem::new(
                FilesProblem::Failed,
                format!("That pattern is not valid: {error}"),
            )
        })?
        .compile_matcher();
    let mut found: Vec<(String, SystemTime)> = Vec::new();
    let mut timed_out = false;
    let mut stack = vec![real.to_path_buf()];
    'walk: while let Some(directory) = stack.pop() {
        let Ok(listing) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in listing.filter_map(Result::ok) {
            if Instant::now() >= deadline {
                timed_out = true;
                break 'walk;
            }
            let name = entry.file_name();
            if SKIPPED.iter().any(|skip| name == *skip) {
                continue;
            }
            let path = entry.path();
            if is_system(&path) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !is_refused(&path, roots) {
                    stack.push(path);
                }
                continue;
            }
            if !matcher.is_match(relative(real, &path)) {
                continue;
            }
            // A link in the tree may lead to the credentials; it is left out rather than listed.
            if real_location(&path).is_ok_and(|to| is_refused(&to, roots)) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_file() {
                let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                found.push((path.to_string_lossy().into_owned(), modified));
                if found.len() >= limit * 10 {
                    break 'walk;
                }
            }
        }
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut files = Vec::new();
    let mut chars = 0;
    for (path, _) in found.iter().take(limit) {
        let shown = shower.show(path);
        let length = shown.chars().count();
        if chars + length > FILES_MAX_FIND_CHARS {
            break;
        }
        chars += length;
        files.push(shown);
    }
    let truncated = timed_out || found.len() > files.len();
    Ok(FilesDone::Find { files, truncated })
}
