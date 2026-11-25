//! Shell, files and sandboxes behind one `Executor` trait, so execution can leave the gateway.
//!
//! The same call runs on the gateway's own machine, in a sandbox, or on a connected machine
//! through `jian-remote`'s protocol (`jian-protocol`). It decides where a command runs, not
//! whether the agent may run it, and it knows nothing about turns or models. `jian-runtime` calls
//! it.
