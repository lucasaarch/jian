//! The shape every file operation must have, checked again on the machine: the gateway's word is
//! not proof, and a value that slipped past it could be read by git or ripgrep as an option.

use jian_protocol::machine::{FILES_MAX_GIT_BYTES, FILES_MAX_READ_BYTES, FILES_MAX_TEXT, FilesOp};

const PATH_MAX: usize = 4096;

fn text(value: &str, max: usize) -> bool {
    value.chars().count() <= max && !value.contains('\0')
}

/// Absolute, as `/…` or `C:\…`.
fn path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    text(value, PATH_MAX) && (value.starts_with('/') || drive)
}

fn pattern(value: &str, max: usize) -> bool {
    !value.is_empty() && text(value, max)
}

/// Not empty, not an option, no control characters, no padding.
fn plain(value: &str, max: usize) -> bool {
    text(value, max)
        && !value.is_empty()
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
        && value == value.trim()
}

fn sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Relative to the repository and never leaving it.
fn repo_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let rooted = value.starts_with(['/', '\\'])
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    text(value, PATH_MAX)
        && !value.is_empty()
        && !value.starts_with('-')
        && !rooted
        && !value.split(['/', '\\']).any(|part| part == "..")
}

fn base64(value: &str) -> bool {
    let body = value.trim_end_matches('=');
    value.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn within(value: usize, min: usize, max: usize) -> bool {
    (min..=max).contains(&value)
}

pub fn is_valid(op: &FilesOp) -> bool {
    match op {
        FilesOp::Read { path: p, max_bytes } | FilesOp::ReadBytes { path: p, max_bytes } => {
            path(p) && (1..=FILES_MAX_READ_BYTES).contains(max_bytes)
        }
        FilesOp::Write {
            path: p,
            content,
            expected_mtime_ms,
        } => {
            // Any characters: unlike a path, a file's text may hold NUL.
            path(p)
                && content.chars().count() <= FILES_MAX_TEXT
                && expected_mtime_ms.is_none_or(f64::is_finite)
        }
        FilesOp::List { path: p, limit } => path(p) && within(*limit, 1, 300),
        FilesOp::Find {
            path: p,
            pattern: glob,
            limit,
        } => path(p) && pattern(glob, 500) && within(*limit, 1, 1000),
        FilesOp::Search {
            path: p,
            pattern: expression,
            glob,
            context_lines,
            limit,
            ..
        } => {
            path(p)
                && pattern(expression, 2000)
                && glob.as_deref().is_none_or(|glob| plain(glob, 200))
                && within(*context_lines, 0, 10)
                && within(*limit, 1, 2000)
        }
        FilesOp::WriteBytes {
            path: p,
            base64: data,
        } => path(p) && text(data, FILES_MAX_TEXT) && base64(data),
        FilesOp::GitStatus { root, against } => path(root) && against.as_deref().is_none_or(sha),
        FilesOp::GitFile {
            root,
            path: inner,
            against,
            max_bytes,
        } => {
            path(root)
                && repo_path(inner)
                && (against == "HEAD" || sha(against))
                && (1..=FILES_MAX_GIT_BYTES).contains(max_bytes)
        }
        FilesOp::MergeBase { root, base } => path(root) && plain(base, 256),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jian_protocol::machine::SearchOutput;

    fn search(glob: Option<&str>, context: usize) -> FilesOp {
        FilesOp::Search {
            path: "/srv/app".into(),
            pattern: "fn main".into(),
            glob: glob.map(String::from),
            ignore_case: false,
            context_lines: context,
            output: SearchOutput::Content,
            limit: 100,
        }
    }

    #[test]
    fn refuses_what_could_be_read_as_an_option_or_leave_a_repository() {
        let git_file = |path: &str, against: &str| FilesOp::GitFile {
            root: "/srv/app".into(),
            path: path.into(),
            against: against.into(),
            max_bytes: 1000,
        };
        assert!(is_valid(&git_file("src/main.rs", "HEAD")));
        assert!(!is_valid(&git_file("../etc/passwd", "HEAD")));
        assert!(!is_valid(&git_file("/etc/passwd", "HEAD")));
        assert!(!is_valid(&git_file("--output=x", "HEAD")));
        assert!(!is_valid(&git_file("src/main.rs", "main")));
        let merge = |base: &str| FilesOp::MergeBase {
            root: "/srv/app".into(),
            base: base.into(),
        };
        assert!(is_valid(&merge("main")));
        assert!(!is_valid(&merge("--all")));
        assert!(!is_valid(&merge(" main")));
        assert!(is_valid(&search(Some("*.rs"), 3)));
        assert!(!is_valid(&search(Some("-x"), 3)));
        assert!(!is_valid(&search(None, 11)));
    }

    #[test]
    fn paths_must_be_absolute() {
        let read = |path: &str| FilesOp::Read {
            path: path.into(),
            max_bytes: 10,
        };
        assert!(is_valid(&read("/etc/hosts")));
        assert!(is_valid(&read("C:\\Users\\ana\\a.txt")));
        assert!(!is_valid(&read("etc/hosts")));
        assert!(!is_valid(&read("/etc/\0hosts")));
    }
}
