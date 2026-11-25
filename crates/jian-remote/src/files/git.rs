//! Git, read the way the gateway reads its own checkouts: never refresh the index, never run a
//! hook, fsmonitor or filter the repository supplies, never read the owner's global config, never
//! fetch. `GIT_LITERAL_PATHSPECS` makes every pathspec literal, so a name starting with `:` is
//! never read as pathspec magic.

use std::path::{Path, PathBuf};
use std::time::Duration;

use jian_protocol::machine::{FilesDone, FilesProblem};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::Problem;
use super::paths::{REFUSED_MESSAGE, canonical, inside, is_refused, real_location};
use super::text::is_binary;
use crate::process::{Pipe, run_bounded};
use crate::shell::child_env;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Each raw output of `git-status` and each side of `git-file`, in bytes.
const SIDE_BYTES: usize = 200_000;
const SMALL_BYTES: usize = 4096;

const NOWHERE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

struct Ran {
    code: Option<i32>,
    stdout: Vec<u8>,
}

impl Ran {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

struct Checkout {
    root: PathBuf,
    top: String,
    /// `-c` overrides for every filter driver the repository configures.
    settings: Vec<String>,
}

impl Checkout {
    async fn git(&self, args: &[&str], max_bytes: usize) -> Result<Ran, Problem> {
        run_git(&self.root, &self.settings, args, max_bytes).await
    }
}

async fn run_git(
    root: &Path,
    settings: &[String],
    args: &[&str],
    max_bytes: usize,
) -> Result<Ran, Problem> {
    let mut command = Command::new("git");
    command
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c"])
        .arg(format!("core.hooksPath={NOWHERE}"))
        .args(settings)
        .arg("-C")
        .arg(root)
        .args(args)
        .current_dir(std::env::temp_dir());
    // Nothing git reads from its environment is inherited: GIT_DIR, GIT_WORK_TREE,
    // GIT_CONFIG_COUNT/KEY_n/VALUE_n or GIT_EXTERNAL_DIFF could each undo the settings here.
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    child_env(&mut command);
    command.envs([
        ("LC_ALL", "C"),
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", NOWHERE),
        ("GIT_NO_LAZY_FETCH", "1"),
        ("GIT_LITERAL_PATHSPECS", "1"),
    ]);
    let stop = CancellationToken::new();
    let mut stdout = Vec::new();
    let mut oversize = false;
    let outcome = run_bounded(command, TIMEOUT, &stop, |pipe, bytes| {
        if pipe == Pipe::Stdout && !oversize {
            stdout.extend_from_slice(bytes);
            if stdout.len() > max_bytes {
                oversize = true;
                stop.cancel();
            }
        }
    })
    .await;
    if let Some(error) = outcome.spawn_error {
        return Err(if error.kind() == std::io::ErrorKind::NotFound {
            Problem::new(
                FilesProblem::Failed,
                "Git is not installed on this machine.",
            )
        } else {
            error.into()
        });
    }
    if oversize {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            "Git printed more than an answer can carry.",
        ));
    }
    if outcome.timed_out {
        return Err(Problem::new(FilesProblem::Failed, "Git took too long."));
    }
    Ok(Ran {
        code: outcome.code,
        stdout,
    })
}

/// The folder, refused-roots checked and proven to be the top of its own repository.
async fn open(root: &str, roots: &[String]) -> Result<Checkout, Problem> {
    let real = real_location(Path::new(root))?;
    if is_refused(&real, roots) {
        return Err(Problem::new(FilesProblem::Refused, REFUSED_MESSAGE));
    }
    let not_repository = || {
        Problem::new(
            FilesProblem::NotRepository,
            "That folder is not the top of a git repository.",
        )
    };
    let found = run_git(&real, &[], &["rev-parse", "--show-toplevel"], SMALL_BYTES).await?;
    let top = found.text().trim().to_owned();
    if !found.ok()
        || top.is_empty()
        || canonical(Path::new(&top)).ok().as_deref() != Some(real.as_path())
    {
        return Err(not_repository());
    }
    Ok(Checkout {
        root: real,
        top,
        settings: Vec::new(),
    })
}

/// Even `status` can run a clean filter while comparing files: every local driver is overridden.
async fn override_filters(checkout: &mut Checkout) -> Result<Vec<String>, Problem> {
    let found = checkout
        .git(
            &[
                "config",
                "--null",
                "--name-only",
                "--get-regexp",
                r"^filter\..*\.(clean|smudge|process|required)$",
            ],
            SIDE_BYTES,
        )
        .await?;
    if !matches!(found.code, Some(0 | 1)) {
        return Err(Problem::new(
            FilesProblem::Failed,
            "The repository configuration could not be read.",
        ));
    }
    let keys: Vec<String> = found
        .text()
        .split('\0')
        .filter(|key| !key.is_empty())
        .map(String::from)
        .collect();
    if keys.len() > 200 || keys.iter().any(|key| key.len() > 1024) {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            "The repository has more filter settings than can be shown.",
        ));
    }
    for key in &keys {
        let value = if key.ends_with(".required") {
            "false"
        } else {
            ""
        };
        checkout
            .settings
            .extend(["-c".into(), format!("{key}={value}")]);
    }
    Ok(keys)
}

