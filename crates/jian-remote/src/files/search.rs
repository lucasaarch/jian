//! Searching file contents: ripgrep when it is installed, else the walk, both on the real path
//! and bounded in time.

use std::path::Path;
use std::time::{Duration, Instant};

use jian_protocol::machine::{FILES_MAX_SEARCH_CHARS, FilesDone, FilesProblem, SearchOutput};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::Problem;
use super::find::{SKIPPED, Shower};
use super::paths::inside;
use super::walk::{WalkJob, Walked, walk_search};
use crate::process::{Pipe, run_bounded};
use crate::shell::MINIMAL_PATH;

/// What ripgrep may print before it is stopped, in bytes; the answer keeps far less.
const MAX_STDOUT: usize = FILES_MAX_SEARCH_CHARS * 8;
const TIME_NOTE: &str = "… search stopped at its time limit";

pub struct Search<'a> {
    pub pattern: &'a str,
    pub glob: Option<&'a str>,
    pub ignore_case: bool,
    pub context_lines: usize,
    pub output: SearchOutput,
    pub limit: usize,
}

fn ripgrep_args(search: &Search, target: &Path) -> Vec<String> {
    let mode = match search.output {
        SearchOutput::Files => "-l",
        SearchOutput::Count => "-c",
        SearchOutput::Content => "-n",
    };
    // --no-config: the owner's RIPGREP_CONFIG_PATH may hold --follow or --no-ignore, which would
    // walk through links into a refused folder under a spelling the output filter does not know.
    let mut args: Vec<String> = [
        "--no-config",
        "--no-heading",
        "--with-filename",
        "--color",
        "never",
        mode,
    ]
    .map(String::from)
    .to_vec();
    if search.ignore_case {
        args.push("-i".into());
    }
    if search.context_lines > 0 && search.output == SearchOutput::Content {
        args.extend(["-C".into(), search.context_lines.to_string()]);
    }
    if let Some(glob) = search.glob {
        args.extend(["--glob".into(), glob.into()]);
    }
    for name in SKIPPED {
        args.extend(["--glob".into(), format!("!{name}")]);
    }
    // The pattern after -e and the path after --, so neither can be read as an option.
    args.extend([
        "-e".into(),
        search.pattern.into(),
        "--".into(),
        target.to_string_lossy().into_owned(),
    ]);
    args
}

/// `None` when ripgrep is not installed.
async fn ripgrep(
    search: &Search<'_>,
    target: &Path,
    timeout: Duration,
    roots: &[String],
) -> Option<Result<Walked, String>> {
    let mut command = Command::new("rg");
    command.args(ripgrep_args(search, target));
    if std::env::var("PATH").map_or(true, |path| path.is_empty()) {
        command.env("PATH", MINIMAL_PATH);
    }
    let stop = CancellationToken::new();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut oversize = false;
    let outcome = run_bounded(command, timeout, &stop, |pipe, bytes| match pipe {
        Pipe::Stdout if !oversize => {
            stdout.extend_from_slice(bytes);
            if stdout.len() > MAX_STDOUT {
                oversize = true;
                stop.cancel();
            }
        }
        Pipe::Stderr if stderr.len() < 2000 => stderr.extend_from_slice(bytes),
        _ => {}
    })
    .await;
    if let Some(error) = outcome.spawn_error {
        return (error.kind() != std::io::ErrorKind::NotFound).then(|| Err(error.to_string()));
    }
    let text = String::from_utf8_lossy(&stdout);
    let lines = |text: &str| {
        text.split('\n')
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect()
    };
    if oversize || outcome.timed_out {
        // What was printed up to the stop; the line being written when it stopped is not whole.
        let whole = &text[..text.rfind('\n').map_or(0, |end| end + 1)];
        return Some(Ok(Walked {
            lines: lines(whole),
            truncated: true,
            timed_out: outcome.timed_out,
        }));
    }
    // 1 is no match, an answer. 2 is an error, but ripgrep still prints what it could read.
    match outcome.code {
        Some(0 | 1) => {}
        Some(2) if !stdout.is_empty() => {}
        code => {
            // Its complaints name files, which may lie in a refused folder; those lines go.
            let said: Vec<String> = String::from_utf8_lossy(&stderr)
                .lines()
                .filter(|line| {
                    !line.trim().is_empty()
                        && !roots
                            .iter()
                            .any(|root| line.to_lowercase().contains(&root.to_lowercase()))
                })
                .map(String::from)
                .collect();
            return Some(Err(if said.is_empty() {
                format!(
                    "Search failed ({}).",
                    code.map_or("signal".into(), |code| code.to_string())
                )
            } else {
                said.join("\n")
            }));
        }
    }
    Some(Ok(Walked {
        lines: lines(&text),
        truncated: false,
        timed_out: false,
    }))
}

pub async fn search(
    real: &Path,
    search: &Search<'_>,
    roots: &[String],
    shower: &Shower,
    timeout: Duration,
) -> Result<FilesDone, Problem> {
    tokio::fs::metadata(real).await?;
    let found = match ripgrep(search, real, timeout, roots).await {
        Some(found) => found,
        None => {
            let real = real.to_path_buf();
            let pattern = search.pattern.to_owned();
            let glob = search.glob.map(String::from);
            let (ignore_case, context_lines, output, limit) = (
                search.ignore_case,
                search.context_lines,
                search.output,
                search.limit,
            );
            let roots = roots.to_vec();
            let deadline = Instant::now() + timeout;
            tokio::task::spawn_blocking(move || {
                walk_search(
                    &real,
                    &WalkJob {
                        pattern: &pattern,
                        ignore_case,
                        glob: glob.as_deref(),
                        context_lines,
                        output,
                        limit,
                        chars: FILES_MAX_SEARCH_CHARS,
                        roots: &roots,
                        deadline,
                    },
                )
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
        }
    };
    let found = found.map_err(|message| Problem::new(FilesProblem::Failed, message))?;
    // Every line starts with the path it came from, so what came from a refused folder goes by
    // its prefix, compared as the file system compares. Lines without a path (`--`) stay.
    let kept: Vec<&String> = found
        .lines
        .iter()
        .filter(|line| !roots.iter().any(|root| inside(line, root) && *line != root))
        .collect();
    let mut matches = Vec::new();
    let mut chars = 0;
    for line in kept.iter().take(search.limit) {
        let shown = shower.show(line);
        let length = shown.chars().count();
        if chars + length > FILES_MAX_SEARCH_CHARS {
            // One line longer than the budget is cut, not turned into an empty answer.
            if matches.is_empty() {
                matches.push(shown.chars().take(FILES_MAX_SEARCH_CHARS).collect());
            }
            break;
        }
        chars += length;
        matches.push(shown);
    }
    if found.timed_out && matches.len() < search.limit && chars + 50 <= FILES_MAX_SEARCH_CHARS {
        matches.push(TIME_NOTE.into());
    }
    let truncated = found.truncated || kept.len() > matches.len();
    Ok(FilesDone::Search { matches, truncated })
}
