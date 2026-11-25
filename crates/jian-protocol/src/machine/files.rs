use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesOp {
    /// Reads a text file.
    Read {
        /// Absolute path of the file.
        path: String,
        /// The most bytes to read; more is refused as `too-large`.
        max_bytes: u64,
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
        /// The glob, as `**/*.rs`.
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
    /// The operation's name alone, for matching an answer to its request.
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

/// The name of a [`FilesOp`] without its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilesOpName {
    /// [`FilesOp::Read`].
    Read,
    /// [`FilesOp::Write`].
    Write,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FilesAnswer {
    /// The operation succeeded.
    Done(FilesDone),
    /// The operation was refused or failed.
    Failed(FilesFailure),
}

/// A refused or failed operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListEntry {
    /// The entry's file name.
    pub name: String,
    /// What it is.
    pub kind: EntryKind,
}

/// A successful answer; `op` repeats the request's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesDone {
    /// The file's text.
    Read {
        /// The content.
        text: String,
        /// The modification time, in milliseconds since the epoch.
        mtime_ms: f64,
        /// The file's size, in bytes.
        bytes: u64,
    },
    /// The file was written.
    Write {
        /// The new modification time, in milliseconds since the epoch.
        mtime_ms: f64,
        /// The bytes written.
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
        bytes: u64,
    },
    /// The file was written from base64.
    WriteBytes {
        /// The bytes written.
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
