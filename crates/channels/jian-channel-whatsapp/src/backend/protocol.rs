//! What the protocol remembers about other people: their devices, LID mappings, trust tokens,
//! group sender-key state, and the messages kept for a retry.

use std::collections::BTreeMap;

use whatsapp_rust::async_trait;
use whatsapp_rust::wacore::store::error::Result;
use whatsapp_rust::wacore::store::traits::{
    DeviceListRecord, LidPnMappingEntry, ProtocolStore, TcTokenEntry,
};
use whatsapp_rust::wacore::time::now_secs;

use super::SessionBackend;
use crate::kv::{stamped, unstamp};

const SENDER_DEVICES: &str = "skd/";
const LID: &str = "lid/";
const PHONE: &str = "pn/";
const BASE_KEY: &str = "bk/";
const DEVICES: &str = "dev/";
const TC: &str = "tc/";
const SENT: &str = "sent/";
const PENDING: &str = "pin/";

type Devices = BTreeMap<String, bool>;

#[async_trait]
impl ProtocolStore for SessionBackend {
    async fn get_sender_key_devices(&self, group_jid: &str) -> Result<Vec<(String, bool)>> {
        let devices: Option<Devices> = self
            .kv
            .get_json(&format!("{SENDER_DEVICES}{group_jid}"))
            .await?;
        Ok(devices.unwrap_or_default().into_iter().collect())
    }

    async fn set_sender_key_status(&self, group_jid: &str, entries: &[(&str, bool)]) -> Result<()> {
        let _held = self.write.lock().await;
        let key = format!("{SENDER_DEVICES}{group_jid}");
        let mut devices: Devices = self.kv.get_json(&key).await?.unwrap_or_default();
        for (device, has_key) in entries {
            devices.insert((*device).to_owned(), *has_key);
        }
        self.kv.put_json(&key, &devices).await
    }

    async fn clear_sender_key_devices(&self, group_jid: &str) -> Result<()> {
        self.kv.del(&format!("{SENDER_DEVICES}{group_jid}")).await
    }

    async fn delete_sender_key_device_rows(&self, device_jids: &[&str]) -> Result<()> {
        let _held = self.write.lock().await;
        for key in self.kv.keys(SENDER_DEVICES).await? {
            let Some(mut devices) = self.kv.get_json::<Devices>(&key).await? else {
                continue;
            };
            let before = devices.len();
            devices.retain(|device, _| !device_jids.contains(&device.as_str()));
            if devices.len() != before {
                self.kv.put_json(&key, &devices).await?;
            }
        }
        Ok(())
    }

    async fn clear_all_sender_key_devices(&self) -> Result<()> {
        self.kv.del_prefix(SENDER_DEVICES).await?;
        Ok(())
    }

    async fn get_lid_mapping(&self, lid: &str) -> Result<Option<LidPnMappingEntry>> {
        self.kv.get_json(&format!("{LID}{lid}")).await
    }

    async fn get_pn_mapping(&self, phone: &str) -> Result<Option<LidPnMappingEntry>> {
        match self.kv.get(&format!("{PHONE}{phone}")).await? {
            Some(lid) => self.get_lid_mapping(&String::from_utf8_lossy(&lid)).await,
            None => Ok(None),
        }
    }

    async fn put_lid_mapping(&self, entry: &LidPnMappingEntry) -> Result<()> {
        let _held = self.write.lock().await;
        let key = format!("{LID}{}", entry.lid);
        // A LID that moves to another number leaves no index behind for the old one.
        if let Some(old) = self.kv.get_json::<LidPnMappingEntry>(&key).await?
            && old.phone_number != entry.phone_number
        {
            self.kv.del(&format!("{PHONE}{}", old.phone_number)).await?;
        }
        self.kv.put_json(&key, entry).await?;
        self.kv
            .put(
                &format!("{PHONE}{}", entry.phone_number),
                entry.lid.as_bytes(),
            )
            .await
    }

    async fn get_all_lid_mappings(&self) -> Result<Vec<LidPnMappingEntry>> {
        let mut all = Vec::new();
        for key in self.kv.keys(LID).await? {
            if let Some(entry) = self.kv.get_json(&key).await? {
                all.push(entry);
            }
        }
        Ok(all)
    }

    async fn save_base_key(&self, address: &str, message_id: &str, base_key: &[u8]) -> Result<()> {
        self.kv
            .put(&format!("{BASE_KEY}{address}/{message_id}"), base_key)
            .await
    }

    async fn has_same_base_key(
        &self,
        address: &str,
        message_id: &str,
        current_base_key: &[u8],
    ) -> Result<bool> {
        let saved = self
            .kv
            .get(&format!("{BASE_KEY}{address}/{message_id}"))
            .await?;
        Ok(saved.is_some_and(|saved| saved == current_base_key))
    }

