//! Storing and reading a tenant's secrets: encrypted with its data key, written to its schema.

use std::future::Future;

use super::Secret;
use super::cipher::{open_envelope, seal_envelope};
use crate::{Database, StoreError, TenantCtx};

/// Why [`Vault::refresh`] did not store a new value.
#[derive(Debug, thiserror::Error)]
pub enum RefreshError<E> {
    /// The store failed: the database, the key, or a secret that would not decrypt.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The caller's function failed, so the stored secret was left as it was.
    #[error("the new value could not be made: {0}")]
    Transform(E),
}

/// A tenant's secrets: provider keys, connector and channel tokens. Get one from
/// [`Database::vault`].
///
/// Each value is encrypted with the tenant's data key before it reaches the database, bound to
/// the tenant and to its `owner` (`provider:openai`), so what is stored is unreadable without the
/// master key and cannot be moved to another row or tenant. Every call goes through
/// [`Database::begin`], like any other query for a tenant.
pub struct Vault<'a> {
    db: &'a Database,
}

impl Database {
    /// The secrets of the tenants of this database.
    pub fn vault(&self) -> Vault<'_> {
        Vault { db: self }
    }
}

impl Vault<'_> {
    /// Stores the secret under `owner`, replacing the one there. A new random nonce is drawn
    /// each time, so storing the same text twice gives two different envelopes.
    pub async fn put(
        &self,
        ctx: &TenantCtx,
        owner: &str,
        secret: &Secret,
    ) -> Result<(), StoreError> {
        let envelope = self.seal(ctx, owner, secret).await?;
        let mut tx = self.db.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO secrets (owner, envelope) VALUES ($1, $2) \
             ON CONFLICT (owner) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = now()",
        )
        .bind(owner)
        .bind(&envelope)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("store a secret"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("store a secret"))
    }

    /// The secret stored under `owner`, or `None`. An error, not `None`, when it is there and
    /// cannot be decrypted.
    pub async fn read(&self, ctx: &TenantCtx, owner: &str) -> Result<Option<Secret>, StoreError> {
        let mut tx = self.db.begin(ctx).await?;
        let envelope: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT envelope FROM secrets WHERE owner = $1")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read a secret"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("read a secret"))?;
        match envelope {
            Some(envelope) => self.open(ctx, owner, &envelope).await.map(Some),
            None => Ok(None),
        }
    }

    /// Deletes the secret under `owner`. Returns whether there was one.
    pub async fn discard(&self, ctx: &TenantCtx, owner: &str) -> Result<bool, StoreError> {
        let mut tx = self.db.begin(ctx).await?;
        let deleted = sqlx::query("DELETE FROM secrets WHERE owner = $1")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("discard a secret"))?
            .rows_affected();
        tx.commit()
            .await
            .map_err(StoreError::query("discard a secret"))?;
        Ok(deleted > 0)
    }

    /// Reads the secret, gives it to `transform` and stores what that returns, all in one
    /// transaction that holds the row's lock. Two refreshes of one secret (two requests that both
    /// find an OAuth token expired) therefore take turns: the second sees the first's result
    /// instead of overwriting it, and can notice the token is fresh and keep it.
    ///
    /// Returns `false`, without calling `transform`, when nothing is stored under `owner`. If
    /// `transform` fails the stored secret is unchanged.
    ///
    /// The lock and one pooled connection are held while `transform` runs, so keep it to the
    /// call that makes the new value (the token request) and nothing slow beyond it.
    pub async fn refresh<F, Fut, E>(
        &self,
        ctx: &TenantCtx,
        owner: &str,
        transform: F,
    ) -> Result<bool, RefreshError<E>>
    where
        F: FnOnce(Secret) -> Fut,
        Fut: Future<Output = Result<Secret, E>>,
    {
        // Before the transaction, so the data key's own queries do not need a second connection
        // while this one holds the lock.
        let dek = self.db.data_key(ctx.id()).await?;
        let mut tx = self.db.begin(ctx).await?;
        let envelope: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT envelope FROM secrets WHERE owner = $1 FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("lock a secret"))?;
        let Some(envelope) = envelope else {
            return Ok(false);
        };
        let current = secret_from(&open_envelope(
            dek.expose(),
            ctx.id().as_str(),
            owner,
            &envelope,
        )?)?;
        let next = transform(current).await.map_err(RefreshError::Transform)?;
        let sealed = seal_envelope(
            dek.expose(),
            ctx.id().as_str(),
            owner,
            next.expose().as_bytes(),
        )?;
        sqlx::query("UPDATE secrets SET envelope = $2, updated_at = now() WHERE owner = $1")
            .bind(owner)
            .bind(&sealed)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("store a refreshed secret"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("store a refreshed secret"))?;
        Ok(true)
    }

    async fn seal(
        &self,
        ctx: &TenantCtx,
        owner: &str,
        secret: &Secret,
    ) -> Result<Vec<u8>, StoreError> {
        let dek = self.db.data_key(ctx.id()).await?;
        seal_envelope(
            dek.expose(),
            ctx.id().as_str(),
            owner,
            secret.expose().as_bytes(),
        )
    }

    async fn open(
        &self,
        ctx: &TenantCtx,
        owner: &str,
        envelope: &[u8],
    ) -> Result<Secret, StoreError> {
        let dek = self.db.data_key(ctx.id()).await?;
        secret_from(&open_envelope(
            dek.expose(),
            ctx.id().as_str(),
            owner,
            envelope,
        )?)
    }
}

fn secret_from(plain: &[u8]) -> Result<Secret, StoreError> {
    // Only text goes in, so only text comes out; anything else is a different writer's data.
    std::str::from_utf8(plain)
        .map(Secret::new)
        .map_err(|_| StoreError::MalformedEnvelope("the secret is not text"))
}
