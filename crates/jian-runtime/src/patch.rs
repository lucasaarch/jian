//! A unified diff as exact replacements, so a patch is applied by the machine's own atomic edit
//! (the same on the gateway's machine and a connected one) instead of by a second applier.
//!
//! Each hunk becomes "replace these old lines with these new ones". That needs the old lines to
//! be found exactly once, so line numbers in the header are ignored and a hunk that matches in
//! two places is refused with the usual count. A patch that deletes a whole file is refused: use
//! the shell for that.

use jian_protocol::machine::{FileEdit, Replacement};

/// What the lines after a `@@` header say, up to the counts the header promised.
struct Hunk {
    old: Vec<String>,
    new: Vec<String>,
    old_ends_line: bool,
    new_ends_line: bool,
}

fn name(header: &str) -> &str {
    header.split('\t').next().unwrap_or(header).trim()
}

/// The number after `-` or `+` in `@@ -12,3 +12,4 @@`, 1 when the header omits the count.
fn count(header: &str, sign: char) -> usize {
    header
        .split_whitespace()
        .find(|part| part.starts_with(sign))
        .and_then(|part| part[1..].split(',').nth(1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(1)
}

fn join(lines: &[String], ends_line: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut text = lines.join("\n");
    if ends_line {
        text.push('\n');
    }
    text
}

fn hunk<'a>(header: &str, lines: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>) -> Hunk {
    let (mut want_old, mut want_new) = (count(header, '-'), count(header, '+'));
    let mut hunk = Hunk {
        old: Vec::new(),
        new: Vec::new(),
        old_ends_line: true,
        new_ends_line: true,
    };
    let mut last = ' ';
    while want_old > 0 || want_new > 0 || lines.peek().is_some_and(|l| l.starts_with('\\')) {
        let Some(line) = lines.next() else { break };
        let (kind, text) = match line.chars().next() {
            Some(kind @ (' ' | '-' | '+' | '\\')) => (kind, &line[1..]),
            // A context line whose single space an editor stripped.
            _ => (' ', line),
        };
        match kind {
            ' ' => {
                hunk.old.push(text.to_owned());
                hunk.new.push(text.to_owned());
                want_old = want_old.saturating_sub(1);
                want_new = want_new.saturating_sub(1);
            }
            '-' => {
                hunk.old.push(text.to_owned());
                want_old = want_old.saturating_sub(1);
            }
            '+' => {
                hunk.new.push(text.to_owned());
                want_new = want_new.saturating_sub(1);
            }
            // "\ No newline at end of file": the line before it has no line end.
            _ => {
                if last != '+' {
                    hunk.old_ends_line = false;
                }
                if last != '-' {
                    hunk.new_ends_line = false;
                }
                continue;
            }
        }
        last = kind;
    }
    hunk
}

/// The edits a patch makes, one per file, or why it cannot be read.
pub fn edits(diff: &str) -> Result<Vec<FileEdit>, String> {
    let mut lines = diff.lines().peekable();
    let mut files: Vec<FileEdit> = Vec::new();
    while let Some(line) = lines.next() {
        let Some(old_name) = line.strip_prefix("--- ") else {
            continue;
        };
        let Some(new_name) = lines.next().and_then(|l| l.strip_prefix("+++ ")) else {
            return Err("a `---` line must be followed by a `+++` line".to_owned());
        };
        let (old_name, new_name) = (name(old_name), name(new_name));
        if new_name == "/dev/null" {
            return Err(format!(
                "the patch deletes {old_name}; apply_patch does not delete files, use the shell"
            ));
        }
        let creates = old_name == "/dev/null";
        // `a/x` and `b/x` are git's prefixes when both sides have them.
        let git_style = new_name.starts_with("b/") && (creates || old_name.starts_with("a/"));
        let path = if git_style { &new_name[2..] } else { new_name };
        let mut edit = FileEdit {
            path: path.to_owned(),
            create: creates.then(String::new),
            expected_mtime_ms: None,
            replacements: Vec::new(),
        };
        while lines.peek().is_some_and(|l| l.starts_with("@@")) {
            let header = lines.next().unwrap_or_default();
            let hunk = hunk(header, &mut lines);
            if let Some(content) = edit.create.as_mut() {
                content.push_str(&join(&hunk.new, hunk.new_ends_line));
            } else if hunk.old.is_empty() {
                return Err(format!(
                    "a hunk of {path} has no context or removed line to find its place by; \
                     include at least one unchanged line"
                ));
            } else {
                edit.replacements.push(Replacement {
                    old: join(&hunk.old, hunk.old_ends_line),
                    new: join(&hunk.new, hunk.new_ends_line),
                    replace_all: false,
                });
            }
        }
        if edit.create.is_none() && edit.replacements.is_empty() {
            return Err(format!("the patch has no hunk for {path}"));
        }
        files.push(edit);
    }
    if files.is_empty() {
        return Err(
            "no file found: a patch is `--- a/file`, `+++ b/file` and `@@` hunks".to_owned(),
        );
    }
    Ok(files)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn a_hunk_becomes_the_lines_it_finds_and_the_lines_that_replace_them() {
        let patch = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
        let edits = edits(patch).unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].path, "src/a.txt");
        assert_eq!(edits[0].replacements[0].old, "one\ntwo\nthree\n");
        assert_eq!(edits[0].replacements[0].new, "one\nTWO\nthree\n");
    }

    #[test]
    fn a_removed_line_that_looks_like_a_file_header_is_still_a_line() {
        let patch = "--- x\n+++ x\n@@ -1,2 +1,1 @@\n keep\n--- not a header\n";
        let edits = edits(patch).unwrap();
        assert_eq!(edits[0].replacements[0].old, "keep\n-- not a header\n");
    }

    #[test]
    fn a_new_file_and_a_deletion() {
        let created = edits("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n").unwrap();
        assert_eq!(created[0].create.as_deref(), Some("a\nb\n"));
        assert!(edits("--- a/n.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n").is_err());
        assert!(edits("not a patch").is_err());
    }
}
