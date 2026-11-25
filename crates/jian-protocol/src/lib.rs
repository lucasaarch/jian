//! The wire protocol between the gateway and a connected machine: the JSON messages of the
//! worker's WebSocket and the limits both sides keep.
//!
//! It is only types and the pure functions that frame them. It does no IO, holds no state and
//! knows nothing about how either side runs a task; `jian-remote` speaks it from the machine, and
//! the server will speak it from the gateway. Every type here is serialized as the TypeScript
//! gateway already expects, so a change that a peer of the other version would misread bumps
//! [`machine::PROTOCOL_VERSION`]. [`auth`] holds the bodies of the plain HTTP routes of sign-in and
//! users, which have no version of their own: they are additive.

pub mod auth;
pub mod client;
pub mod machine;
pub mod memories;
pub mod projects;
pub mod providers;
pub mod threads;
