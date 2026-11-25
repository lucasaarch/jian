//! The owner's token of a self-hosted install.

use super::ids::OWNER_SUBJECT;
use super::{TokenHash, TokenKind};
use crate::{Database, StoreError, TenantCtx};

/// The shortest owner token taken, in bytes: the Node gateway's `JIAN_API_TOKEN` rule, kept so an
/// existing value keeps working.
pub const MIN_OWNER_TOKEN_LEN: usize = 32;

impl Database {
    /// Makes `token` the tenant's one owner token, from the environment or a file the binary read.
    /// Calling it on every start is safe. Any other owner token the tenant had is revoked, so
    /// changing `JIAN_API_TOKEN` cuts off the old value instead of leaving two.
    ///
    /// Multi-tenant login (password, OAuth) is not here: those sessions are tokens of their own
    /// kind, and are for the Cloud.
    pub async fn set_owner_token(&self, ctx: &TenantCtx, token: &str) -> Result<(), StoreError> {
        const ACTION: &str = "set the owner token";
        if token.len() < MIN_OWNER_TOKEN_LEN {
            return Err(StoreError::OwnerTokenTooShort(MIN_OWNER_TOKEN_LEN));
        }
        let hash = TokenHash::of(token);
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "UPDATE api_tokens SET revoked_at = now() \
             WHERE tenant_id = $1 AND kind = 'owner' AND revoked_at IS NULL AND token_hash <> $2",
        )
        .bind(ctx.id().as_str())
        .bind(hash.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // A hash that is already the tenant's owner token is revived (it may have been revoked by
        // an earlier value); one that belongs to anything else is left alone and refused.
        let written = sqlx::query(
            "INSERT INTO api_tokens (token_hash, tenant_id, kind, subject_id) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NULL \
             WHERE api_tokens.tenant_id = $2 AND api_tokens.kind = $3",
        )
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(TokenKind::Owner.as_str())
        .bind(OWNER_SUBJECT)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if written == 0 {
            return Err(StoreError::TokenInUse);
        }
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
