use serde::{Deserialize, Serialize};

/// The largest file a read may ask for, as the gateway's local file tools allow.
pub const FILES_MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
/// The largest side of a `git-file` answer, in bytes.
pub const FILES_MAX_GIT_BYTES: u64 = 500_000;
/// Longest text a write carries, and a read returns, in characters.
pub const FILES_MAX_TEXT: usize = 400_000;
/// Total characters of `find` paths, and of `search` lines, in one answer.
pub const FILES_MAX_FIND_CHARS: usize = 200_000;
pub const FILES_MAX_SEARCH_CHARS: usize = 60_000;

/// One file operation, run with the file system and git, never a shell. Every path is absolute
/// on the machine; the worker checks the shape again, as the gateway's word is not proof.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesOp {
    Read {
        path: String,
        max_bytes: u64,
    },
    Write {
        path: String,
        content: String,
        /// The mtime the writer read, in ms; null means the file must not exist yet. A file that
        /// changed since is refused as `changed`.
        expected_mtime_ms: Option<f64>,
    },
    List {
        path: String,
        limit: usize,
    },
    Find {
        path: String,
        pattern: String,
        limit: usize,
    },
    Search {
        path: String,
        pattern: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        glob: Option<String>,
        ignore_case: bool,
        context_lines: usize,
        output: SearchOutput,
        limit: usize,
    },
    ReadBytes {
        path: String,
        max_bytes: u64,
    },
    WriteBytes {
        path: String,
        base64: String,
    },
    GitStatus {
        root: String,
        /// Also diff the working tree against this commit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        against: Option<String>,
    },
    GitFile {
        root: String,
        /// Relative to `root`, never leaving it.
        path: String,
        /// A 40-hex commit, or `HEAD`.
        against: String,
        max_bytes: u64,
    },
    MergeBase {
        root: String,
        base: String,
    },
}

impl FilesOp {
    pub fn name(&self) -> FilesOpName {
        match self {
            Self::Read { .. } => FilesOpName::Read,
            Self::Write { .. } => FilesOpName::Write,
            Self::List { .. } => FilesOpName::List,
            Self::Find { .. } => FilesOpName::Find,
            Self::Search { .. } => FilesOpName::Search,
            Self::ReadBytes { .. } => FilesOpName::ReadBytes,
            Self::WriteBytes { .. } => FilesOpName::WriteBytes,
            Self::GitStatus { .. } => FilesOpName::GitStatus,
            Self::GitFile { .. } => FilesOpName::GitFile,
            Self::MergeBase { .. } => FilesOpName::MergeBase,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilesOpName {
    Read,
    Write,
    List,
    Find,
    Search,
    ReadBytes,
    WriteBytes,
    GitStatus,
    GitFile,
    MergeBase,
}

/// What a search prints: matching lines (`rg -n`), the files with a match, or a count per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchOutput {
    Content,
    Files,
    Count,
}

/// Why a file operation was refused, in words the agent can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilesProblem {
    Missing,
    NotFile,
    NotDirectory,
    Binary,
    TooLarge,
    Changed,
    Exists,
    /// The path is one the worker keeps to itself (its credentials), or leaves a repository.
    Refused,
    NotRepository,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FilesAnswer {
    Done(FilesDone),
    Failed(FilesFailure),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesFailure {
    /// The request's, so the gateway can match the two.
    pub op: FilesOpName,
    pub problem: FilesProblem,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListEntry {
    pub name: String,
    pub kind: EntryKind,
}

/// A successful answer; `op` repeats the request's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesDone {
    Read {
        text: String,
        mtime_ms: f64,
        bytes: u64,
    },
    Write {
        mtime_ms: f64,
        bytes: u64,
        created: bool,
    },
    List {
        entries: Vec<ListEntry>,
        truncated: bool,
    },
    Find {
        files: Vec<String>,
        truncated: bool,
    },
    /// Lines as `rg --no-heading` prints them.
    Search {
        matches: Vec<String>,
        truncated: bool,
    },
    ReadBytes {
        base64: String,
        bytes: u64,
    },
    WriteBytes {
        bytes: u64,
    },
    /// Raw `git status --porcelain=v1 -z` and `git diff --name-status -z`, for the gateway's
    /// parsers.
    GitStatus {
        top: String,
        filters: Vec<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
    },
    GitFile {
        before: Option<String>,
        after: Option<String>,
        #[serde(default)]
        binary: bool,
    },
    MergeBase {
        sha: String,
    },
}
