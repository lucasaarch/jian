//! Self-update: the worker replaces its own binary with one from a GitHub release, checked
//! against the SHA-256 published beside it, and then exits so its service manager starts the
//! new one. A binary that does not match its checksum is never installed.
//!
//! A release carries, per platform, `jian-remote-<os>-<arch>` (`.exe` on Windows) and
//! `<that name>.sha256`, whose first word is the hex digest.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use jian_protocol::machine::{TaskResult, UpdateOutcome};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

pub const REPOSITORY: &str = "lucasaarch/jian";
pub const GITHUB_API: &str = "https://api.github.com";
/// Larger than any build of the worker; a bigger download is not one.
const MAX_BINARY_BYTES: u64 = 200 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Finishes an install on the host, given the new version; an error fails the update.
pub type AfterInstall = fn(&str) -> Result<(), String>;

#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// The GitHub API, overridable so a test can serve its own releases.
    pub api_base: String,
    pub repository: String,
    /// The binary to replace: the running one.
    pub binary: PathBuf,
    pub current: String,
    /// Run with the new version once the new binary is in place, whoever started the update
    /// (the CLI or a task from the gateway). On a Mac the host remakes the bundle's Info.plist
    /// and ad-hoc signature here: the old signature no longer matches the new bytes, and macOS
    /// would refuse the bundle or drop its privacy permissions.
    pub after_install: Option<AfterInstall>,
}

impl UpdateConfig {
    pub fn for_this_binary(current: &str, after_install: Option<AfterInstall>) -> Option<Self> {
        Some(Self {
            api_base: GITHUB_API.into(),
            repository: REPOSITORY.into(),
            binary: std::env::current_exe().ok()?,
            current: current.into(),
            after_install,
        })
    }
}

