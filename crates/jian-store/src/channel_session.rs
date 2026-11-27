//! The session of a chat account, as records sealed with the tenant's data key.
//!
//! The same envelope the vault uses, so there is no cryptography of its own here: each value is
//! encrypted and tied to the tenant, the account and the record's key. The record's name stays
//! readable (it is how a prefix is listed); the value never does.

use crate::channels::{ChannelAccountId, channel_secret_owner};
use crate::secrets::{open_envelope, seal_envelope};
use crate::{Database, StoreError, TenantCtx};

impl Database {
    /// Stores `value` under `key` for the account, replacing what was there. A write that
    /// returns is committed. The account must exist.
    pub async fn put_channel_session(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        key: &str,
        value: &[u8],
    ) -> Result<(), StoreError> {
        const ACTION: &str = "store a channel session record";
        let dek = self.data_key(ctx.id()).await?;
        let envelope = seal_envelope(
            dek.expose(),
            ctx.id().as_str(),
            &channel_secret_owner(id, key),
            value,
        )?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO channel_session (account_id, key, envelope) VALUES ($1, $2, $3) \
             ON CONFLICT (account_id, key) DO UPDATE \
             SET envelope = EXCLUDED.envelope, updated_at = now()",
        )
        .bind(id.as_str())
        .bind(key)
        .bind(&envelope)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The record under `key`, or `None`. An error, not `None`, when it is there and does not
    /// open.
    pub async fn channel_session(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        key: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        const ACTION: &str = "read a channel session record";
        let mut tx = self.begin(ctx).await?;
        let envelope: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT envelope FROM channel_session WHERE account_id = $1 AND key = $2",
        )
        .bind(id.as_str())
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        drop(tx);
        let Some(envelope) = envelope else {
            return Ok(None);
        };
        let dek = self.data_key(ctx.id()).await?;
        let plain = open_envelope(
            dek.expose(),
            ctx.id().as_str(),
            &channel_secret_owner(id, key),
            &envelope,
        )?;
        Ok(Some(plain.to_vec()))
    }

    /// Removes the record under `key`. Removing what is not there is not an error.
    pub async fn delete_channel_session(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        key: &str,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "delete a channel session record";
        let mut tx = self.begin(ctx).await?;
        sqlx::query("DELETE FROM channel_session WHERE account_id = $1 AND key = $2")
            .bind(id.as_str())
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The record names that start with `prefix`, in order. `starts_with`, not `LIKE`: a prefix
    /// with `%` or `_` in it means those characters.
    pub async fn channel_session_keys(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        prefix: &str,
    ) -> Result<Vec<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT key FROM channel_session \
             WHERE account_id = $1 AND starts_with(key, $2) ORDER BY key",
        )
        .bind(id.as_str())
        .bind(prefix)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list channel session records"))
    }

    /// Forgets the whole session of the account. Answers how many records went.
    pub async fn clear_channel_session(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
    ) -> Result<u64, StoreError> {
        const ACTION: &str = "clear a channel session";
        let mut tx = self.begin(ctx).await?;
        let gone = sqlx::query("DELETE FROM channel_session WHERE account_id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(gone)
    }
}
