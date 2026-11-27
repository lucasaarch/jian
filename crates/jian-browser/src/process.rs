//! The browser's program: started in its own process group, and always collected.
//!
//! A browser is a tree (Chromium has a renderer, a GPU process and more). It is killed as a
//! group, so no helper outlives it, and it is waited for, so none is left as a zombie. If the
//! gateway drops the handle without stopping it (a panic, a shutdown), the kill still happens:
//! `kill_on_drop` for the program and a group signal in `Drop` for the rest.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;

use tokio::process::{Child, Command};

/// A running browser program.
pub(crate) struct Sidecar {
    child: Child,
    /// A scratch folder the program writes in (Chromium's profile). Deleted with the handle.
    _scratch: Option<tempfile::TempDir>,
}

impl Sidecar {
    /// Starts `binary` with `args` and `env`. Its output is discarded: it is read by nobody, and
    /// a full pipe would stop the program.
    pub(crate) fn spawn(
        binary: &Path,
        args: &[OsString],
        env: &[(&str, String)],
        scratch: Option<tempfile::TempDir>,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .envs(env.iter().map(|(k, v)| (*k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // A group of its own: a signal to the gateway's terminal does not reach it, and a kill
        // reaches all of it. Windows has no POSIX group; `kill_on_drop` ends the program there.
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn()?;
        Ok(Self {
            child,
            _scratch: scratch,
        })
    }

    /// Whether the program has already exited.
    pub(crate) fn exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// The process id, `None` once it was waited for.
    pub(crate) fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Kills the whole group and waits for the program: nothing is left behind.
    pub(crate) async fn stop(mut self) {
        #[cfg(unix)]
        self.kill_group();
        drop(self.child.kill().await);
        drop(self.child.wait().await);
    }

    // `id` is `None` once the program was waited for: then there is nothing to signal.
    #[cfg(unix)]
    fn kill_group(&self) {
        if let Some(pid) = self
            .child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(rustix::process::Pid::from_raw)
        {
            // Already gone is the same as killed.
            rustix::process::kill_process_group(pid, rustix::process::Signal::KILL).ok();
        }
    }
}

#[cfg(unix)]
impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill_group();
    }
}