/// The release asset built for this machine.
pub fn asset_name() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    format!(
        "jian-remote-{}-{}{extension}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// `latest`, or a release such as `1.2.3` (a leading `v` is accepted).
pub fn release_path(version: &str) -> Result<String, String> {
    let version = version.trim();
    if version == "latest" {
        return Ok("releases/latest".into());
    }
    let bare = version.strip_prefix('v').unwrap_or(version);
    let valid = regex::Regex::new(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$").expect("valid pattern");
    if !valid.is_match(bare) {
        return Err(format!(
            "Not a release: {version}. Use latest or a version such as 1.2.3."
        ));
    }
    Ok(format!("releases/tags/v{bare}"))
}

/// The digest in a `.sha256` file: its first word, as `sha256sum` writes it.
pub fn parse_checksum(text: &str) -> Option<String> {
    let word = text.split_whitespace().next()?.to_ascii_lowercase();
    (word.len() == 64 && word.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(word)
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// Only https crosses a network; plain http is accepted on loopback, for tests.
fn checked(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|error| format!("Bad URL {url}: {error}"))?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if loopback => Ok(parsed),
        _ => Err(format!(
            "Refused to download over {}: {url}",
            parsed.scheme()
        )),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("jian-remote/", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT)
        // A redirect is followed only to https, since GitHub sends assets to its CDN.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" && attempt.previous().len() < 10 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

async fn get(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    let response = client
        .get(checked(url)?)
        .header(
            "accept",
            "application/octet-stream, application/vnd.github+json",
        )
        .send()
        .await
        .map_err(|error| format!("Could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{url} answered HTTP {}",
            response.status().as_u16()
        ));
    }
    Ok(response)
}

/// Streams the binary to `to`, hashing it as it comes, never holding more than a chunk.
async fn download(client: &reqwest::Client, url: &str, to: &Path) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let response = get(client, url).await?;
    let mut file = tokio::fs::File::create(to)
        .await
        .map_err(|error| format!("Could not write {}: {error}", to.display()))?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| format!("Download of {url} broke off: {error}"))?;
        size += chunk.len() as u64;
        if size > MAX_BINARY_BYTES {
            return Err(format!("{url} is larger than any worker build."));
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write {}: {error}", to.display()))?;
    }
    file.sync_all().await.map_err(|error| error.to_string())?;
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Puts `new` where `binary` is. Unix replaces a running binary by rename; Windows cannot
/// overwrite a running .exe, but can rename it out of the way first.
fn install(new: &Path, binary: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(new, std::fs::Permissions::from_mode(0o755))?;
    }
    if cfg!(windows) {
        let old = binary.with_extension("old.exe");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(binary, &old)?;
        if let Err(error) = std::fs::rename(new, binary) {
            let _ = std::fs::rename(&old, binary);
            return Err(error);
        }
        return Ok(());
    }
    std::fs::rename(new, binary)
}

/// Installs the release `version` names and answers the versions it went from and to. `to`
/// equal to `from` means nothing was changed and the worker carries on.
pub async fn update(version: &str, config: &UpdateConfig) -> Result<UpdateOutcome, String> {
    let client = client()?;
    let api = config.api_base.trim_end_matches('/');
    let release_url = format!(
        "{api}/repos/{}/{}",
        config.repository,
        release_path(version)?
    );
    let release: Release = get(&client, &release_url)
        .await?
        .json()
        .await
        .map_err(|error| format!("{release_url} did not answer a release: {error}"))?;
    let to = release.tag_name.trim_start_matches('v').to_owned();
    let from = config.current.clone();
    if to == from {
        return Ok(UpdateOutcome { from, to });
    }
    let name = asset_name();
    let find = |wanted: &str| {
        release
            .assets
            .iter()
            .find(|asset| asset.name == wanted)
            .map(|asset| asset.browser_download_url.clone())
            .ok_or_else(|| format!("Release {} has no {wanted}.", release.tag_name))
    };
    let binary_url = find(&name)?;
    let checksum_url = find(&format!("{name}.sha256"))?;
    let checksum_text = get(&client, &checksum_url)
        .await?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let expected = parse_checksum(&checksum_text)
        .ok_or_else(|| format!("{checksum_url} does not hold a SHA-256 digest."))?;

    // Beside the binary, so the final rename stays on one file system and is atomic.
    let staged = config
        .binary
        .with_extension(format!("update-{}", crate::random::hex(6)));
    let result = async {
        let actual = download(&client, &binary_url, &staged).await?;
        if actual != expected {
            return Err(format!("The download does not match its checksum (expected {expected}, got {actual}). Nothing was installed."));
        }
        install(&staged, &config.binary).map_err(|error| format!("Could not replace {}: {error}", config.binary.display()))
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result?;
    if let Some(after_install) = config.after_install {
        after_install(&to).map_err(|error| {
            format!("Installed {to}, but could not finish the install: {error}")
        })?;
    }
    Ok(UpdateOutcome { from, to })
}

/// The task's result, and whether the worker should exit for its service to start the new one.
pub async fn run_update_task(
    id: &str,
    version: &str,
    config: Option<&UpdateConfig>,
) -> (TaskResult, bool) {
    let Some(config) = config else {
        return (
            TaskResult::failed(id, "This worker cannot find its own binary to update."),
            false,
        );
    };
    match update(version, config).await {
        Ok(outcome) => {
            let restart = outcome.from != outcome.to;
            let note = if restart {
                format!(
                    "Updated from {} to {}; restarting.",
                    outcome.from, outcome.to
                )
            } else {
                format!("Already on {}.", outcome.to)
            };
            let result = TaskResult {
                id: id.into(),
                exit_code: Some(0),
                stdout: note,
                update: Some(outcome),
                ..TaskResult::default()
            };
            (result, restart)
        }
        Err(error) => (TaskResult::failed(id, error), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_what_it_downloads() {
        assert_eq!(release_path("latest").unwrap(), "releases/latest");
        assert_eq!(release_path("1.2.3").unwrap(), "releases/tags/v1.2.3");
        assert_eq!(
            release_path("v1.2.3-rc.1").unwrap(),
            "releases/tags/v1.2.3-rc.1"
        );
        assert!(release_path("../../etc").is_err());
        let digest = "a".repeat(64);
        assert_eq!(
            parse_checksum(&format!("{digest}  jian-remote-linux-x86_64\n")),
            Some(digest)
        );
        assert_eq!(parse_checksum("not a digest"), None);
        assert!(checked("http://example.com/x").is_err());
        assert!(checked("http://127.0.0.1:9/x").is_ok());
    }
}
