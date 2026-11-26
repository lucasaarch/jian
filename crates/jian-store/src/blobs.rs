//! Where the bytes of a tenant's files live, behind a small trait.
//!
//! A row says a file exists (name, size, hash, who sent it); a [`BlobStore`] holds what is in it.
//! The store keeps no bytes in Postgres: a 25 MiB upload would sit in WAL, backups and the
//! connection pool for the life of the row. [`DiskBlobs`] is the one backend today: a directory
//! per tenant under a root the binary names.
//!
//! # What the backend promises
//!
//! - **Keys are ours.** A [`BlobKey`] is generated here (128 random bits in hex) or parsed from
//!   `[a-z0-9_]{1,64}`, so a name a person typed never reaches a path: no `..`, no separator, no
//!   second way to name another tenant's file. The tenant is a separate argument, and a
//!   [`TenantId`] is `[a-z0-9]` only.
//! - **A write is whole or absent.** [`DiskBlobs`] writes a temporary file and renames it, so a
//!   crash leaves no half file under a key a row points at.
//! - **Delete is idempotent**, so a retry after a crash does not fail.
//!
//! # Where object storage or `jian-exec` plugs in
//!
//! Anything that implements [`BlobStore`] can be handed to
//! [`Database::with_blobs`](crate::Database::with_blobs): an S3-compatible bucket for the Cloud,
//! or the sandbox filesystem the agent's tools read through `jian-exec`, which would mount or copy
//! a project's files by key. Rows never carry a path, only the key, so the move needs no
//! migration of data in Postgres. The disk quota counts `project_files.size_bytes`, not what the
//! backend reports, so it holds for every backend.

use std::path::{Path, PathBuf};

use futures_util::future::BoxFuture;

use crate::tokens::random_id;
use crate::{StoreError, TenantId};

const MAX_KEY_LEN: usize = 64;

/// Why a blob could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    /// The key has characters outside `[a-z0-9_]` or is empty or too long.
    #[error("not a valid blob key")]
    InvalidKey,
    /// Nothing is stored under the key for this tenant.
    #[error("no blob under that key")]
    NotFound,
    /// The backend failed; `action` says what it was doing.
    #[error("cannot {action} a blob: {source}")]
    Io {
        /// What was being done.
        action: &'static str,
        /// The operating system's reason.
        source: std::io::Error,
    },
}

/// The name a blob has in a [`BlobStore`]. Only characters that are safe as a file name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobKey(String);

impl BlobKey {
    /// A new random key.
    pub(crate) fn generate() -> Result<Self, StoreError> {
        random_id("blb_").map(Self)
    }

    /// Accepts `[a-z0-9_]{1,64}`.
    pub fn parse(text: &str) -> Result<Self, BlobError> {
        let valid = (1..=MAX_KEY_LEN).contains(&text.len())
            && text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if valid {
            Ok(Self(text.to_owned()))
        } else {
            Err(BlobError::InvalidKey)
        }
    }

    /// The key as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Holds the bytes of files, per tenant, by key. Whole values: the size limit is the caller's, and
/// is what keeps a blob in memory small enough.
pub trait BlobStore: Send + Sync {
    /// Stores `bytes` under `key`, replacing what was there.
    fn put<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<(), BlobError>>;

    /// What is stored under `key`, or [`BlobError::NotFound`].
    fn get<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
    ) -> BoxFuture<'a, Result<Vec<u8>, BlobError>>;

    /// Removes `key`. A key that is not there is not an error.
    fn delete<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
    ) -> BoxFuture<'a, Result<(), BlobError>>;
}

/// Blobs as files: `<root>/<tenant>/<key>`.
#[derive(Clone, Debug)]
pub struct DiskBlobs {
    root: PathBuf,
}

impl DiskBlobs {
    /// Files go under `root`, which is made when the first one is written.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn dir(&self, tenant: &TenantId) -> PathBuf {
        self.root.join(tenant.as_str())
    }

    fn path(&self, tenant: &TenantId, key: &BlobKey) -> PathBuf {
        self.dir(tenant).join(key.as_str())
    }
}

fn io(action: &'static str) -> impl FnOnce(std::io::Error) -> BlobError {
    move |source| BlobError::Io { action, source }
}

impl BlobStore for DiskBlobs {
    fn put<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
        bytes: &'a [u8],
    ) -> BoxFuture<'a, Result<(), BlobError>> {
        Box::pin(async move {
            let dir = self.dir(tenant);
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(io("make the folder of"))?;
            let target = self.path(tenant, key);
            // `.tmp` cannot collide with a key: a key has no dot.
            let temp = dir.join(format!("{}.tmp", key.as_str()));
            tokio::fs::write(&temp, bytes).await.map_err(io("write"))?;
            tokio::fs::rename(&temp, &target).await.map_err(|source| {
                // Best effort: a leftover temp file is garbage, not a wrong answer.
                drop(std::fs::remove_file(&temp));
                BlobError::Io {
                    action: "place",
                    source,
                }
            })
        })
    }

    fn get<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
    ) -> BoxFuture<'a, Result<Vec<u8>, BlobError>> {
        Box::pin(async move {
            tokio::fs::read(self.path(tenant, key))
                .await
                .map_err(|source| match source.kind() {
                    std::io::ErrorKind::NotFound => BlobError::NotFound,
                    _ => BlobError::Io {
                        action: "read",
                        source,
                    },
                })
        })
    }

    fn delete<'a>(
        &'a self,
        tenant: &'a TenantId,
        key: &'a BlobKey,
    ) -> BoxFuture<'a, Result<(), BlobError>> {
        Box::pin(async move {
            match tokio::fs::remove_file(self.path(tenant, key)).await {
                Ok(()) => Ok(()),
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(source) => Err(BlobError::Io {
                    action: "delete",
                    source,
                }),
            }
        })
    }
}

impl DiskBlobs {
    /// The folder of one tenant, for a test or an operator that wants to see what is on disk.
    #[must_use]
    pub fn tenant_dir(&self, tenant: &TenantId) -> PathBuf {
        self.dir(tenant)
    }

    /// The root every tenant's folder is under.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
}
