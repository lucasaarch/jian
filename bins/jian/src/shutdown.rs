//! The signals that ask the gateway to stop.

use std::io;

/// Listens for the signals that mean "stop": SIGINT and SIGTERM on Unix (`docker stop` and
/// systemd send SIGTERM), Ctrl-C on Windows.
///
/// Built before the database starts: a signal that arrives during a slow first boot is kept and
/// seen by [`Shutdown::wait`], instead of killing the process with the server half started.
pub struct Shutdown {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
}

impl Shutdown {
    /// Registers the handlers.
    pub fn install() -> io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self {
                interrupt: signal(SignalKind::interrupt())?,
                terminate: signal(SignalKind::terminate())?,
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {})
        }
    }

    /// Returns when the first stop signal arrives.
    pub async fn wait(&mut self) {
        #[cfg(unix)]
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
        }
        #[cfg(not(unix))]
        {
            // If the handler cannot be installed there is nothing to wait for, so stop.
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}
