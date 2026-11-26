//! What the file tools do on a machine, apart from being tools: read a range, list, find,
//! search, edit, write and patch. Each is one operation the machine runs itself (see
//! `Machine::files`), so a file is never downloaded to be changed and sent back, and the gateway's
//! machine and a connected one answer the same way.
//!
//! Errors are text for the model and say what to do next.

use std::fmt::Write as _;

use jian_exec::{Machine, files_done};
use jian_protocol::machine::{
    FILES_MAX_READ_BYTES, FileEdit, FilesDone, FilesOp, Replacement, SearchOutput,
};
use serde_json::Value;

use crate::patch;
use crate::tool::MachineSlot;

/// Lines a read returns when the model names no limit.
const READ_LINES: usize = 2000;

fn exec(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{key}` is required and must be a string"))
}

fn number(input: &Value, key: &str) -> Result<Option<usize>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("`{key}` must be a whole number")),
    }
}

fn flag(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn path_or_here(input: &Value) -> &str {
    input.get("path").and_then(Value::as_str).unwrap_or(".")
}

/// The line numbers a model reads and quotes back: `   12\tcode`.
fn numbered(text: &str, first: usize) -> String {
    let mut out = String::new();
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let _ = write!(out, "{:>6}\t{line}", first + i);
        if !line.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

async fn read_one(
    machine: &dyn Machine,
    slot: &MachineSlot,
    path: &str,
    from: usize,
    limit: usize,
) -> Result<String, String> {
    let op = FilesOp::Read {
        path: path.to_owned(),
        max_bytes: FILES_MAX_READ_BYTES,
        from_line: Some(from),
        max_lines: Some(limit),
    };
    let FilesDone::Read {
        text,
        mtime_ms,
        first_line,
        total_lines,
        ..
    } = files_done(machine, op).await.map_err(exec)?
    else {
        return Err("the machine answered another operation".to_owned());
    };
    slot.set_version(path, mtime_ms);
    if total_lines == 0 {
        return Ok("(empty file)".to_owned());
    }
    let shown = text.split_inclusive('\n').count();
    let mut out = numbered(&text, first_line);
    if shown == 0 {
        let _ = write!(
            out,
            "[the file has {total_lines} lines; none from line {first_line}]"
        );
    } else if first_line + shown <= total_lines {
        let _ = write!(
            out,
            "[lines {first_line}-{} of {total_lines}; read on with offset={}]",
            first_line + shown - 1,
            first_line + shown
        );
    }
    Ok(out)
}

/// `read_file`: one `path` or several `paths`, from line `offset` (1-based), at most `limit` lines
/// each.
pub async fn read(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let mut paths: Vec<&str> = Vec::new();
    if let Some(path) = input.get("path").and_then(Value::as_str) {
        paths.push(path);
    }
    if let Some(list) = input.get("paths").and_then(Value::as_array) {
        for path in list {
            paths.push(path.as_str().ok_or("`paths` must hold strings")?);
        }
    }
    if paths.is_empty() {
        return Err("give `path`, or `paths` to read several files in one call".to_owned());
    }
    let from = number(input, "offset")?.unwrap_or(1).max(1);
    let limit = number(input, "limit")?.unwrap_or(READ_LINES).max(1);
    if let [path] = paths[..] {
        return read_one(machine, slot, path, from, limit).await;
    }
    let mut out = String::new();
    for path in paths {
        let body = read_one(machine, slot, path, from, limit)
            .await
            .unwrap_or_else(|error| format!("error: {error}"));
        let _ = write!(out, "==> {path} <==\n{body}\n\n");
    }
    Ok(out)
}

/// `list_directory`.
pub async fn list(machine: &dyn Machine, input: &Value) -> Result<String, String> {
    let limit = number(input, "limit")?.unwrap_or(300).clamp(1, 300);
    let op = FilesOp::List {
        path: path_or_here(input).to_owned(),
        limit,
    };
    let FilesDone::List { entries, truncated } = files_done(machine, op).await.map_err(exec)?
    else {
        return Err("the machine answered another operation".to_owned());
    };
    let mut out = String::new();
    for entry in entries {
        let mark = match entry.kind {
            jian_protocol::machine::EntryKind::Directory => "/",
            jian_protocol::machine::EntryKind::Symlink => "@",
            _ => "",
        };
        let _ = writeln!(out, "{}{mark}", entry.name);
    }
    if out.is_empty() {
        out.push_str("(empty directory)\n");
    }
    if truncated {
        out.push_str("[more entries than shown]\n");
    }
    Ok(out)
}

/// `find_files`: a glob such as `**/*.rs`.
pub async fn find(machine: &dyn Machine, input: &Value) -> Result<String, String> {
    let op = FilesOp::Find {
        path: path_or_here(input).to_owned(),
        pattern: text(input, "pattern")?.to_owned(),
        limit: number(input, "limit")?.unwrap_or(200).clamp(1, 1000),
    };
    let FilesDone::Find { files, truncated } = files_done(machine, op).await.map_err(exec)? else {
        return Err("the machine answered another operation".to_owned());
    };
    let mut out = files.join("\n");
    if out.is_empty() {
        out.push_str("(no file matches)");
    }
    if truncated {
        out.push_str("\n[more files than shown; narrow the pattern or the path]");
    }
    Ok(out)
}

/// `search_files`: a regular expression over file contents, `.gitignore` respected.
pub async fn search(machine: &dyn Machine, input: &Value) -> Result<String, String> {
    let output = match input.get("output").and_then(Value::as_str) {
        None | Some("content") => SearchOutput::Content,
        Some("files") => SearchOutput::Files,
        Some("count") => SearchOutput::Count,
        Some(_) => return Err("`output` is `content`, `files` or `count`".to_owned()),
    };
    let op = FilesOp::Search {
        path: path_or_here(input).to_owned(),
        pattern: text(input, "pattern")?.to_owned(),
        glob: input.get("glob").and_then(Value::as_str).map(str::to_owned),
        ignore_case: flag(input, "ignore_case"),
        context_lines: number(input, "context_lines")?.unwrap_or(0).min(10),
        output,
        limit: number(input, "limit")?.unwrap_or(200).clamp(1, 2000),
    };
    let FilesDone::Search { matches, truncated } = files_done(machine, op).await.map_err(exec)?
    else {
        return Err("the machine answered another operation".to_owned());
    };
    let mut out = matches.join("\n");
    if out.is_empty() {
        out.push_str("(no match)");
    }
    if truncated {
        out.push_str("\n[more results than shown; narrow the pattern, the glob or the path]");
    }
    Ok(out)
}

fn replacements(entry: &Value) -> Result<Vec<Replacement>, String> {
    let one = |value: &Value| -> Result<Replacement, String> {
        Ok(Replacement {
            old: text(value, "old")?.to_owned(),
            new: text(value, "new")?.to_owned(),
            replace_all: flag(value, "replace_all"),
        })
    };
    match entry.get("replacements").and_then(Value::as_array) {
        Some(list) => list.iter().map(one).collect(),
        None => Ok(vec![one(entry)?]),
    }
}

/// The edits an `edit_file` call asks for: a list in `files`, or one file in the call itself.
fn requested(input: &Value) -> Result<Vec<(String, Vec<Replacement>)>, String> {
    let entries: Vec<&Value> = match input.get("files").and_then(Value::as_array) {
        Some(list) => list.iter().collect(),
        None => vec![input],
    };
    entries
        .into_iter()
        .map(|entry| Ok((text(entry, "path")?.to_owned(), replacements(entry)?)))
        .collect()
}

async fn apply(
    machine: &dyn Machine,
    slot: &MachineSlot,
    edits: Vec<FileEdit>,
) -> Result<String, String> {
    let FilesDone::Edit { files } = files_done(
        machine,
        FilesOp::Edit {
            files: edits.clone(),
        },
    )
    .await
    .map_err(exec)?
    else {
        return Err("the machine answered another operation".to_owned());
    };
    let mut out = String::new();
    for (asked, done) in edits.iter().zip(&files) {
        slot.set_version(&asked.path, done.mtime_ms);
        if done.created {
            let _ = writeln!(out, "created {}", asked.path);
        } else {
            let _ = writeln!(out, "edited {} ({} replaced)", asked.path, done.replaced);
        }
    }
    Ok(out)
}

/// `edit_file`: exact replacements in one or several files, all or nothing. A file this run read
/// is changed only if it still has the version that was read.
pub async fn edit(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let edits = requested(input)?
        .into_iter()
        .map(|(path, replacements)| FileEdit {
            expected_mtime_ms: slot.version(&path),
            path,
            create: None,
            replacements,
        })
        .collect();
    apply(machine, slot, edits).await
}

/// `apply_patch`: a unified diff, all or nothing.
pub async fn apply_patch(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let mut edits = patch::edits(text(input, "patch")?)?;
    for file in &mut edits {
        file.expected_mtime_ms = slot.version(&file.path);
    }
    apply(machine, slot, edits).await
}

/// `write_file`: the whole text of a file. A file this run read is replaced only if it still has
/// the version that was read.
pub async fn write(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let path = text(input, "path")?;
    let content = text(input, "content")?;
    match slot.version(path) {
        Some(version) => {
            let op = FilesOp::Write {
                path: path.to_owned(),
                content: content.to_owned(),
                expected_mtime_ms: Some(version),
            };
            let FilesDone::Write { mtime_ms, .. } = files_done(machine, op).await.map_err(exec)?
            else {
                return Err("the machine answered another operation".to_owned());
            };
            slot.set_version(path, mtime_ms);
        }
        None => machine.write_file(path, content).await.map_err(exec)?,
    }
    Ok(format!("wrote {} bytes to {path}", content.len()))
}
