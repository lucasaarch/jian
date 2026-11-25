//! The import of the old Node Jian: its owner, secrets, machines and phones, into the one tenant
//! of a self-hosted install.
//!
//! It reads the old data (never writes it), maps what has a table in the core today and records,
//! per domain, how it went (`platform.imports`, kept by `jian-store`). It has no HTTP, reads no
//! environment and spawns nothing but the scratch Postgres of a dump: `bins/jian` decides when it
//! runs and from where. It does not create a path for the Cloud: there the data of a person
//! arrives through the account they sign in with.
//!
//! # Sources
//!
//! - [`Source::Postgres`]: the old gateway's own database (a server install with `DATABASE_URL`).
//!   Read through one `REPEATABLE READ` transaction opened `READ ONLY`, on a session whose default
//!   is read-only too.
//! - [`Source::Dump`]: a SQL file made by `pg_dump` from the old desktop app's `PGlite` database.
//!   It is loaded with `psql` into a scratch embedded Postgres (a directory of its own, removed
//!   after) and read from there like the first.
//!
//! # The `PGlite` bridge
//!
//! The desktop app's database is `PGlite`: Postgres 18 compiled to 32-bit WebAssembly. Its data
//! directory is not a native cluster (`pg_control` is 32-bit and `USE_FLOAT8_BYVAL` differs), so
//! a native Postgres refuses it, and running the WebAssembly here would need an Emscripten
//! runtime in Rust. The core instead takes a dump. The old app (which already ships Node) makes
//! it with `@electric-sql/pglite-tools`:
//!
//! ```js
//! import { `PGlite` } from '@electric-sql/pglite';
//! import { pgDump } from '@electric-sql/pglite-tools/pg_dump';
//! const db = new `PGlite`('<userData>/gateway/database');
//! const dump = await pgDump({ pg: db, args: ['--no-owner', '--no-privileges'] });
//! await fs.writeFile('<userData>/gateway/export.sql', await dump.text());
//! ```
//!
//! `jian` looks for that `export.sql` next to the old `database` folder. Producing it is the
//! desktop migration's job (LUC-94); until then a person can run the snippet by hand.
//!
//! # Domains, markers and repeating
//!
//! Each [`Domain`] has a marker. [`Importer::run`] with [`Scope::Pending`] takes the domains not
//! `done`; with [`Scope::All`] every one. A row is written in its own transaction and only when
//! it is not already there (by its old id, or its owner name for a secret), so a run that stops
//! anywhere and runs again finishes without duplicating, and a row someone changed since is not
//! overwritten. A domain that cannot go on (no key, no address) is `skipped` and tried again
//! once the missing piece is given.
//!
//! # Not imported
//!
//! Conversations, agents, memories, skills, schedules, channels and the rest have no
//! table in the core yet. Each run lists those tables of the old database with their rows
//! ([`ImportReport::not_imported`]); the issue that creates a domain's table adds its import
//! here.

mod error;
mod machines;
mod outcome;
mod owner;
mod providers;
mod reader;
mod run;
mod secrets;
mod source;

pub use error::ImportError;
pub use reader::{LegacyReader, LegacyTable};
pub use run::{Domain, DomainReport, ImportOptions, ImportReport, Importer, Scope};
pub use source::Source;
