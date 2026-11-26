//! A `SKILL.md` from a public GitHub repository.

use std::time::Duration;

use jian_store::SkillSource;
use reqwest::{Client, StatusCode, redirect::Policy};

use crate::parse::SkillError;

/// Where GitHub serves raw files. Tests and a mirror give another one.
pub const DEFAULT_GITHUB_BASE: &str = "https://raw.githubusercontent.com";
/// The largest `SKILL.md` taken, in bytes. The stored instructions are bound tighter still
/// (12,000 characters); this only keeps a hostile or mistaken file out of memory.
pub const MAX_SKILL_FILE_BYTES: usize = 256 * 1024;
/// The longest a fetch may take.
const TIMEOUT: Duration = Duration::from_secs(15);

/// Fetches skill files from GitHub.
#[derive(Clone, Debug)]
pub struct GithubSource {
    client: Client,
    base: String,
}

fn word(s: &str, extra: &[char]) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// The address of the file, after checking each part: nothing in a repository, ref or path may
/// reach another host or climb out of the repository.
fn file_url(base: &str, repo: &str, path: &str, git_ref: &str) -> Result<String, SkillError> {
    let repo_ok = repo.split_once('/').is_some_and(|(owner, name)| {
        word(owner, &['-']) && word(name, &['-', '_', '.']) && name != "." && name != ".."
    });
    if !repo_ok {
        return Err(SkillError::BadSource("the repository is owner/name"));
    }
    let ref_ok = word(git_ref, &['-', '_', '.', '/'])
        && !git_ref.contains("..")
        && !git_ref.starts_with(['-', '/'])
        && !git_ref.ends_with('/');
    if !ref_ok {
        return Err(SkillError::BadSource(
            "the ref is not a branch, tag or commit",
        ));
    }
    let path = path.trim_matches('/');
    let path_ok = path.is_empty()
        || path
            .split('/')
            .all(|part| word(part, &['-', '_', '.']) && part != "." && part != "..");
    if !path_ok {
        return Err(SkillError::BadSource(
            "the path is not a folder of the repository",
        ));
    }
    let file = if path.is_empty() {
        "SKILL.md".to_owned()
    } else if std::path::Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        path.to_owned()
    } else {
        format!("{path}/SKILL.md")
    };
    Ok(format!("{base}/{repo}/{git_ref}/{file}"))
}

impl GithubSource {
    /// A source reading from `base` ([`DEFAULT_GITHUB_BASE`] in production).
    pub fn new(base: &str) -> Result<Self, SkillError> {
        // reqwest's rustls has no provider of its own here (see the workspace manifest): ring is
        // installed before the first client. An error only means one is already installed.
        drop(rustls::crypto::ring::default_provider().install_default());
        let client = Client::builder()
            .timeout(TIMEOUT)
            // A raw file is never behind a redirect, and one would let a path leave GitHub.
            .redirect(Policy::none())
            .build()
            .map_err(|e| SkillError::Unreachable(e.to_string()))?;
        Ok(Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
        })
    }

    /// The `SKILL.md` of `repo` (`owner/name`) at `path` (a folder, or a `.md` file; empty for
    /// the root) and `git_ref` (`HEAD` when none), with where it came from.
    pub async fn fetch(
        &self,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> Result<(SkillSource, String), SkillError> {
        let git_ref = git_ref
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or("HEAD");
        let url = file_url(&self.base, repo, path, git_ref)?;
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| SkillError::Unreachable(e.without_url().to_string()))?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::NOT_FOUND => return Err(SkillError::NotFound),
            StatusCode::TOO_MANY_REQUESTS | StatusCode::FORBIDDEN => {
                return Err(SkillError::RateLimited);
            }
            other => {
                return Err(SkillError::Unreachable(format!(
                    "status {}",
                    other.as_u16()
                )));
            }
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_SKILL_FILE_BYTES as u64)
        {
            return Err(SkillError::TooLarge(MAX_SKILL_FILE_BYTES));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| SkillError::Unreachable(e.without_url().to_string()))?
        {
            if bytes.len() + chunk.len() > MAX_SKILL_FILE_BYTES {
                return Err(SkillError::TooLarge(MAX_SKILL_FILE_BYTES));
            }
            bytes.extend_from_slice(&chunk);
        }
        let markdown = String::from_utf8(bytes).map_err(|_| SkillError::NotText)?;
        Ok((
            SkillSource::Github {
                repo: repo.to_owned(),
                path: path.trim_matches('/').to_owned(),
                git_ref: git_ref.to_owned(),
            },
            markdown,
        ))
    }
}
