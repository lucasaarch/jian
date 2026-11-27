//! The key-value view of the session store the backend writes through.
//!
//! Every value goes to the account's [`SessionStore`], which seals it in the database; nothing
//! here keeps a copy past a call. Key names are metadata (kinds, ids and JIDs), values are
//! secret: an error carries the name of the failed step and never a value.

use std::sync::Arc;

use jian_channel_api::SessionStore;
use serde::Serialize;
use serde::de::DeserializeOwned;
use whatsapp_rust::wacore::store::error::{Result, StoreError};

/// One account's store, as the backend uses it.
pub(crate) struct Kv {
    store: Arc<dyn SessionStore>,
}

/// The text of a byte string, for a key name.
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn failed(error: impl std::error::Error + Send + Sync + 'static) -> StoreError {
    StoreError::Database(Box::new(error))
}

impl Kv {
    pub(crate) fn new(store: Arc<dyn SessionStore>) -> Self {
        Self { store }
    }

    pub(crate) async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.store.get(key).await.map_err(failed)
    }

    pub(crate) async fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        self.store.put(key, value).await.map_err(failed)
    }

    pub(crate) async fn del(&self, key: &str) -> Result<()> {
        self.store.delete(key).await.map_err(failed)
    }

    pub(crate) async fn keys(&self, prefix: &str) -> Result<Vec<String>> {
        self.store.keys(prefix).await.map_err(failed)
    }

    /// A value written by [`Self::put_json`].
    pub(crate) async fn get_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        match self.get(key).await? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| StoreError::Serialization(Box::new(error))),
            None => Ok(None),
        }
    }

    pub(crate) async fn put_json<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| StoreError::Serialization(Box::new(error)))?;
        self.put(key, &bytes).await
    }

    /// Removes every key that starts with `prefix`; how many.
    pub(crate) async fn del_prefix(&self, prefix: &str) -> Result<u32> {
        let mut gone = 0;
        for key in self.keys(prefix).await? {
            self.del(&key).await?;
            gone += 1;
        }
        Ok(gone)
    }
}

/// A row that carries the time it was written: eight big-endian bytes, then the payload.
pub(crate) fn stamped(at: i64, payload: &[u8]) -> Vec<u8> {
    let mut row = at.to_be_bytes().to_vec();
    row.extend_from_slice(payload);
    row
}

/// The time and payload of a [`stamped`] row.
pub(crate) fn unstamp(row: &[u8]) -> Option<(i64, &[u8])> {
    let (at, payload) = row.split_first_chunk::<8>()?;
    Some((i64::from_be_bytes(*at), payload))
}
