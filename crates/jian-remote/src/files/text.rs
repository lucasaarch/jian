//! Reading and writing one file, on its real path. Blocking: run off the async threads.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jian_protocol::machine::{FILES_MAX_TEXT, FilesDone, FilesProblem};

use super::Problem;

/// The largest raw file whose base64 fits a read's or a write's text limit, in bytes.
const MAX_RAW_BYTES: u64 = (FILES_MAX_TEXT as u64 / 4) * 3;
/// A file is binary when a NUL shows in its first this many bytes, as git and ripgrep decide.
pub const BINARY_SNIFF: usize = 8000;

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0)
}

/// Milliseconds since the epoch, with the fraction the file system keeps: what a write must name
/// to replace what was read.
pub fn mtime_ms(meta: &Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_nanos() as f64 / 1e6)
}

fn regular_file(real: &Path, max_bytes: u64) -> Result<Metadata, Problem> {
    let meta = std::fs::metadata(real)?;
    if !meta.is_file() {
        return Err(Problem::new(
            FilesProblem::NotFile,
            "That path is not a file.",
        ));
    }
    if meta.len() > max_bytes {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            format!(
                "The file has {} bytes, more than the {max_bytes} this read allows.",
                meta.len()
            ),
        ));
    }
    Ok(meta)
}

/// A regular file, never read past `max_bytes`: the size the file system gives is no limit, as a
/// file under /proc says 0 and can yield gigabytes. O_NONBLOCK keeps a kernel file with nothing
/// to say yet (/proc/kmsg) from holding the task; it does nothing to a file on disk.
fn read_within(real: &Path, max_bytes: u64) -> Result<Vec<u8>, Problem> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = options.open(real)?;
    if !file.metadata()?.is_file() {
        return Err(Problem::new(
            FilesProblem::NotFile,
            "That path is not a file.",
        ));
    }
    let mut buffer = Vec::new();
    let read = file
        .take(max_bytes + 1)
        .read_to_end(&mut buffer)
        .or_else(|error| match error.kind() {
            ErrorKind::WouldBlock => Ok(buffer.len()),
            _ => Err(error),
        })?;
    if read as u64 > max_bytes {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            format!("The file has more than the {max_bytes} bytes this read allows."),
        ));
    }
    Ok(buffer)
}

pub fn read_text(real: &Path, max_bytes: u64) -> Result<FilesDone, Problem> {
    let meta = regular_file(real, max_bytes)?;
    let buffer = read_within(real, max_bytes)?;
    if is_binary(&buffer) {
        return Err(Problem::new(FilesProblem::Binary, "The file is binary."));
    }
    let text = String::from_utf8_lossy(&buffer).into_owned();
    if text.chars().count() > FILES_MAX_TEXT {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            format!(
                "The file has {} bytes, more than a result can carry.",
                buffer.len()
            ),
        ));
    }
    Ok(FilesDone::Read {
        text,
        mtime_ms: mtime_ms(&meta),
        bytes: buffer.len() as u64,
    })
}

pub fn read_bytes(real: &Path, max_bytes: u64) -> Result<FilesDone, Problem> {
    let meta = regular_file(real, max_bytes)?;
    if meta.len() > MAX_RAW_BYTES {
        return Err(Problem::new(
            FilesProblem::TooLarge,
            format!(
                "The file has {} bytes, more than a result can carry.",
                meta.len()
            ),
        ));
    }
    let buffer = read_within(real, max_bytes.min(MAX_RAW_BYTES))?;
    Ok(FilesDone::ReadBytes {
        base64: STANDARD.encode(&buffer),
        bytes: buffer.len() as u64,
    })
}

/// What is at `real` now, or `None`. A folder is refused here.
fn current(real: &Path) -> Result<Option<Metadata>, Problem> {
    match std::fs::metadata(real) {
        Ok(meta) if meta.is_file() => Ok(Some(meta)),
        Ok(_) => Err(Problem::new(
            FilesProblem::NotFile,
            "That path is not a file.",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn mode_of(meta: &Metadata) -> Option<u32> {
    Some(std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o7777)
}

#[cfg(not(unix))]
fn mode_of(_meta: &Metadata) -> Option<u32> {
    None
}

/// Replaces a file all at once: the data goes to a temporary file in the same folder, so the
/// rename is atomic on one file system and a reader sees the old file or the new, never half. The
/// replaced file's mode is kept. A failure leaves no temporary file behind.
pub fn write_atomic(target: &Path, data: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    // Not named after the target: a name near the 255-byte limit would leave no room for a suffix.
    let folder = target.parent().unwrap_or(Path::new("/"));
    let temp = folder.join(format!(".jian-write-{}.tmp", crate::random::hex(6)));
    let written = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file: File = options.open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            // The mode passes through the umask on creation; the replaced file's bits are exact.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        std::fs::rename(&temp, target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

pub fn write_text(
    real: &Path,
    content: &str,
    expected_mtime_ms: Option<f64>,
) -> Result<FilesDone, Problem> {
    let before = current(real)?;
    match (&before, expected_mtime_ms) {
        (Some(_), None) => {
            return Err(Problem::new(
                FilesProblem::Exists,
                "The file already exists; read it before changing it.",
            ));
        }
        (Some(meta), Some(expected)) if mtime_ms(meta) != expected => {
            return Err(Problem::new(
                FilesProblem::Changed,
                "The file changed since it was read.",
            ));
        }
        (None, Some(_)) => {
            return Err(Problem::new(
                FilesProblem::Changed,
                "The file no longer exists.",
            ));
        }
        _ => {}
    }
    if let Some(parent) = real.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(real, content.as_bytes(), before.as_ref().and_then(mode_of))?;
    let after = std::fs::metadata(real)?;
    Ok(FilesDone::Write {
        mtime_ms: mtime_ms(&after),
        bytes: content.len() as u64,
        created: before.is_none(),
    })
}

pub fn write_bytes(real: &Path, base64: &str) -> Result<FilesDone, Problem> {
    let before = current(real)?;
    let data = STANDARD
        .decode(base64)
        .map_err(|_| Problem::new(FilesProblem::Failed, "That base64 does not decode."))?;
    if let Some(parent) = real.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(real, &data, before.as_ref().and_then(mode_of))?;
    Ok(FilesDone::WriteBytes {
        bytes: data.len() as u64,
    })
}
