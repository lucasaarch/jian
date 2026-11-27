//! The state of the app-state sync collections: its keys, versions and mutation MACs.

use whatsapp_rust::async_trait;
use whatsapp_rust::wacore::appstate::hash::HashState;
use whatsapp_rust::wacore::appstate::processor::AppStateMutationMAC;
use whatsapp_rust::wacore::store::error::Result;
use whatsapp_rust::wacore::store::traits::{AppStateSyncKey, AppSyncStore};

use super::SessionBackend;
use crate::kv::hex;

const KEY: &str = "sync/";
const LATEST: &str = "sync-latest";
const VERSION: &str = "ver/";
const MAC: &str = "mac/";

fn mac_key(name: &str, index_mac: &[u8]) -> String {
    format!("{MAC}{name}/{}", hex(index_mac))
}

#[async_trait]
impl AppSyncStore for SessionBackend {
    async fn get_sync_key(&self, key_id: &[u8]) -> Result<Option<AppStateSyncKey>> {
        self.kv.get_json(&format!("{KEY}{}", hex(key_id))).await
    }

    /// The latest key is the newest by its own timestamp; the later write wins a tie.
    async fn set_sync_key(&self, key_id: &[u8], key: AppStateSyncKey) -> Result<()> {
        let _held = self.write.lock().await;
        let newest = match self.kv.get(LATEST).await? {
            Some(id) => self
                .kv
                .get_json::<AppStateSyncKey>(&format!("{KEY}{}", hex(&id)))
                .await?
                .map(|latest| latest.timestamp),
            None => None,
        };
        let is_newest = newest.is_none_or(|timestamp| key.timestamp >= timestamp);
        self.kv
            .put_json(&format!("{KEY}{}", hex(key_id)), &key)
            .await?;
        if is_newest {
            self.kv.put(LATEST, key_id).await?;
        }
        Ok(())
    }

    async fn get_version(&self, name: &str) -> Result<HashState> {
        Ok(self
            .kv
            .get_json(&format!("{VERSION}{name}"))
            .await?
            .unwrap_or_default())
    }

    async fn set_version(&self, name: &str, state: HashState) -> Result<()> {
        self.kv.put_json(&format!("{VERSION}{name}"), &state).await
    }

    async fn put_mutation_macs(
        &self,
        name: &str,
        _version: u64,
        mutations: &[AppStateMutationMAC],
    ) -> Result<()> {
        for mutation in mutations {
            self.kv
                .put(&mac_key(name, &mutation.index_mac), &mutation.value_mac)
                .await?;
        }
        Ok(())
    }

    async fn get_mutation_mac(&self, name: &str, index_mac: &[u8]) -> Result<Option<Vec<u8>>> {
        self.kv.get(&mac_key(name, index_mac)).await
    }

    async fn delete_mutation_macs(&self, name: &str, index_macs: &[Vec<u8>]) -> Result<()> {
        for index_mac in index_macs {
            self.kv.del(&mac_key(name, index_mac)).await?;
        }
        Ok(())
    }

    async fn clear_mutation_macs(&self, name: &str) -> Result<()> {
        self.kv.del_prefix(&format!("{MAC}{name}/")).await?;
        Ok(())
    }

    async fn get_latest_sync_key_id(&self) -> Result<Option<Vec<u8>>> {
        self.kv.get(LATEST).await
    }
}
