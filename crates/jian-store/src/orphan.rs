//! A Postgres that outlived the gateway that started it.
//!
//! The embedded server is a child process, not a thread: when the gateway gets `SIGKILL` (an OOM
//! kill, `cargo watch` restarting it, a crash) nothing stops it, and it keeps the data directory.
//! The next start then fails on `postmaster.pid` ("another server might be running"). Here the
//! next start looks at that file first: a server of this very directory is stopped cleanly and
//! reused, and a file left by a process that is gone is deleted.
//!
//! The only process this ever signals is one whose command line names this data directory, so a
//! recycled pid, or another cluster, is never touched.
//!
//! Unix only: on Windows `pg_ctl` tells a live server from a stale file by itself, and a desktop
//! gateway stopped abruptly is not the case this covers.

use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

use crate::StoreError;

/// How long `pg_ctl stop` waits for the server to finish, in seconds. A fast shutdown only
/// checkpoints, so this is generous.
const STOP_WAIT_SECONDS: &str = "60";

/// Gets `pgdata` ready to be started: stops a live server of this directory and removes a stale
/// `postmaster.pid`. Does nothing when there is no such file.
///
/// `pg_ctl` is the one of the unpacked server, so it is the version that wrote the cluster.
/// Blocking: it runs once at boot, before anything else needs the runtime.
pub(crate) fn clear(pgdata: &Path, pg_ctl: &Path) -> Result<(), StoreError> {
    let pid_file = pgdata.join("postmaster.pid");
    let text = match fs::read_to_string(&pid_file) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(StoreError::Io {
                path: pid_file,
                source,
            });
        }
    };
    // The first line is the postmaster's pid. A file with no usable pid cannot name a server.
    let Some(pid) = text
        .lines()
        .next()
        .and_then(|line| line.trim().parse::<u32>().ok())
    else {
        tracing::warn!("removing an unreadable postmaster.pid");
        return remove(&pid_file);
    };

    match inspect(pid) {
        Inspected::Absent => {
            tracing::warn!(pid, "removing postmaster.pid left by a server that is gone");
            remove(&pid_file)
        }
        Inspected::Running { args } if names_directory(&args, pgdata) => {
            tracing::warn!(
                pid,
                "a Postgres from an earlier run is still up; stopping it"
            );
            stop(pid, pgdata, pg_ctl)
        }
        // The pid now belongs to something else, so the server that wrote it is gone, and
        // Postgres would still take the file for a live server.
        Inspected::Running { .. } => {
            tracing::warn!(
                pid,
                "removing postmaster.pid: the pid is another process now"
            );
            remove(&pid_file)
        }
        Inspected::Unknown => {
            tracing::warn!(pid, "cannot tell what runs under the pid in postmaster.pid");
            Ok(())
        }
    }
}

/// What a pid is, as far as this module needs to know.
enum Inspected {
    /// No process, or a zombie: a zombie postmaster is dead, only its parent has not collected it
    /// (in a container whose PID 1 does not reap, that is for good).
    Absent,
    /// A live process, with its command line.
    Running { args: String },
    /// The system would not say. Nothing is touched.
    Unknown,
}

/// Linux: `/proc` answers without another program, which a slim container may not have.
#[cfg(target_os = "linux")]
fn inspect(pid: u32) -> Inspected {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Inspected::Absent,
        Err(_) => return Inspected::Unknown,
    };
    // `pid (comm) S ...`: the command name may hold spaces and parentheses, so the state is the
    // first field after the last `)`.
    let state = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().next());
    if matches!(state, Some("Z" | "X")) {
        return Inspected::Absent;
    }
    match fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(bytes) => Inspected::Running {
            args: String::from_utf8_lossy(&bytes).replace('\0', " "),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Inspected::Absent,
        Err(_) => Inspected::Unknown,
    }
}

/// macOS and the other Unixes have no `/proc`; `ps` is always there.
#[cfg(not(target_os = "linux"))]
fn inspect(pid: u32) -> Inspected {
    let Ok(output) = Command::new("ps")
        .args(["-o", "stat=,args=", "-p", &pid.to_string()])
        .output()
    else {
        return Inspected::Unknown;
    };
    // `ps -p` exits 1 and prints nothing for a pid that does not exist.
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.trim_start();
    if line.is_empty() {
        return Inspected::Absent;
    }
    let (state, args) = line.split_once(' ').unwrap_or((line, ""));
    if state.starts_with('Z') {
        Inspected::Absent
    } else {
        Inspected::Running {
            args: args.to_owned(),
        }
    }
}

/// True when a postmaster's command line names this data directory. `pg_ctl start` passes it as
/// `-D <dir>`; it may be written through a symlink, so the resolved path counts as well.
fn names_directory(args: &str, pgdata: &Path) -> bool {
    let is_postgres = args.contains("postgres");
    let named = |dir: &Path| args.contains(&dir.display().to_string());
    is_postgres && (named(pgdata) || fs::canonicalize(pgdata).is_ok_and(|real| named(&real)))
}

/// A fast shutdown of the server of `pgdata`: sessions end and the cluster is checkpointed, so
/// the next start has no crash recovery to do.
fn stop(pid: u32, pgdata: &Path, pg_ctl: &Path) -> Result<(), StoreError> {
    let output = Command::new(pg_ctl)
        .args(["stop", "-m", "fast", "-w", "-t", STOP_WAIT_SECONDS, "-D"])
        .arg(pgdata)
        .output()
        .map_err(|source| StoreError::Io {
            path: pg_ctl.to_path_buf(),
            source,
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(StoreError::OrphanedServer {
        pid,
        pgdata: pgdata.to_path_buf(),
        reason: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}

fn remove(pid_file: &Path) -> Result<(), StoreError> {
    match fs::remove_file(pid_file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(StoreError::Io {
            path: pid_file.to_path_buf(),
            source,
        }),
    }
}
