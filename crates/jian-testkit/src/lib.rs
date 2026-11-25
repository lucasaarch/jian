//! The fixture behind the rule "tenant B sees and changes nothing of tenant A".
//!
//! Test code only (`publish = false`, listed under `[dev-dependencies]`): it is never linked into
//! a binary. It exists so `jian-store`, `jian-server` and the binary share one definition of "two
//! tenants with data of every kind" instead of each test file building its own.
//!
//! # The rule
//!
//! Every route, WebSocket request, event topic and job kind added to the gateway gets a test that
//! runs the same operation as tenant A and as tenant B, on the other's data, and shows it reads
//! and changes nothing. [`TwoTenants::crossings`] gives both directions, so a test written once
//! covers A against B and B against A.
//!
//! # Using it
//!
//! ```ignore
//! let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
//! let tenants = TwoTenants::seed(&test.db).await;
//! for (actor, victim) in tenants.crossings() {
//!     // `actor` asks for something of `victim`'s: it must find nothing.
//!     assert!(test.db.machine(&actor.ctx, &victim.machine_id()).await?.is_none());
//! }
//! test.stop().await;
//! ```
//!
//! A server test that already runs a gateway seeds that gateway's database instead
//! (`TwoTenants::seed(&gateway.db)`); that database needs [`master_keys`], which is how the
//! secrets get stored.
//!
//! # Plugging in what comes next
//!
//! - **Sandbox files** (`jian-exec`, M3): add a field to [`Side`] with a file each tenant owns
//!   (written through the sandbox's own API, with the tenant's context), seed it in
//!   `Side::seed`, and let the test read, list and overwrite the other side's path by its name,
//!   with `..` and through a symlink.
//! - **Users inside a tenant** (M3, workspaces): add a second subject to [`Side`] (a user with a
//!   private agent) and a pairing next to [`TwoTenants::crossings`] for two users of one tenant,
//!   so the same loops prove user X does not see user Y's private agent. The tenant wall and the
//!   user wall are different checks: keep both.
//! - **A new job kind or route**: list it in [`coverage`] (jobs) or in the gateway's isolation
//!   test (routes, requests, topics) together with the test that proves it.

// Fixtures are not `#[test]` functions, so clippy.toml's allowance for tests does not reach them;
// a failed setup should stop the test where it is.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod coverage;
mod database;
mod tenants;

pub use database::{TestDb, master_keys, sql_error_code};
pub use tenants::{JOB_KIND, SECRET_OWNER, SHARED_KEY, Side, TwoTenants};
