//! File operations: read, write, list, find, search and git, with the file system and git
//! programs, never a shell. Every operation acts on the real path the checks saw, never on the
//! spelling given: `..` after a link, `./`, case and a link as the root all lead where the real
//! path leads.

mod find;
mod git;
mod paths;
mod search;
mod text;
mod validate;
mod walk;

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use jian_protocol::machine::{
    FilesAnswer, FilesDone, FilesFailure, FilesOp, FilesProblem, RESULT_BUDGET_BYTES, TaskResult,
};

pub use paths::{REFUSED_MESSAGE, known_refused};

/// How long a find or a search runs, unless the task allows less.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest message a failure carries, in characters.
const MESSAGE_MAX: usize = 2000;

/// A refusal in the protocol's words, raised from deep helpers and answered at the top.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Problem {
    /// The protocol's class of refusal.
    pub problem: FilesProblem,
    /// What happened, in words an agent can act on.
    pub message: String,
}

impl Problem {
    /// A refusal of `problem` with its message.
    pub fn new(problem: FilesProblem, message: impl Into<String>) -> Self {
        Self {
            problem,
            message: message.into(),
        }
    }
}

/// What the file system says, in words the agent can act on.
impl From<std::io::Error> for Problem {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            ErrorKind::NotFound => Self::new(FilesProblem::Missing, "That path does not exist."),
            ErrorKind::NotADirectory => Self::new(
                FilesProblem::NotDirectory,
                "A part of that path is not a folder.",
            ),
            ErrorKind::IsADirectory => Self::new(FilesProblem::NotFile, "That path is not a file."),
            _ => Self::new(
                FilesProblem::Failed,
                format!("The operation failed ({error})."),
            ),
        }
    }
}

/// Folders that are off limits, and how long a walk may take.
#[derive(Clone)]
pub struct FilesConfig {
    /// Absolute paths the worker never reads or writes (its own credentials).
    pub refused: Vec<PathBuf>,
}

impl Default for FilesConfig {
    fn default() -> Self {
        Self {
            refused: known_refused(),
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Problem> + Send + 'static,
) -> Result<T, Problem> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| Err(Problem::new(FilesProblem::Failed, error.to_string())))
}

async fn run(op: &FilesOp, config: &FilesConfig, timeout: Duration) -> Result<FilesDone, Problem> {
    let roots = paths::refused_roots(&config.refused);
    let given = match op {
        FilesOp::GitStatus { root, against } => {
            return git::status(root, against.as_deref(), &roots).await;
        }
        FilesOp::GitFile {
            root,
            path,
            against,
            max_bytes,
        } => return git::file(root, path, against, *max_bytes, &roots).await,
        FilesOp::MergeBase { root, base } => return git::merge_base(root, base, &roots).await,
        FilesOp::Read { path, .. }
        | FilesOp::Write { path, .. }
        | FilesOp::List { path, .. }
        | FilesOp::Find { path, .. }
        | FilesOp::Search { path, .. }
        | FilesOp::ReadBytes { path, .. }
        | FilesOp::WriteBytes { path, .. } => path.clone(),
    };
    let real = {
        let given = given.clone();
        blocking(move || paths::real_location(Path::new(&given))).await?
    };
    if paths::is_refused(&real, &roots) {
        return Err(Problem::new(FilesProblem::Refused, REFUSED_MESSAGE));
    }
    let shower = find::Shower::new(&given, &real);
    match op.clone() {
        FilesOp::Read { max_bytes, .. } => {
            blocking(move || text::read_text(&real, max_bytes)).await
        }
        FilesOp::ReadBytes { max_bytes, .. } => {
            blocking(move || text::read_bytes(&real, max_bytes)).await
        }
        FilesOp::Write {
            content,
            expected_mtime_ms,
            ..
        } => blocking(move || text::write_text(&real, &content, expected_mtime_ms)).await,
        FilesOp::WriteBytes { base64, .. } => {
            blocking(move || text::write_bytes(&real, &base64)).await
        }
        FilesOp::List { limit, .. } => blocking(move || find::list(&real, limit)).await,
        FilesOp::Find { pattern, limit, .. } => {
            let deadline = Instant::now() + timeout;
            blocking(move || find::find(&real, &pattern, limit, &roots, &shower, deadline)).await
        }
        FilesOp::Search {
            pattern,
            glob,
            ignore_case,
            context_lines,
            output,
            limit,
            ..
        } => {
            let request = search::Search {
                pattern: &pattern,
                glob: glob.as_deref(),
                ignore_case,
                context_lines,
                output,
                limit,
            };
            search::search(&real, &request, &roots, &shower, timeout).await
        }
        FilesOp::GitStatus { .. } | FilesOp::GitFile { .. } | FilesOp::MergeBase { .. } => {
            unreachable!("answered above")
        }
    }
}

fn failed(op: &FilesOp, problem: FilesProblem, message: &str) -> FilesAnswer {
    FilesAnswer::Failed(FilesFailure {
        op: op.name(),
        problem,
        message: message.chars().take(MESSAGE_MAX).collect(),
    })
}

/// Runs one file operation. The answer carries no more than a result can.
pub async fn answer(op: &FilesOp, config: &FilesConfig, timeout: Duration) -> FilesAnswer {
    if !validate::is_valid(op) {
        return failed(
            op,
            FilesProblem::Failed,
            "That file operation is not valid.",
        );
    }
    let answer = match run(op, config, timeout).await {
        Ok(done) => FilesAnswer::Done(done),
        Err(problem) => failed(op, problem.problem, &problem.message),
    };
    // Characters are not bytes: the whole answer is measured as it will travel.
    let bytes = serde_json::to_string(&answer).map_or(0, |text| text.len());
    if bytes > RESULT_BUDGET_BYTES {
        return failed(
            op,
            FilesProblem::TooLarge,
            &format!("The answer would be {bytes} bytes, more than a result can carry."),
        );
    }
    answer
}

/// Runs one file operation within `timeout` and answers it as the protocol says, fitted under the result budget.
pub async fn run_files_task(
    id: &str,
    op: &FilesOp,
    timeout: Duration,
    config: &FilesConfig,
) -> TaskResult {
    let files = answer(op, config, timeout.min(SEARCH_TIMEOUT)).await;
    TaskResult {
        id: id.into(),
        exit_code: Some(i32::from(matches!(files, FilesAnswer::Failed(_)))),
        files: Some(files),
        ..TaskResult::default()
    }
}
