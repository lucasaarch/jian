//! Persistence through sqlx: SQLite when self-hosted, Postgres on the Cloud.
//!
//! It owns the schema, the migrations and every query, and hands the rest of the workspace
//! `jian-core` types, never rows. Every row carries a `tenant_id`, and no query runs without one.
//! It does not decide anything about the domain (that is `jian-core`), call a model or run a
//! command. `jian-runtime` and `jian-server` talk to it.
