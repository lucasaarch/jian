//! Changing files by exact replacements, all or nothing. Blocking: run off the async threads.
//!
//! Every file is read, checked against the version the editor saw, and changed in memory before
//! anything is written, so a replacement that does not apply leaves every file as it was. The
//! writes come last; if one of them fails, the files already written are put back.

use std::fmt::Write as _;
use std::path::PathBuf;

use jian_protocol::machine::{
    EditedFile, FILES_MAX_READ_BYTES, FileEdit, FilesDone, FilesProblem, Replacement,
};

use super::Problem;
use super::text::{mtime_ms, read_whole, write_atomic};

/// A file ready to be written: where, what it becomes, what it was (to put back).
struct Pending {
    real: PathBuf,
    path: String,
    after: String,
    before: Option<String>,
    mode: Option<u32>,
    replaced: usize,
}

fn line_of(text: &str, at: usize) -> usize {
    text[..at].bytes().filter(|&b| b == b'\n').count() + 1
}

/// How alike two lines are, 0 to 1: the share of two-character pieces they have in common.
fn likeness(a: &str, b: &str) -> f64 {
    let pieces = |s: &str| -> Vec<(char, char)> {
        let chars: Vec<char> = s.trim().chars().collect();
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let (a, b) = (pieces(a), pieces(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut left = b.clone();
    let mut shared = 0usize;
    for piece in &a {
        if let Some(at) = left.iter().position(|p| p == piece) {
            left.swap_remove(at);
            shared += 1;
        }
    }
    (2 * shared) as f64 / (a.len() + b.len()) as f64
}

/// The line of `text` most like the first line of `old`, as `line N: …`, for a message.
fn closest(text: &str, old: &str) -> Option<String> {
    let wanted = old.lines().find(|line| !line.trim().is_empty())?;
    let (number, line, score) = text
        .lines()
        .enumerate()
        .map(|(i, line)| (i + 1, line, likeness(wanted, line)))
        .max_by(|a, b| a.2.total_cmp(&b.2))?;
    if score < 0.5 {
        return None;
    }
    let shown: String = line.chars().take(200).collect();
    Some(format!(
        "the most similar text is at line {number}: {shown}"
    ))
}

fn apply(path: &str, text: &str, replacement: &Replacement) -> Result<(String, usize), Problem> {
    let old = &replacement.old;
    if old.is_empty() {
        return Err(Problem::new(
            FilesProblem::Failed,
            format!("A replacement in {path} has an empty `old`; name the text to replace."),
        ));
    }
    let found: Vec<usize> = text.match_indices(old.as_str()).map(|(at, _)| at).collect();
    match found.len() {
        0 => {
            let mut message = format!("The text to replace was not found in {path}");
            if let Some(near) = closest(text, old) {
                let _ = write!(message, "; {near}");
            }
            message.push_str(". Nothing was changed; copy `old` exactly from the file.");
            Err(Problem::new(FilesProblem::Failed, message))
        }
        1 => Ok((text.replacen(old.as_str(), &replacement.new, 1), 1)),
        count if replacement.replace_all => {
            Ok((text.replace(old.as_str(), &replacement.new), count))
        }
        count => {
            let lines: Vec<String> = found
                .iter()
                .take(8)
                .map(|&at| line_of(text, at).to_string())
                .collect();
            Err(Problem::new(
                FilesProblem::Failed,
                format!(
                    "The text to replace was found {count} times in {path} (lines {}). Nothing was changed; add more of the surrounding text to `old` so it is unique, or set replaceAll.",
                    lines.join(", ")
                ),
            ))
        }
    }
}

fn prepare(real: PathBuf, edit: &FileEdit) -> Result<Pending, Problem> {
    let path = edit.path.clone();
    if let Some(content) = &edit.create {
        if !edit.replacements.is_empty() {
            return Err(Problem::new(
                FilesProblem::Failed,
                format!("{path} is created with its whole text; it takes no replacements."),
            ));
        }
        if real.exists() {
            return Err(Problem::new(
                FilesProblem::Exists,
                format!("{path} already exists; edit it instead of creating it."),
            ));
        }
        return Ok(Pending {
            real,
            path,
            after: content.clone(),
            before: None,
            mode: None,
            replaced: 0,
        });
    }
    let (before, meta) = read_whole(&real, FILES_MAX_READ_BYTES)
        .map_err(|problem| Problem::new(problem.problem, format!("{path}: {}", problem.message)))?;
    if let Some(expected) = edit.expected_mtime_ms
        && (mtime_ms(&meta) - expected).abs() > f64::EPSILON
    {
        return Err(Problem::new(
            FilesProblem::Changed,
            format!("{path} changed since it was read. Nothing was changed; read it again."),
        ));
    }
    let mut after = before.clone();
    let mut replaced = 0;
    for replacement in &edit.replacements {
        let (next, count) = apply(&path, &after, replacement)?;
        after = next;
        replaced += count;
    }
    Ok(Pending {
        real,
        path,
        after,
        before: Some(before),
        mode: super::text::mode_of(&meta),
        replaced,
    })
}

/// Applies every file's edits, or none. `reals` are the real paths, in the order of `files`.
pub fn edit(files: &[FileEdit], reals: Vec<PathBuf>) -> Result<FilesDone, Problem> {
    for (i, real) in reals.iter().enumerate() {
        if reals[..i].contains(real) {
            return Err(Problem::new(
                FilesProblem::Failed,
                format!(
                    "{} is listed twice; put all its replacements in one entry.",
                    files[i].path
                ),
            ));
        }
    }
    let pending = files
        .iter()
        .zip(reals)
        .map(|(file, real)| prepare(real, file))
        .collect::<Result<Vec<_>, _>>()?;
    let mut done: Vec<&Pending> = Vec::new();
    for item in &pending {
        let written = item
            .real
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| write_atomic(&item.real, item.after.as_bytes(), item.mode));
        if let Err(error) = written {
            for back in done {
                let _ = match &back.before {
                    Some(text) => write_atomic(&back.real, text.as_bytes(), back.mode),
                    None => std::fs::remove_file(&back.real),
                };
            }
            return Err(Problem::new(
                FilesProblem::Failed,
                format!(
                    "Could not write {} ({error}). Every file was put back as it was.",
                    item.path
                ),
            ));
        }
        done.push(item);
    }
    let files = pending
        .iter()
        .map(|item| {
            Ok(EditedFile {
                path: item.path.clone(),
                mtime_ms: mtime_ms(&std::fs::metadata(&item.real)?),
                replaced: item.replaced,
                created: item.before.is_none(),
            })
        })
        .collect::<Result<Vec<_>, std::io::Error>>()?;
    Ok(FilesDone::Edit { files })
}
