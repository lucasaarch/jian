//! Identities, sessions, pre-keys and sender keys.

use whatsapp_rust::async_trait;
use whatsapp_rust::bytes::Bytes;
use whatsapp_rust::wacore::store::error::{Result, StoreError};
use whatsapp_rust::wacore::store::traits::SignalStore;

use super::SessionBackend;

const IDENTITY: &str = "id/";
const SESSION: &str = "sess/";
const PREKEY: &str = "pk/";
const SIGNED: &str = "spk/";
const SENDER: &str = "sk/";

/// Ids sort as text in the store, so they are padded to sort as numbers too.
fn number(id: u32) -> String {
    format!("{id:010}")
}

fn id_of(key: &str, prefix: &str) -> Option<u32> {
    key.strip_prefix(prefix)?.parse().ok()
}

#[async_trait]
impl SignalStore for SessionBackend {
    async fn put_identity(&self, address: &str, key: [u8; 32]) -> Result<()> {
        self.kv.put(&format!("{IDENTITY}{address}"), &key).await
    }

    async fn load_identity(&self, address: &str) -> Result<Option<[u8; 32]>> {
        match self.kv.get(&format!("{IDENTITY}{address}")).await? {
            Some(bytes) => <[u8; 32]>::try_from(bytes.as_slice())
                .map(Some)
                .map_err(|_| StoreError::Validation("a stored identity has the wrong size".into())),
            None => Ok(None),
        }
    }

    async fn delete_identity(&self, address: &str) -> Result<()> {
        self.kv.del(&format!("{IDENTITY}{address}")).await
    }

    async fn get_session(&self, address: &str) -> Result<Option<Bytes>> {
        Ok(self
            .kv
            .get(&format!("{SESSION}{address}"))
            .await?
            .map(Bytes::from))
    }

    async fn put_session(&self, address: &str, session: &[u8]) -> Result<()> {
        self.kv.put(&format!("{SESSION}{address}"), session).await
    }

    async fn delete_session(&self, address: &str) -> Result<()> {
        self.kv.del(&format!("{SESSION}{address}")).await
    }

    /// A pre-key is one flag byte (uploaded to the server or not), then its record.
    async fn store_prekey(&self, id: u32, record: &[u8], uploaded: bool) -> Result<()> {
        let mut row = vec![u8::from(uploaded)];
        row.extend_from_slice(record);
        self.kv.put(&format!("{PREKEY}{}", number(id)), &row).await
    }

    async fn load_prekey(&self, id: u32) -> Result<Option<Bytes>> {
        let row = self.kv.get(&format!("{PREKEY}{}", number(id))).await?;
        Ok(row
            .and_then(|row| row.get(1..).map(<[u8]>::to_vec))
            .map(Bytes::from))
    }

    async fn mark_prekeys_uploaded(&self, ids: &[u32]) -> Result<()> {
        let _held = self.write.lock().await;
        for id in ids {
            let key = format!("{PREKEY}{}", number(*id));
            if let Some(mut row) = self.kv.get(&key).await?
                && let Some(flag) = row.first_mut()
            {
                *flag = 1;
                self.kv.put(&key, &row).await?;
            }
        }
        Ok(())
    }

    async fn remove_prekey(&self, id: u32) -> Result<()> {
        self.kv.del(&format!("{PREKEY}{}", number(id))).await
    }

    async fn get_max_prekey_id(&self) -> Result<u32> {
        let keys = self.kv.keys(PREKEY).await?;
        Ok(keys
            .iter()
            .filter_map(|key| id_of(key, PREKEY))
            .max()
            .unwrap_or(0))
    }

    async fn store_signed_prekey(&self, id: u32, record: &[u8]) -> Result<()> {
        self.kv
            .put(&format!("{SIGNED}{}", number(id)), record)
            .await
    }

    async fn load_signed_prekey(&self, id: u32) -> Result<Option<Vec<u8>>> {
        self.kv.get(&format!("{SIGNED}{}", number(id))).await
    }

    async fn load_all_signed_prekeys(&self) -> Result<Vec<(u32, Vec<u8>)>> {
        let mut all = Vec::new();
        for key in self.kv.keys(SIGNED).await? {
            if let (Some(id), Some(record)) = (id_of(&key, SIGNED), self.kv.get(&key).await?) {
                all.push((id, record));
            }
        }
        Ok(all)
    }

    async fn remove_signed_prekey(&self, id: u32) -> Result<()> {
        self.kv.del(&format!("{SIGNED}{}", number(id))).await
    }

    async fn put_sender_key(&self, address: &str, record: &[u8]) -> Result<()> {
        self.kv.put(&format!("{SENDER}{address}"), record).await
    }

    async fn get_sender_key(&self, address: &str) -> Result<Option<Vec<u8>>> {
        self.kv.get(&format!("{SENDER}{address}")).await
    }

    async fn delete_sender_key(&self, address: &str) -> Result<()> {
        self.kv.del(&format!("{SENDER}{address}")).await
    }
}
