//! The [`SessionStore`] a channel gets: the records of one account's session, in the database,
//! sealed with the tenant's data key (see `Database::put_channel_session`).
//!
//! It is made for one tenant and one account and cannot name another: a channel has no way to
//! read the session of someone else's number. A database failure becomes
//! [`ChannelError::Store`] with the store's own text, which never holds a record's value.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_channel_api::{ChannelError, SessionStore};
use jian_store::{ChannelAccountId, Database, StoreError, TenantCtx};

/// One account's session in the database.
pub(crate) struct AccountSession {
    db: Arc<Database>,
    ctx: TenantCtx,
    account: ChannelAccountId,
}

impl AccountSession {
    pub(crate) fn new(db: Arc<Database>, ctx: TenantCtx, account: ChannelAccountId) -> Self {
        Self { db, ctx, account }
    }
}

fn failed(error: &StoreError) -> ChannelError {
    ChannelError::Store(error.to_string())
}

impl SessionStore for AccountSession {
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>> {
        let key = key.to_owned();
        Box::pin(async move {
            self.db
                .channel_session(&self.ctx, &self.account, &key)
                .await
                .map_err(|error| failed(&error))
        })
    }

    fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
        let (key, value) = (key.to_owned(), value.to_vec());
        Box::pin(async move {
            self.db
                .put_channel_session(&self.ctx, &self.account, &key, &value)
                .await
                .map_err(|error| failed(&error))
        })
    }

    fn delete(&self, key: &str) -> BoxFuture<'_, Result<(), ChannelError>> {
        let key = key.to_owned();
        Box::pin(async move {
            self.db
                .delete_channel_session(&self.ctx, &self.account, &key)
                .await
                .map_err(|error| failed(&error))
        })
    }

    fn keys(&self, prefix: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>> {
        let prefix = prefix.to_owned();
        Box::pin(async move {
            self.db
                .channel_session_keys(&self.ctx, &self.account, &prefix)
                .await
                .map_err(|error| failed(&error))
        })
    }
}
