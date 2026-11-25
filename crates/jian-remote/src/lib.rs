//! Jian Remote's worker: keeps one machine connected to its gateway over a WebSocket and runs
//! what it is sent — shell commands, file operations, port forwards, Computer Use and its own
//! update. The CLI in `bins/jian-remote` installs it as a service and runs it.

pub mod clock;
pub mod computer;
pub mod ends;
pub mod files;
pub mod forwards;
pub mod log;
pub mod mask;
pub mod outgoing;
pub mod process;
pub mod random;
pub mod result;
pub mod shell;
pub mod state;
pub mod system;
pub mod transport;
pub mod update;
pub mod worker;
