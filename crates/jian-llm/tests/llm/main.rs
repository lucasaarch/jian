//! `jian-llm` against fake providers: the wire formats, then retry, errors and cancelling.

// clippy.toml excuses `#[test]` bodies, not the helpers they call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod subscription;
mod support;
mod transport;
mod wire;
