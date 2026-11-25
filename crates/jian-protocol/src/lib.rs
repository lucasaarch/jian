//! The wire protocol between the gateway and a connected machine: the JSON messages of the
//! worker's WebSocket and the limits both sides keep.
//!
//! It is only types and the pure functions that frame them. It does no IO, holds no state and
//! knows nothing about how either side runs a task; `jian-remote` speaks it from the machine, and
//! the server will speak it from the gateway. Every type here is serialized as the TypeScript
//! gateway already expects, so a change that a peer of the other version would misread bumps
//! [`machine::PROTOCOL_VERSION`].

pub mod machine;
