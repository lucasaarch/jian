//! Secrets at rest: envelope encryption per tenant.
//!
//! A provider key, an OAuth token or a channel credential is never stored as text. Three layers:
//!
//! - **The secret** is encrypted with AES-256-GCM under the tenant's data key (DEK) and stored in
//!   the tenant's own schema (`secrets`) as an envelope `version || key id || nonce ||
//!   ciphertext+tag`. The tag covers `jian:secret:<tenant>:<owner>`, so an envelope copied to
//!   another row or tenant fails to decrypt instead of leaking.
//! - **The data key** is 32 random bytes per tenant, stored in `platform.tenant_keys` only
//!   wrapped by the master key (KEK). The clear key lives in memory and is wiped when it drops.
//! - **The master key** sits behind [`MasterKeys`]. [`LocalKeyring`] serves a self-hosted install
//!   (an environment variable or a key file); a KMS-backed implementation can replace it for the
//!   Cloud without changing anything else.
//!
//! Rotating the master key ([`Database::rotate_master_keys`]) rewraps the data keys and leaves
//! every secret untouched.
//!
//! What this does not protect: someone who holds both the database and the master key, or can run
//! code in the gateway process, reads everything. It protects dumps, backups and a stolen disk
//! of the database alone.
//!
//! [`Database::rotate_master_keys`]: crate::Database::rotate_master_keys

mod cipher;
mod deks;
mod keys;
mod secret;
mod vault;

pub(crate) use deks::DekCache;
pub use deks::RotationReport;
pub use keys::{Dek, LOCAL_KEY_ID, LocalKeyring, MasterKeys, WrappedDek};
pub use secret::Secret;
pub use vault::{RefreshError, Vault};
