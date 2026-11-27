//! Finding a browser program on the machine.

use std::ffi::OsStr;
use std::path::PathBuf;

/// The first of `names` that is an executable file in a folder of `path` (the value of `PATH`,
/// which the caller reads: a library does not read the environment). `None` means this gateway
/// has no such browser, and the agent is not told it has one.
#[must_use]
pub fn discover(names: &[&str], path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .flat_map(|dir| {
            names.iter().flat_map(move |name| {
                // Windows programs end in `.exe`; asking for both costs nothing elsewhere.
                [dir.join(name), dir.join(format!("{name}.exe"))]
            })
        })
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_name_in_the_first_folder_that_has_one() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "second.exe"
        } else {
            "second"
        };
        let file = b.path().join(name);
        std::fs::write(&file, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(discover(&["first", "second"], &path), Some(file));
        assert_eq!(discover(&["missing"], &path), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_run_is_not_a_browser() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("chromium"), "x").unwrap();
        let path = std::env::join_paths([a.path()]).unwrap();
        assert_eq!(discover(&["chromium"], &path), None);
    }
}
