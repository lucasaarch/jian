//! The backend over an in-memory store: what the library saves is there after a restart, and
//! logging out leaves nothing. (The store's own sealing and isolation are tested with Postgres in
//! `jian-store` and `jian-server`.)

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use jian_channel_api::{ChannelError, SessionStore};
use whatsapp_rust::wacore::store::traits::{DeviceStore as _, SignalStore as _};

use super::SessionBackend;

#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, Vec<u8>>>);

impl Memory {
    fn map(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Vec<u8>>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl SessionStore for Memory {
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>> {
        let found = self.map().get(key).cloned();
        Box::pin(async move { Ok(found) })
    }

    fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.map().insert(key.to_owned(), value.to_vec());
        Box::pin(async { Ok(()) })
    }

    fn delete(&self, key: &str) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.map().remove(key);
        Box::pin(async { Ok(()) })
    }

    fn keys(&self, prefix: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>> {
        let keys = self
            .map()
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        Box::pin(async move { Ok(keys) })
    }
}

#[tokio::test]
async fn what_the_library_saves_is_there_after_a_restart_and_logging_out_erases_it() {
    let store = Arc::new(Memory::default());
    let first = SessionBackend::new(store.clone());
    assert!(!first.has_device().await.unwrap());
    first.create().await.unwrap();
    first
        .put_identity("5511@s.whatsapp.net", [7; 32])
        .await
        .unwrap();
    first
        .put_session("5511@s.whatsapp.net", b"ratchet")
        .await
        .unwrap();
    first.store_prekey(5, b"pre", false).await.unwrap();
    first.mark_prekeys_uploaded(&[5]).await.unwrap();

    // A new backend over the same store is what a restart builds.
    let second = SessionBackend::new(store.clone());
    assert!(second.has_device().await.unwrap());
    assert!(second.load().await.unwrap().is_some());
    assert_eq!(
        second.load_identity("5511@s.whatsapp.net").await.unwrap(),
        Some([7; 32])
    );
    assert_eq!(
        second
            .get_session("5511@s.whatsapp.net")
            .await
            .unwrap()
            .as_deref(),
        Some(&b"ratchet"[..])
    );
    assert_eq!(second.get_max_prekey_id().await.unwrap(), 5);
    assert_eq!(
        second.load_prekey(5).await.unwrap().as_deref(),
        Some(&b"pre"[..])
    );

    second.erase().await.unwrap();
    assert!(store.map().is_empty());
    assert!(!second.has_device().await.unwrap());
}
