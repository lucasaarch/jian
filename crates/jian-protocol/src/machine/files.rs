use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The largest file a read may ask for, as the gateway's local file tools allow.
pub const FILES_MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
/// The largest side of a `git-file` answer, in bytes.
pub const FILES_MAX_GIT_BYTES: u64 = 500_000;
/// Longest text a write carries, and a read returns, in characters.
pub const FILES_MAX_TEXT: usize = 400_000;
/// Total characters of `find` paths, and of `search` lines, in one answer.
pub const FILES_MAX_FIND_CHARS: usize = 200_000;
/// The same budget for `search` lines.
pub const FILES_MAX_SEARCH_CHARS: usize = 60_000;

/// One file operation, run with the file system and git, never a shell. Every path is absolute
/// on the machine; the worker checks the shape again, as the gateway's word is not proof.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesOp {
    /// Reads a text file.
    Read {
        /// Absolute path of the file.
        path: String,
        /// The most bytes to read; more is refused as `too-large`.
        #[ts(type = "number")]
        max_bytes: u64,
        /// Return only lines from this one (1-based) on. Null reads from the start. With a
        /// range the text limit applies to the lines returned, not to the whole file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_line: Option<usize>,
        /// Return at most this many lines. Null reads to the end.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_lines: Option<usize>,
    },
    /// Writes a text file, creating its parents.
    Write {
        /// Absolute path of the file.
        path: String,
        /// The whole new text.
        content: String,
        /// The mtime the writer read, in ms; null means the file must not exist yet. A file that
        /// changed since is refused as `changed`.
        expected_mtime_ms: Option<f64>,
    },
    /// Changes one or more files by exact replacements, all or nothing: every file is checked
    /// and every replacement applied in memory first, and nothing is written if any step fails.
    /// The work runs on the machine, so no file crosses the wire.
    Edit {
        /// The files to change, each at most once.
        files: Vec<FileEdit>,
    },
    /// Lists a directory's entries.
    List {
        /// Absolute path of the directory.
        path: String,
        /// The most entries to return.
        limit: usize,
    },
    /// Finds files by glob under a directory.
    Find {
        /// Absolute path to search under.
        path: String,
        // A doc must not hold a star then a slash: ts-rs copies docs into JSDoc, where it ends the
        // comment and breaks the generated file (`tsc -p packages/protocol` catches it).
        /// The glob, as `src/*.rs`.
        pattern: String,
        /// The most paths to return.
        limit: usize,
    },
    /// Searches file contents for a regular expression.
    Search {
        /// Absolute path to search under.
        path: String,
        /// The regular expression.
        pattern: String,
        /// Only files whose path matches this glob.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        glob: Option<String>,
        /// Match without regard to case.
        ignore_case: bool,
        /// Lines of context around each match.
        context_lines: usize,
        /// What to print per match; see [`SearchOutput`].
        output: SearchOutput,
        /// The most lines, files or counts to return.
        limit: usize,
    },
    /// Reads a file of any kind as base64.
    ReadBytes {
        /// Absolute path of the file.
        path: String,
        /// The most bytes to read; more is refused as `too-large`.
        #[ts(type = "number")]
        max_bytes: u64,
    },
    /// Writes a file from base64.
    WriteBytes {
        /// Absolute path of the file.
        path: String,
        /// The file's bytes, base64 encoded.
        base64: String,
    },
    /// Reports a repository's working tree status.
    GitStatus {
        /// Absolute path inside the repository.
        root: String,
        /// Also diff the working tree against this commit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        against: Option<String>,
    },
    /// Reads one file as of a commit and as it is on disk.
    GitFile {
        /// Absolute path inside the repository.
        root: String,
        /// Relative to `root`, never leaving it.
        path: String,
        /// A 40-hex commit, or `HEAD`.
        against: String,
        /// The most bytes either side may weigh.
        #[ts(type = "number")]
        max_bytes: u64,
    },
    /// Finds the merge base of `HEAD` and `base`.
    MergeBase {
        /// Absolute path inside the repository.
        root: String,
        /// The branch or commit to compare with.
        base: String,
    },
}

impl FilesOp {
    /// Every path the operation names (a repository's `root` included), for a caller that
    /// resolves them before the operation runs.
    pub fn paths_mut(&mut self) -> Vec<&mut String> {
        match self {
            Self::Read { path, .. }
            | Self::Write { path, .. }
            | Self::List { path, .. }
            | Self::Find { path, .. }
            | Self::Search { path, .. }
            | Self::ReadBytes { path, .. }
            | Self::WriteBytes { path, .. } => vec![path],
            Self::GitStatus { root, .. }
            | Self::GitFile { root, .. }
            | Self::MergeBase { root, .. } => vec![root],
            Self::Edit { files } => files.iter_mut().map(|file| &mut file.path).collect(),
        }
    }

