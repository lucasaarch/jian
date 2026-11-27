#![allow(clippy::print_stdout)]

//! The gateway runtime shared by the `jian` command and the Tauri desktop host.

pub mod browser_flags;
pub mod debug_jobs;
pub mod desktop;
pub mod owner_token;
