//! The library's whole storage contract, kept in the account's [`SessionStore`].
//!
//! Its own backends keep files or `SQLite`; this one keeps nothing but what the gateway lets it:
//! every record is one sealed value of the account's store, so the keys are encrypted at rest and
//! no other account can read them. A record's name is `<kind>/<id>`; the kinds do not share a
//! prefix, so listing one never returns another.

use std::sync::Arc;

use jian_channel_api::SessionStore;
use tokio::sync::Mutex;
use whatsapp_rust::async_trait;
use whatsapp_rust::wacore::store::Device;
use whatsapp_rust::wacore::store::error::Result;
use whatsapp_rust::wacore::store::traits::{
    DeviceStore, MsgSecretEntry, MsgSecretStore, merge_msg_secret_expiry,
    merge_msg_secret_message_ts,
};

use crate::kv::Kv;

mod appsync;
mod protocol;
mod signal;
#[cfg(test)]
mod tests;

const DEVICE: &str = "device";
const SECRETS: &str = "ms/";

/// The library's backend over one account's session store.
pub struct SessionBackend {
    kv: Kv,
    /// Held across a read followed by a write, so two tasks cannot lose each other's update.
    write: Mutex<()>,
}

impl SessionBackend {
    /// A backend that keeps everything in `store`.
    #[must_use]
    pub fn new(store: Arc<dyn SessionStore>) -> Self {
        Self {
            kv: Kv::new(store),
            write: Mutex::new(()),
        }
    }

    /// Forgets everything: the session is over.
    pub(crate) async fn erase(&self) -> Result<u32> {
        let _held = self.write.lock().await;
        self.kv.del_prefix("").await
    }

    /// Whether a device was ever saved: a session to resume.
    pub(crate) async fn has_device(&self) -> Result<bool> {
        Ok(self.kv.get(DEVICE).await?.is_some())
    }
}

fn secret_key(chat: &str, sender: &str, id: &str) -> String {
    format!("{SECRETS}{chat}/{sender}/{id}")
}

#[async_trait]
impl DeviceStore for SessionBackend {
    async fn save(&self, device: &Device) -> Result<()> {
        self.kv.put_json(DEVICE, device).await
    }

    async fn load(&self) -> Result<Option<Device>> {
        self.kv.get_json(DEVICE).await
    }

    async fn exists(&self) -> Result<bool> {
        self.has_device().await
    }

    async fn create(&self) -> Result<i32> {
        let _held = self.write.lock().await;
        if !self.has_device().await? {
            self.kv.put_json(DEVICE, &Device::new()).await?;
        }
        Ok(1)
    }
}

#[async_trait]
impl MsgSecretStore for SessionBackend {
    async fn put_msg_secrets(&self, entries: Vec<MsgSecretEntry>) -> Result<usize> {
        let stored = entries.len();
        let _held = self.write.lock().await;
        for mut entry in entries {
            let key = secret_key(&entry.chat, &entry.sender, &entry.msg_id);
            if let Some(old) = self.kv.get_json::<MsgSecretEntry>(&key).await? {
                entry.expires_at = merge_msg_secret_expiry(old.expires_at, entry.expires_at);
                entry.message_ts = merge_msg_secret_message_ts(old.message_ts, entry.message_ts);
            }
            self.kv.put_json(&key, &entry).await?;
        }
        Ok(stored)
    }

    async fn get_msg_secret(
        &self,
        chat: &str,
        sender: &str,
        msg_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        Ok(self
            .get_msg_secret_with_ts(chat, sender, msg_id)
            .await?
            .map(|(secret, _)| secret))
    }

    async fn get_msg_secret_with_ts(
        &self,
        chat: &str,
        sender: &str,
        msg_id: &str,
    ) -> Result<Option<(Vec<u8>, i64)>> {
        let entry: Option<MsgSecretEntry> =
            self.kv.get_json(&secret_key(chat, sender, msg_id)).await?;
        Ok(entry.map(|entry| (entry.secret.to_vec(), entry.message_ts)))
    }

    async fn delete_expired_msg_secrets(&self, cutoff_timestamp: i64) -> Result<u32> {
        let _held = self.write.lock().await;
        let mut gone = 0;
        for key in self.kv.keys(SECRETS).await? {
            let Some(entry) = self.kv.get_json::<MsgSecretEntry>(&key).await? else {
                continue;
            };
            // No deadline is 0: it never expires.
            if entry.expires_at != 0 && entry.expires_at <= cutoff_timestamp {
                self.kv.del(&key).await?;
                gone += 1;
            }
        }
        Ok(gone)
    }
}
