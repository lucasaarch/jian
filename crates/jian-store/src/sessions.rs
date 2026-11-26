//! Sessions: what a person holds after signing in, and what a sign-in looks up.
//!
//! A session is a row of `platform.api_tokens` of kind `session`: an opaque bearer that acts as
//! one account in ONE tenant, expires, and is kept as a hash only. What opens it, and whether the
//! account may still use it, is checked on every request by [`Database::authenticate`]. Proving
//! who the person is (the password) is not here: that is `jian-auth`'s, which asks this module for
//! the candidate and writes the session once it is satisfied.

use std::time::Duration;

use crate::accounts::{Account, normalize_email};
use crate::credentials::{PasswordCredential, password_of};
use crate::members::Role;
use crate::secrets::Secret;
use crate::tokens::{AccountId, TokenHash, TokenKind, generate_token};
use crate::{Database, StoreError, TenantCtx, TenantId};

/// Everything a sign-in by password needs to decide, read in one go.
#[derive(Debug)]
pub struct LoginCandidate {
    /// The account with this address.
    pub account: Account,
    /// The tenants it may open now (member not disabled), oldest membership first.
    pub tenants: Vec<(TenantId, Role)>,
    /// Its password, if it has one.
    pub password: Option<PasswordCredential>,
}

/// A session just written: the token, shown once, and when it ends.
#[derive(Debug)]
pub struct NewSession {
    /// What the person presents from now on. The store keeps only its hash.
    pub token: Secret,
    /// When the session ends, UTC ISO 8601.
    pub expires_at: String,
}

/// Ends the sessions of an account: in one tenant when `tenant` is given, in every tenant when
/// not; all but `keep` when given. Only sessions: a machine's or a phone's token is not one.
pub(crate) async fn revoke_sessions(
    tx: &mut sqlx::PgConnection,
    account: &AccountId,
    tenant: Option<&str>,
    keep: Option<&TokenHash>,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE kind = 'session' AND subject_id = $1 AND revoked_at IS NULL \
         AND ($2::text IS NULL OR tenant_id = $2) AND ($3::text IS NULL OR token_hash <> $3)",
    )
    .bind(account.as_str())
    .bind(tenant)
    .bind(keep.map(TokenHash::as_str))
    .execute(&mut *tx)
    .await
    .map(drop)
    .map_err(StoreError::query("end sessions"))
}

impl Database {
    /// The account with this address, the tenants it belongs to and its password, or `None`
    /// for an address that is not one or that no account has.
    pub async fn login_candidate(&self, email: &str) -> Result<Option<LoginCandidate>, StoreError> {
        const ACTION: &str = "read an account to sign in";
        let Ok(email) = normalize_email(email) else {
            return Ok(None);
        };
        let Some(account) = self.account_by_email(&email).await? else {
            return Ok(None);
        };
        let mut tx = self.platform_tx(ACTION).await?;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT tenant_id, role FROM members WHERE account_id = $1 AND disabled_at IS NULL \
             ORDER BY seq",
        )
        .bind(account.id.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let tenants = rows
            .into_iter()
            .filter_map(|(tenant, role)| {
                Some((TenantId::parse(&tenant).ok()?, Role::parse(&role)?))
            })
            .collect();
        let password = password_of(&mut tx, &account.id).await?;
        Ok(Some(LoginCandidate {
            account,
            tenants,
            password,
        }))
    }

    /// Starts a session of `ttl` for the account in the tenant. The caller has already proved
    /// who the person is and that they belong here.
    pub async fn start_session(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
        ttl: Duration,
    ) -> Result<NewSession, StoreError> {
        const ACTION: &str = "start a session";
        let token = generate_token(TokenKind::Session)?;
        let hash = TokenHash::of(token.expose());
        let mut tx = self.platform_tx(ACTION).await?;
        let expires_at: String = sqlx::query_scalar(
            "INSERT INTO api_tokens (token_hash, tenant_id, kind, subject_id, account_id, expires_at) \
             VALUES ($1, $2, 'session', $3, $3, now() + make_interval(secs => $4)) \
             RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
        )
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(account.as_str())
        .bind(ttl.as_secs_f64())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(NewSession { token, expires_at })
    }

    /// Ends one session. Only a session token is touched: the owner's, a machine's and a
    /// phone's are not ended by calling this with them.
    pub async fn end_session(&self, token: &TokenHash) -> Result<(), StoreError> {
        const ACTION: &str = "end a session";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "UPDATE api_tokens SET revoked_at = now() \
             WHERE token_hash = $1 AND kind = 'session' AND revoked_at IS NULL",
        )
        .bind(token.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