pub async fn status(
    root: &str,
    against: Option<&str>,
    roots: &[String],
) -> Result<FilesDone, Problem> {
    let mut checkout = open(root, roots).await?;
    let filters = override_filters(&mut checkout).await?;
    let changes = checkout
        .git(
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
            SIDE_BYTES,
        )
        .await?;
    let unreadable = || Problem::new(FilesProblem::Failed, "The changes could not be read.");
    if !changes.ok() {
        return Err(unreadable());
    }
    let mut diff = None;
    if let Some(against) = against {
        let tracked = checkout
            .git(
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    "--no-renames",
                    "--ignore-submodules=dirty",
                    against,
                    "--",
                ],
                SIDE_BYTES,
            )
            .await?;
        if !tracked.ok() {
            return Err(unreadable());
        }
        diff = Some(tracked.text());
    }
    Ok(FilesDone::GitStatus {
        top: checkout.top,
        filters,
        status: changes.text(),
        diff,
    })
}

/// The working copy of a file, only when it is a regular file that stays inside the repository.
fn working_side(
    root: &Path,
    path: &str,
    cap: usize,
    roots: &[String],
) -> Result<(Option<String>, bool), Problem> {
    let target = root.join(path);
    let root_text = root.to_string_lossy();
    if !inside(&target.to_string_lossy(), &root_text) {
        return Err(Problem::new(
            FilesProblem::Refused,
            "That path leaves the repository.",
        ));
    }
    let outside = || {
        Problem::new(
            FilesProblem::Refused,
            "That file resolves outside the repository.",
        )
    };
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok((None, false));
        }
        Err(error) => return Err(error.into()),
    };
    if meta.file_type().is_symlink() {
        if canonical(&target).is_ok_and(|real| !inside(&real.to_string_lossy(), &root_text)) {
            return Err(outside());
        }
        return Err(Problem::new(
            FilesProblem::NotFile,
            "Symlinks and submodules have no text diff.",
        ));
    }
    if !meta.is_file() {
        return Err(Problem::new(
            FilesProblem::NotFile,
            "That path is not a file.",
        ));
    }
    let real = canonical(&target)?;
    if !inside(&real.to_string_lossy(), &root_text) || is_refused(&real, roots) {
        return Err(outside());
    }
    let too_large = || Problem::new(FilesProblem::TooLarge, "The file is too large to display.");
    if meta.len() > cap as u64 {
        return Err(too_large());
    }
    let bytes = std::fs::read(&real)?;
    if bytes.len() > cap {
        return Err(too_large());
    }
    if is_binary(&bytes) {
        return Ok((None, true));
    }
    Ok((Some(String::from_utf8_lossy(&bytes).into_owned()), false))
}

pub async fn file(
    root: &str,
    path: &str,
    against: &str,
    max_bytes: u64,
    roots: &[String],
) -> Result<FilesDone, Problem> {
    let mut checkout = open(root, roots).await?;
    let cap = usize::try_from(max_bytes)
        .unwrap_or(usize::MAX)
        .min(SIDE_BYTES);
    override_filters(&mut checkout).await?;
    // Absence is decided by exit code, never by git's wording. A branch with no commit yet has
    // nothing committed to compare with.
    let unborn = against == "HEAD"
        && !checkout
            .git(&["rev-parse", "--verify", "-q", "HEAD"], SMALL_BYTES)
            .await?
            .ok();
    let object = format!("{against}:{path}");
    let mut before = None;
    let mut binary = false;
    if !unborn {
        if checkout
            .git(&["cat-file", "-e", &object], SMALL_BYTES)
            .await?
            .ok()
        {
            // `cat-file blob` fails on a folder or a submodule where `show` would print a listing.
            let shown = checkout.git(&["cat-file", "blob", &object], cap).await?;
            if !shown.ok() {
                return Err(Problem::new(
                    FilesProblem::NotFile,
                    "That path is not a file.",
                ));
            }
            if is_binary(&shown.stdout) {
                binary = true;
            } else {
                before = Some(shown.text());
            }
        } else if !checkout
            .git(
                &[
                    "rev-parse",
                    "--verify",
                    "-q",
                    &format!("{against}^{{commit}}"),
                ],
                SMALL_BYTES,
            )
            .await?
            .ok()
        {
            return Err(Problem::new(
                FilesProblem::Failed,
                "That commit could not be found.",
            ));
        }
    }
    let root = checkout.root.clone();
    let (path, roots) = (path.to_owned(), roots.to_vec());
    let (after, working_binary) =
        tokio::task::spawn_blocking(move || working_side(&root, &path, cap, &roots))
            .await
            .map_err(|error| Problem::new(FilesProblem::Failed, error.to_string()))??;
    Ok(FilesDone::GitFile {
        before,
        after,
        binary: binary || working_binary,
    })
}

pub async fn merge_base(root: &str, base: &str, roots: &[String]) -> Result<FilesDone, Problem> {
    let checkout = open(root, roots).await?;
    // A full ref, so the base cannot read as an option or resolve to a tag.
    let found = checkout
        .git(
            &["merge-base", &format!("refs/heads/{base}"), "HEAD"],
            SMALL_BYTES,
        )
        .await?;
    let sha = found.text().trim().to_owned();
    let shaped = sha.len() == 40 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !found.ok() || !shaped {
        return Err(Problem::new(
            FilesProblem::Failed,
            format!("Could not find where this branch left {base}."),
        ));
    }
    Ok(FilesDone::MergeBase { sha })
}