    /// The operation's name alone, for matching an answer to its request.
    pub fn name(&self) -> FilesOpName {
        match self {
            Self::Read { .. } => FilesOpName::Read,
            Self::Write { .. } => FilesOpName::Write,
            Self::Edit { .. } => FilesOpName::Edit,
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

/// What an edit does to one file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    /// Absolute path of the file.
    pub path: String,
    /// The whole text of a file that must not exist yet. Then `replacements` is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<String>,
    /// The mtime the editor read, in ms; the file is refused as `changed` if it differs. Null
    /// skips the check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_mtime_ms: Option<f64>,
    /// Applied in order, each to the text the one before left.
    #[serde(default)]
    pub replacements: Vec<Replacement>,
}

/// One exact substitution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
    /// The text to replace, exactly as in the file, not empty.
    pub old: String,
    /// What takes its place.
    pub new: String,
    /// Replace every occurrence; otherwise `old` must occur exactly once.
    #[serde(default)]
    pub replace_all: bool,
}

/// The name of a [`FilesOp`] without its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum FilesOpName {
    /// [`FilesOp::Read`].
    Read,
    /// [`FilesOp::Write`].
    Write,
    /// [`FilesOp::Edit`].
    Edit,
    /// [`FilesOp::List`].
    List,
    /// [`FilesOp::Find`].
    Find,
    /// [`FilesOp::Search`].
    Search,
    /// [`FilesOp::ReadBytes`].
    ReadBytes,
    /// [`FilesOp::WriteBytes`].
    WriteBytes,
    /// [`FilesOp::GitStatus`].
    GitStatus,
    /// [`FilesOp::GitFile`].
    GitFile,
    /// [`FilesOp::MergeBase`].
    MergeBase,
}

/// What a search prints: matching lines (`rg -n`), the files with a match, or a count per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum SearchOutput {
    /// Matching lines.
    Content,
    /// Paths of files with a match.
    Files,
    /// Match counts per file.
    Count,
}

/// Why a file operation was refused, in words the agent can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum FilesProblem {
    /// The path does not exist.
    Missing,
    /// The path is not a regular file.
    NotFile,
    /// The path is not a directory.
    NotDirectory,
    /// The file is not text.
    Binary,
    /// The file is over the size the operation allows.
    TooLarge,
    /// The file changed since the writer read it.
    Changed,
    /// The file exists and the write required it not to.
    Exists,
    /// The path is one the worker keeps to itself (its credentials), or leaves a repository.
    Refused,
    /// The path is not inside a git repository.
    NotRepository,
    /// Anything else; `message` says what.
    Failed,
}

/// The answer to a [`FilesOp`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FilesAnswer {
    /// The operation succeeded.
    Done(FilesDone),
    /// The operation was refused or failed.
    Failed(FilesFailure),
}

/// A refused or failed operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FilesFailure {
    /// The request's, so the gateway can match the two.
    pub op: FilesOpName,
    /// The class of problem.
    pub problem: FilesProblem,
    /// What happened, in words an agent can act on.
    pub message: String,
}

/// What a directory entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    /// A regular file.
    File,
    /// A directory.
    Directory,
    /// A symbolic link, not followed.
    Symlink,
    /// A device, socket or anything else.
    Other,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ListEntry {
    /// The entry's file name.
    pub name: String,
    /// What it is.
    pub kind: EntryKind,
}

fn first_line() -> usize {
    1
}

/// One file an edit changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EditedFile {
    /// The path, as the request gave it.
    pub path: String,
    /// The new modification time, in milliseconds since the epoch.
    pub mtime_ms: f64,
    /// The occurrences replaced; 0 for a file created.
    pub replaced: usize,
    /// The file did not exist before.
    pub created: bool,
}

/// A successful answer; `op` repeats the request's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesDone {
    /// The file's text.
    Read {
        /// The content.
        text: String,
        /// The modification time, in milliseconds since the epoch.
        mtime_ms: f64,
        /// The file's size, in bytes.
        #[ts(type = "number")]
        bytes: u64,
        /// The line the text starts at (1-based).
        #[serde(default = "first_line")]
        first_line: usize,
        /// The lines the whole file has.
        #[serde(default)]
        total_lines: usize,
    },
    /// The files were changed.
    Edit {
        /// One per file, in the request's order.
        files: Vec<EditedFile>,
    },
    /// The file was written.
    Write {
        /// The new modification time, in milliseconds since the epoch.
        mtime_ms: f64,
        /// The bytes written.
        #[ts(type = "number")]
        bytes: u64,
        /// The file did not exist before.
        created: bool,
    },
    /// The directory's entries.
    List {
        /// The entries, up to the request's limit.
        entries: Vec<ListEntry>,
        /// There were more than the limit or the size budget allowed.
        truncated: bool,
    },
    /// The paths that matched.
    Find {
        /// The paths found.
        files: Vec<String>,
        /// There were more than the limit or the size budget allowed.
        truncated: bool,
    },
    /// Lines as `rg --no-heading` prints them.
    Search {
        /// The lines found.
        matches: Vec<String>,
        /// There were more than the limit or the size budget allowed.
        truncated: bool,
    },
    /// The file's bytes.
    ReadBytes {
        /// The content, base64 encoded.
        base64: String,
        /// The file's size, in bytes.
        #[ts(type = "number")]
        bytes: u64,
    },
    /// The file was written from base64.
    WriteBytes {
        /// The bytes written.
        #[ts(type = "number")]
        bytes: u64,
    },
    /// Raw `git status --porcelain=v1 -z` and `git diff --name-status -z`, for the gateway's
    /// parsers.
    GitStatus {
        /// The repository's top-level directory.
        top: String,
        /// The pathspecs the status was limited to, relative to `top`.
        filters: Vec<String>,
        /// The raw status output.
        status: String,
        /// The raw diff output, when the request named a commit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
    },
    /// The two sides of one file.
    GitFile {
        /// The file at the commit; null when it did not exist there.
        before: Option<String>,
        /// The file on disk; null when it does not exist.
        after: Option<String>,
        /// The file is not text, so both sides are null.
        #[serde(default)]
        binary: bool,
    },
    /// The common ancestor.
    MergeBase {
        /// Its full commit id.
        sha: String,
    },
}