    async fn delete_base_key(&self, address: &str, message_id: &str) -> Result<()> {
        self.kv
            .del(&format!("{BASE_KEY}{address}/{message_id}"))
            .await
    }

    async fn update_device_list(&self, record: DeviceListRecord) -> Result<()> {
        self.kv
            .put_json(&format!("{DEVICES}{}", record.user), &record)
            .await
    }

    async fn get_devices(&self, user: &str) -> Result<Option<DeviceListRecord>> {
        self.kv.get_json(&format!("{DEVICES}{user}")).await
    }

    async fn delete_devices(&self, user: &str) -> Result<()> {
        self.kv.del(&format!("{DEVICES}{user}")).await
    }

    async fn get_tc_token(&self, jid: &str) -> Result<Option<TcTokenEntry>> {
        self.kv.get_json(&format!("{TC}{jid}")).await
    }

    async fn put_tc_token(&self, jid: &str, entry: &TcTokenEntry) -> Result<()> {
        self.kv.put_json(&format!("{TC}{jid}"), entry).await
    }

    async fn delete_tc_token(&self, jid: &str) -> Result<()> {
        self.kv.del(&format!("{TC}{jid}")).await
    }

    async fn get_all_tc_token_jids(&self) -> Result<Vec<String>> {
        Ok(self
            .kv
            .keys(TC)
            .await?
            .into_iter()
            .filter_map(|key| key.strip_prefix(TC).map(str::to_owned))
            .collect())
    }

    /// A row stays while either window is live: the received token or the sender bucket.
    async fn delete_expired_tc_tokens(&self, token_cutoff: i64, sender_cutoff: i64) -> Result<u32> {
        let _held = self.write.lock().await;
        let mut gone = 0;
        for key in self.kv.keys(TC).await? {
            let Some(entry) = self.kv.get_json::<TcTokenEntry>(&key).await? else {
                continue;
            };
            let token_live = !entry.token.is_empty() && entry.token_timestamp >= token_cutoff;
            let sender_live = entry.sender_timestamp.is_some_and(|at| at >= sender_cutoff);
            if !token_live && !sender_live {
                self.kv.del(&key).await?;
                gone += 1;
            }
        }
        Ok(gone)
    }

    async fn store_sent_message(
        &self,
        chat_jid: &str,
        message_id: &str,
        payload: &[u8],
    ) -> Result<()> {
        self.kv
            .put(
                &format!("{SENT}{chat_jid}/{message_id}"),
                &stamped(now_secs(), payload),
            )
            .await
    }

    async fn take_sent_message(&self, chat_jid: &str, message_id: &str) -> Result<Option<Vec<u8>>> {
        let _held = self.write.lock().await;
        let key = format!("{SENT}{chat_jid}/{message_id}");
        let row = self.kv.get(&key).await?;
        self.kv.del(&key).await?;
        Ok(row.and_then(|row| unstamp(&row).map(|(_, payload)| payload.to_vec())))
    }

    async fn delete_expired_sent_messages(&self, cutoff_timestamp: i64) -> Result<u32> {
        self.delete_stamped_before(SENT, cutoff_timestamp).await
    }

    async fn store_pending_inbound(
        &self,
        chat: &str,
        sender: &str,
        id: &str,
        message: &[u8],
    ) -> Result<()> {
        self.kv
            .put(
                &format!("{PENDING}{chat}/{sender}/{id}"),
                &stamped(now_secs(), message),
            )
            .await
    }

    async fn get_pending_inbound(
        &self,
        chat: &str,
        sender: &str,
        id: &str,
    ) -> Result<Option<Vec<u8>>> {
        let row = self
            .kv
            .get(&format!("{PENDING}{chat}/{sender}/{id}"))
            .await?;
        Ok(row.and_then(|row| unstamp(&row).map(|(_, message)| message.to_vec())))
    }

    async fn delete_pending_inbound(&self, chat: &str, sender: &str, id: &str) -> Result<()> {
        self.kv.del(&format!("{PENDING}{chat}/{sender}/{id}")).await
    }

    async fn delete_expired_pending_inbound(&self, cutoff_timestamp: i64) -> Result<u32> {
        self.delete_stamped_before(PENDING, cutoff_timestamp).await
    }
}

impl SessionBackend {
    /// Removes the rows under `prefix` written before `cutoff` (Unix seconds).
    async fn delete_stamped_before(&self, prefix: &str, cutoff: i64) -> Result<u32> {
        let _held = self.write.lock().await;
        let mut gone = 0;
        for key in self.kv.keys(prefix).await? {
            let Some(row) = self.kv.get(&key).await? else {
                continue;
            };
            if unstamp(&row).is_none_or(|(at, _)| at < cutoff) {
                self.kv.del(&key).await?;
                gone += 1;
            }
        }
        Ok(gone)
    }
}
