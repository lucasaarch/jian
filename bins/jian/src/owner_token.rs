//! Where the owner's token comes from.
//!
//! `JIAN_API_TOKEN` when it is set (at least 32 characters, which the store enforces); otherwise
//! `owner.token` in the data directory, made on the first start with a token the gateway
//! generated and kept after. The token is never logged: only where it is.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use jian_store::{TokenKind, generate_token};

/// The file in the data directory that holds the generated owner token.
pub const OWNER_TOKEN_FILE: &str = "owner.token";

/// Where the token was found, for the start-up message.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    /// The `JIAN_API_TOKEN` variable or its flag.
    Variable,
    /// The file, which the gateway wrote now.
    NewFile(PathBuf),
    /// The file, written by an earlier start.
    File(PathBuf),
}

/// The owner's token and where it came from. An empty `given` counts as not given, as an empty
/// variable in a shell does.
pub fn resolve(given: Option<&str>, data_dir: &Path) -> anyhow::Result<(String, Source)> {
    if let Some(token) = given.map(str::trim).filter(|token| !token.is_empty()) {
        return Ok((token.to_owned(), Source::Variable));
    }
    let path = data_dir.join(OWNER_TOKEN_FILE);
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("cannot create {}", data_dir.display()))?;
    match create_private(&path) {
        Ok(mut file) => {
            let token = generate_token(TokenKind::Owner).context("cannot generate a token")?;
            let written = writeln!(file, "{}", token.expose()).and_then(|()| file.flush());
            if let Err(error) = written {
                // Leave no empty file behind: the next start would take it for the token.
                let _ = std::fs::remove_file(&path);
                return Err(error).with_context(|| format!("cannot write {}", path.display()));
            }
            Ok((token.expose().to_owned(), Source::NewFile(path)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?;
            Ok((text.trim().to_owned(), Source::File(path)))
        }
        Err(error) => Err(error).with_context(|| format!("cannot create {}", path.display())),
    }
}

/// Creates the file, failing when it exists, readable by its owner only from the first byte.
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_given_token_wins_and_an_empty_one_counts_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let (token, source) = resolve(Some(" abc "), dir.path()).unwrap();
        assert_eq!((token.as_str(), source), ("abc", Source::Variable));
        assert!(!dir.path().join(OWNER_TOKEN_FILE).exists());
        let (_, source) = resolve(Some("  "), dir.path()).unwrap();
        assert!(matches!(source, Source::NewFile(_)));
    }

    #[test]
    fn the_first_start_writes_a_private_file_and_the_next_reads_it() {
        let dir = tempfile::tempdir().unwrap();
        let (first, source) = resolve(None, dir.path()).unwrap();
        assert!(matches!(source, Source::NewFile(_)));
        assert!(first.starts_with("jo_"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.path().join(OWNER_TOKEN_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let (again, source) = resolve(None, dir.path()).unwrap();
        assert!(matches!(source, Source::File(_)));
        assert_eq!(again, first);
    }
}
