//! What machines and devices share: a row in the tenant's schema and a token in the platform's,
//! written, rotated and revoked together.
//!
//! The two live in different schemas under different roles, so one transaction does the tenant's
//! part as the tenant, then steps to the platform's role for the token. A failure in either undoes
//! both: there is never a machine without a token to pair it with, or a token without a machine.

use sqlx::{AssertSqlSafe, Postgres, Transaction};

use crate::platform::scope_to_platform;
use crate::secrets::Secret;
use crate::tokens::{TokenHash, TokenKind, generate_token, random_id};
use crate::{Database, StoreError, TenantCtx};

/// The longest name a person gives a machine or a phone, in characters.
pub(crate) const MAX_NAME_CHARS: usize = 80;

/// The two tables that hold something a token can act as. The names are fixed text, which is why
/// they may be put into a statement.
#[derive(Clone, Copy)]
pub(crate) enum Table {
    Machines,
    Devices,
}

impl Table {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Machines => "machines",
            Self::Devices => "devices",
        }
    }

    pub(crate) fn kind(self) -> TokenKind {
        match self {
            Self::Machines => TokenKind::Machine,
            Self::Devices => TokenKind::Device,
        }
    }

    fn id_prefix(self) -> &'static str {
        match self {
            Self::Machines => "mch_",
            Self::Devices => "dev_",
        }
    }
}

/// A name a person typed: trimmed, 1 to [`MAX_NAME_CHARS`] characters, no control characters.
pub(crate) fn clean_name(name: &str) -> Result<String, StoreError> {
    let name = name.trim();
    let valid = !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.chars().any(char::is_control);
    if valid {
        Ok(name.to_owned())
    } else {
        Err(StoreError::InvalidName(MAX_NAME_CHARS))
    }
}

/// Leaves the tenant's role for the platform's inside the same transaction, which is how the token
/// is written in the transaction that wrote the row. Store code only: it is `RESET ROLE`.
pub(crate) async fn into_platform(
    tx: &mut Transaction<'static, Postgres>,
) -> Result<(), StoreError> {
    sqlx::query("RESET ROLE")
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query("leave the tenant's role"))?;
    scope_to_platform(tx).await
}

/// Writes one token row. `revoked_at` is an ISO timestamp for a token that arrives already
/// revoked (an import), `None` for a live one.
pub(crate) async fn insert_token(
    tx: &mut Transaction<'static, Postgres>,
    ctx: &TenantCtx,
    kind: TokenKind,
    subject: &str,
    hash: &TokenHash,
    revoked_at: Option<&str>,
) -> Result<u64, StoreError> {
    sqlx::query(
        "INSERT INTO api_tokens (token_hash, tenant_id, kind, subject_id, revoked_at) \
         VALUES ($1, $2, $3, $4, $5::text::timestamptz) ON CONFLICT (token_hash) DO NOTHING",
    )
    .bind(hash.as_str())
    .bind(ctx.id().as_str())
    .bind(kind.as_str())
    .bind(subject)
    .bind(revoked_at)
    .execute(&mut **tx)
    .await
    .map(|done| done.rows_affected())
    .map_err(StoreError::query("store a token"))
}

async fn revoke_tokens(
    tx: &mut Transaction<'static, Postgres>,
    ctx: &TenantCtx,
    kind: TokenKind,
    subject: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3 AND revoked_at IS NULL",
    )
    .bind(ctx.id().as_str())
    .bind(kind.as_str())
    .bind(subject)
    .execute(&mut **tx)
    .await
    .map(drop)
    .map_err(StoreError::query("revoke a token"))
}

impl Database {
    /// A new row named `name` and the token that acts as it. The token is returned once and
    /// stored only as a hash.
    pub(crate) async fn issue_subject(
        &self,
        ctx: &TenantCtx,
        table: Table,
        name: &str,
    ) -> Result<(String, Secret), StoreError> {
        const ACTION: &str = "issue a token";
        let name = clean_name(name)?;
        let id = random_id(table.id_prefix())?;
        let token = generate_token(table.kind())?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO {} (id, name) VALUES ($1, $2)",
            table.name()
        )))
        .bind(&id)
        .bind(&name)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        into_platform(&mut tx).await?;
        let hash = TokenHash::of(token.expose());
        insert_token(&mut tx, ctx, table.kind(), &id, &hash, None).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok((id, token))
    }

    /// Replaces the token of an existing row: the old ones stop working at once and a new one is
    /// returned. Also pairs a revoked row again. `None` when the tenant has no such row.
    pub(crate) async fn rotate_subject(
        &self,
        ctx: &TenantCtx,
        table: Table,
        id: &str,
    ) -> Result<Option<Secret>, StoreError> {
        const ACTION: &str = "rotate a token";
        let token = generate_token(table.kind())?;
        let mut tx = self.begin(ctx).await?;
        let found = sqlx::query(AssertSqlSafe(format!(
            "UPDATE {} SET revoked_at = NULL WHERE id = $1",
            table.name()
        )))
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if found == 0 {
            return Ok(None);
        }
        into_platform(&mut tx).await?;
        revoke_tokens(&mut tx, ctx, table.kind(), id).await?;
        let hash = TokenHash::of(token.expose());
        insert_token(&mut tx, ctx, table.kind(), id, &hash, None).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(token))
    }

    /// Revokes every token of the row and marks it revoked. `false` when the tenant has no such
    /// row. Revoking twice is not an error.
    pub(crate) async fn revoke_subject(
        &self,
        ctx: &TenantCtx,
        table: Table,
        id: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "revoke a token";
        let mut tx = self.begin(ctx).await?;
        let found = sqlx::query(AssertSqlSafe(format!(
            "UPDATE {} SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
            table.name()
        )))
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if found == 0 {
            return Ok(false);
        }
        into_platform(&mut tx).await?;
        revoke_tokens(&mut tx, ctx, table.kind(), id).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }
}
