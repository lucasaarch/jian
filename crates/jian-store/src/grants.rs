//! What an admin lets a member do beyond what every member may.
//!
//! The list of grants is closed (a CHECK in the schema): a new one is a migration and a line in
//! [`GRANTS`], so nothing a request says can invent one. Only admins hand them out; the server
//! checks that, the store checks that the person is a member.

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::tokens::AccountId;
use crate::{Database, StoreError, TenantCtx};

/// The grants that exist.
pub const GRANTS: &[&str] = &["agents.create"];

/// One grant a member holds.
#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct MemberGrant {
    /// The member.
    pub account_id: String,
    /// What they may do: one of [`GRANTS`].
    pub grant_name: String,
    /// The admin who gave it.
    pub granted_by: String,
    /// When, UTC ISO 8601.
    pub granted_at: String,
}

fn known(name: &str) -> Result<(), StoreError> {
    if GRANTS.contains(&name) {
        Ok(())
    } else {
        Err(StoreError::InvalidWorkspace("that is not a grant"))
    }
}

impl Database {
    /// Whether the member holds the grant.
    pub async fn has_grant(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
        name: &str,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM member_grants WHERE account_id = $1 AND grant_name = $2)",
        )
        .bind(account.as_str())
        .bind(name)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("read a grant"))
    }

    /// Gives a member a grant; giving it again changes nothing. The member must exist and not
    /// be disabled.
    pub async fn grant(
        &self,
        ctx: &TenantCtx,
        admin: &AccountId,
        account: &AccountId,
        name: &str,
    ) -> Result<(), StoreError> {
        known(name)?;
        self.require_members(ctx, std::slice::from_ref(account))
            .await?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO member_grants (account_id, grant_name, granted_by) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(account.as_str())
        .bind(name)
        .bind(admin.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("give a grant"))?;
        tx.commit().await.map_err(StoreError::query("give a grant"))
    }

    /// Takes a grant back; `false` when the member did not hold it.
    pub async fn revoke_grant(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
        name: &str,
    ) -> Result<bool, StoreError> {
        known(name)?;
        let mut tx = self.begin(ctx).await?;
        let done =
            sqlx::query("DELETE FROM member_grants WHERE account_id = $1 AND grant_name = $2")
                .bind(account.as_str())
                .bind(name)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query("take a grant back"))?
                .rows_affected();
        tx.commit()
            .await
            .map_err(StoreError::query("take a grant back"))?;
        Ok(done > 0)
    }

    /// Every grant of the tenant, by member and name. There are few: members times [`GRANTS`].
    pub async fn list_grants(&self, ctx: &TenantCtx) -> Result<Vec<MemberGrant>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT account_id, grant_name, granted_by, {} AS granted_at \
             FROM member_grants ORDER BY account_id, grant_name LIMIT 1000",
            iso!("granted_at")
        )))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list grants"))
    }
}
