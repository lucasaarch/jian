//! Where a path really leads, and the folders no file operation may touch.

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use jian_protocol::machine::FilesProblem;

use super::Problem;
use crate::shell::home_dir;

/// Message for a refused path; it names no folder, so it does not map the machine's secrets.
pub const REFUSED_MESSAGE: &str =
    "That path holds this worker’s own credentials and is not available.";

/// Where the CLI worker keeps its token and config, and where the desktop app keeps its own data
/// (the sealed worker tokens). Always refused, whichever host runs: a machine with both
/// installed must not let one read the other's token.
pub fn known_refused() -> Vec<PathBuf> {
    let home = home_dir();
    let app_data = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from)
    };
    vec![
        home.join(".config").join("jian-remote"),
        app_data.join("Jian"),
        app_data.join("Jian Dev"),
    ]
}

/// Windows and macOS compare names without case; a refusal must not be dodged by a spelling.
fn fold(path: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

/// Whether `path` is `folder` or lies in it, compared the way the file system compares.
pub fn inside(path: &str, folder: &str) -> bool {
    let (path, folder) = (fold(path), fold(folder));
    let sep = std::path::MAIN_SEPARATOR;
    path == folder
        || path.starts_with(&if folder.ends_with(sep) {
            folder.clone()
        } else {
            format!("{folder}{sep}")
        })
}

/// `canonicalize` on Windows answers `\\?\C:\…`; the rest of the worker, and the agent, speak
/// `C:\…`.
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    if let Some(plain) = real.to_str().and_then(|text| text.strip_prefix(r"\\?\"))
        && !plain.starts_with("UNC\\")
    {
        return Ok(PathBuf::from(plain));
    }
    Ok(real)
}

/// The real location of a path that may not exist yet. An existing path is resolved by the
/// system, so `..` after a link means the link target's parent, as for the program that opens
/// it. A missing one is the real path of its nearest existing ancestor with the missing names put
/// back; a `.` or `..` in the missing part has no meaning to resolve and is refused. A dangling
/// link counts as missing, since writing replaces the link, not its target.
pub fn real_location(path: &Path) -> Result<PathBuf, Problem> {
    let mut tail = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        match canonical(&current) {
            Ok(real) => {
                return Ok(tail.iter().rev().fold(real, |real, name| real.join(name)));
            }
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {}
            Err(error) => return Err(error.into()),
        }
        match current.components().next_back() {
            Some(Component::Normal(name)) => tail.push(name.to_owned()),
            Some(Component::CurDir | Component::ParentDir) => {
                return Err(Problem::new(
                    FilesProblem::Missing,
                    "A path through a missing folder cannot use . or ..",
                ));
            }
            _ => {
                return Ok(tail
                    .iter()
                    .rev()
                    .fold(current, |real, name| real.join(name)));
            }
        }
        if !current.pop() {
            return Ok(tail
                .iter()
                .rev()
                .fold(current, |real, name| real.join(name)));
        }
    }
}

/// The refused folders, both as given and as their real locations.
pub fn refused_roots(folders: &[PathBuf]) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for folder in folders {
        let real = real_location(folder).ok();
        for root in [Some(folder.clone()), real].into_iter().flatten() {
            let root = root.to_string_lossy().into_owned();
            if !root.is_empty() && !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

pub fn is_refused(real: &Path, roots: &[String]) -> bool {
    let real = real.to_string_lossy();
    roots.iter().any(|root| inside(&real, root))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_missing_tail_is_put_back_and_dots_in_it_are_refused() {
        let base = canonical(&std::env::temp_dir()).unwrap();
        let missing = base.join("jian-remote-no-such").join("file.txt");
        assert_eq!(real_location(&missing).unwrap(), missing);
        let dotted = base.join("jian-remote-no-such").join("..").join("x");
        assert!(real_location(&dotted).is_err());
    }

    #[test]
    fn inside_matches_whole_names_only() {
        assert!(inside(
            "/home/a/.config/jian-remote/config.json",
            "/home/a/.config/jian-remote"
        ));
        assert!(inside(
            "/home/a/.config/jian-remote",
            "/home/a/.config/jian-remote"
        ));
        assert!(!inside(
            "/home/a/.config/jian-remote-other",
            "/home/a/.config/jian-remote"
        ));
    }
}
