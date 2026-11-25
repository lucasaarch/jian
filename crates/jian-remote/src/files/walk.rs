//! The search without ripgrep. Lines have the shape `rg --no-heading` prints. The regex crate
//! runs in linear time, so a pattern cannot hold the walk past its deadline; .gitignore is not
//! read. Hidden entries, binary files and files over the size limit are skipped as ripgrep skips
//! them, and a folder it cannot read is left out rather than ending the search.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::Instant;

use globset::{GlobBuilder, GlobMatcher};
use jian_protocol::machine::SearchOutput;
use regex::{Regex, RegexBuilder};

use super::find::SKIPPED;
use super::paths::is_refused;
use super::text::is_binary;
use crate::error::SearchError;

/// A file larger than this, in bytes, is skipped, as the read tool refuses it.
const MAX_SEARCHED_BYTES: u64 = 20 * 1024 * 1024;

pub struct WalkJob<'a> {
    pub pattern: &'a str,
    pub ignore_case: bool,
    pub glob: Option<&'a str>,
    pub context_lines: usize,
    pub output: SearchOutput,
    /// Stop after this many lines, or once they hold `chars` characters.
    pub limit: usize,
    pub chars: usize,
    pub roots: &'a [String],
    pub deadline: Instant,
}

pub struct Walked {
    pub lines: Vec<String>,
    pub truncated: bool,
    pub timed_out: bool,
}

struct Walker<'a> {
    job: &'a WalkJob<'a>,
    expression: Regex,
    glob: Option<(GlobMatcher, bool)>,
    lines: Vec<String>,
    chars: usize,
    full: bool,
    timed_out: bool,
    last: Option<(String, usize)>,
}

impl Walker<'_> {
    fn stopped(&mut self) -> bool {
        if !self.timed_out && Instant::now() >= self.job.deadline {
            self.timed_out = true;
        }
        self.full || self.timed_out
    }

    fn emit(&mut self, line: String) {
        self.chars += line.chars().count();
        self.lines.push(line);
        if self.lines.len() > self.job.limit || self.chars > self.job.chars {
            self.full = true;
        }
    }

    /// A group of lines that does not touch the one before is told apart by `--`.
    fn row(&mut self, file: &str, index: usize, hit: bool, text: &str) {
        let apart = self
            .last
            .as_ref()
            .is_some_and(|(before, line)| before != file || index > line + 1);
        if self.job.context_lines > 0 && apart {
            self.emit("--".into());
        }
        let mark = if hit { ':' } else { '-' };
        self.emit(format!("{file}{mark}{}{mark}{text}", index + 1));
        self.last = Some((file.to_owned(), index));
    }

    fn glob_matches(&self, relative: &str) -> bool {
        let Some((matcher, by_name)) = &self.glob else {
            return true;
        };
        let name = relative.rsplit('/').next().unwrap_or(relative);
        matcher.is_match(relative) || (*by_name && matcher.is_match(name))
    }

    fn search_file(&mut self, path: &Path) {
        let Ok(file) = std::fs::File::open(path) else {
            return;
        };
        if file
            .metadata()
            .map_or(true, |meta| meta.len() > MAX_SEARCHED_BYTES)
        {
            return;
        }
        let mut reader = BufReader::new(file.take(MAX_SEARCHED_BYTES));
        if reader.fill_buf().map_or(true, is_binary) {
            return;
        }
        let name = path.to_string_lossy().into_owned();
        let context = self.job.context_lines;
        let mut before: VecDeque<(usize, String)> = VecDeque::new();
        let mut after = 0;
        let mut hits = 0;
        let mut raw = Vec::new();
        for index in 0.. {
            if self.stopped() {
                break;
            }
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&raw);
            let text = text.strip_suffix('\n').unwrap_or(&text);
            let text = text.strip_suffix('\r').unwrap_or(text);
            let hit = self.expression.is_match(text);
            hits += usize::from(hit);
            match self.job.output {
                // A file listing needs one match; the rest of the file adds nothing.
                SearchOutput::Files if hit => break,
                SearchOutput::Content if hit => {
                    for (earlier, line) in std::mem::take(&mut before) {
                        self.row(&name, earlier, false, &line);
                    }
                    self.row(&name, index, true, text);
                    after = context;
                }
                SearchOutput::Content if after > 0 => {
                    self.row(&name, index, false, text);
                    after -= 1;
                }
                SearchOutput::Content if context > 0 => {
                    before.push_back((index, text.to_owned()));
                    if before.len() > context {
                        before.pop_front();
                    }
                }
                _ => {}
            }
        }
        if hits > 0 {
            match self.job.output {
                SearchOutput::Files => self.emit(name),
                SearchOutput::Count => self.emit(format!("{name}:{hits}")),
                SearchOutput::Content => {}
            }
        }
    }

    fn visit(&mut self, directory: &Path, relative: &str) {
        let Ok(read) = std::fs::read_dir(directory) else {
            return;
        };
        let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if self.stopped() {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIPPED.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            if is_refused(&path, self.job.roots) {
                continue;
            }
            let inner = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => self.visit(&path, &inner),
                Ok(kind) if kind.is_file() && self.glob_matches(&inner) => self.search_file(&path),
                _ => {}
            }
        }
    }
}

pub fn walk_search(target: &Path, job: &WalkJob) -> Result<Walked, SearchError> {
    let expression = RegexBuilder::new(job.pattern)
        .case_insensitive(job.ignore_case)
        .build()
        .map_err(|error| error.to_string())?;
    let glob = match job.glob {
        Some(glob) => Some((
            GlobBuilder::new(glob)
                .literal_separator(true)
                .build()
                .map_err(|error| error.to_string())?
                .compile_matcher(),
            !glob.contains('/'),
        )),
        None => None,
    };
    let mut walker = Walker {
        job,
        expression,
        glob,
        lines: Vec::new(),
        chars: 0,
        full: false,
        timed_out: false,
        last: None,
    };
    let meta = std::fs::metadata(target).map_err(|error| error.to_string())?;
    if meta.is_dir() {
        walker.visit(target, "");
    } else if !is_refused(target, job.roots) {
        walker.search_file(target);
    }
    Ok(Walked {
        truncated: walker.full,
        timed_out: walker.timed_out,
        lines: walker.lines,
    })
}
