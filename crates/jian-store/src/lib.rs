//! Persistence through sqlx on Postgres: one the gateway embeds and runs itself, or an external
//! one named by a connection URL.
//!
//! It owns the connection pool and the embedded server's life (data directory, credentials, start
//! and stop). The schema, the migrations and every query, with a schema and a role per tenant,
//! come next; this crate will hand the rest of the workspace `jian-core` types, never rows. It
//! does not decide anything about the domain (that is `jian-core`), call a model or run a command,
//! and it reads no environment: the binary passes the data directory and the URL in.
//! `jian-runtime` and `jian-server` talk to it.

mod database;
pub mod embedded;
mod error;

pub use database::{Database, DatabaseHealth, DatabaseSource, DatabaseUrl};
pub use error::StoreError;
