//! Signing in and out, and changing a password.
//!
//! A session is a row of `platform.api_tokens` of kind `session` that acts as the user and
//! expires. Like every token it is kept as a hash only.

use std::time::Duration;

use sqlx::AssertSqlSafe;

use super::{Role, USER_COLUMNS, User, UserRow, normalize_email};
use crate::passwords::{MAX_PASSWORD_BYTES, check_password};
use crate::secrets::Secret;
use crate::subjects::into_platform;
use crate::tokens::{TokenHash, TokenKind, UserId, generate_token};
use crate::{Database, StoreError, TenantCtx, TenantId};

/// A new session: the token, shown once, and who it is for.
#[derive(Debug)]
pub struct Login {
    /// What the person presents from now on. The store keeps only its hash.
    pub token: Secret,
    /// When the session ends, UTC ISO 8601.
    pub expires_at: String,
    /// Who signed in.
    pub user: User,
}

/// What a sign-in attempt came to.
#[derive(Debug)]
pub enum LoginOutcome {
    /// The password was right.
    Granted(Login),
    /// No such user, a wrong password, a disabled user, or a user with no password yet. The four
    /// are the same answer on purpose, and cost about the same time.
    Refused,
}

/// A user and the hash of their password, which [`User`] never carries.
#[derive(sqlx::FromRow)]
struct Credentials {
    #[sqlx(flatten)]
    user: UserRow,
    hash: Option<String>,
}

impl Database {
    /// Checks an email address and a password and, if they are right, starts a session of `ttl`.
    ///
    /// An address that is not a user's still costs a password hash, so the answer and its timing
    /// do not tell whether the address is registered. A password over the limit is refused
    /// before hashing, for the same reason for every address. Slowing down guesses (a lockout
    /// by address) is the caller's: the store only checks.
    pub async fn login(
        &self,
        ctx: &TenantCtx,
        email: &str,
        password: &str,
        ttl: Duration,
    ) -> Result<LoginOutcome, StoreError> {
        if password.len() > MAX_PASSWORD_BYTES {
            return Ok(LoginOutcome::Refused);
        }
        let found = match normalize_email(email) {
            Ok(email) => self.credentials(ctx, &email).await?,
            Err(_) => None,
        };
        let Some((user, hash)) = found else {
            self.spend_a_hash().await;
            return Ok(LoginOutcome::Refused);
        };
        let Some(hash) = hash else {
            self.spend_a_hash().await;
            return Ok(LoginOutcome::Refused);
        };
        let right = self.verify_password(password, &hash).await;
        if !right || user.disabled {
            return Ok(LoginOutcome::Refused);
        }
        self.start_session(ctx, user, ttl)
            .await
            .map(LoginOutcome::Granted)
    }

    /// The user with this (normalized) address and the hash of their password, if they have one.
    async fn credentials(
        &self,
        ctx: &TenantCtx,
        email: &str,
    ) -> Result<Option<(User, Option<String>)>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Credentials> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {USER_COLUMNS}, password_hash AS hash FROM users WHERE email = $1"
        )))
        .bind(email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a user to sign in"))?;
        Ok(row.map(|row| (row.user.into(), row.hash)))
    }

    /// Writes the session token of `user`. The user was just checked by the caller.
    pub(super) async fn start_session(
        &self,
        ctx: &TenantCtx,
        user: User,
        ttl: Duration,
    ) -> Result<Login, StoreError> {
        const ACTION: &str = "start a session";
        let token = generate_token(TokenKind::Session)?;
        let hash = TokenHash::of(token.expose());
        let mut tx = self.platform_tx(ACTION).await?;
        let expires_at: String = sqlx::query_scalar(
            "INSERT INTO api_tokens (token_hash, tenant_id, kind, subject_id, user_id, expires_at) \
             VALUES ($1, $2, 'session', $3, $3, now() + make_interval(secs => $4)) \
             RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
        )
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(user.id.as_str())
        .bind(ttl.as_secs_f64())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Login {
            token,
            expires_at,
            user,
        })
    }

    /// Ends one session. Only a session token is touched: the owner's, a machine's and a phone's
    /// are not ended by calling this with them.
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

    /// Replaces the password of the signed-in user, who must give the current one. Every other
    /// session of the user ends, so a stolen session does not survive the change; `keep` is the
    /// one that made it. The new password is not a provisional one any more.
    pub async fn change_password(
        &self,
        ctx: &TenantCtx,
        id: &UserId,
        current: &str,
        new: &str,
        keep: &TokenHash,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "change a password";
        check_password(new)?;
        let mut read = self.begin(ctx).await?;
        let old: Option<Option<String>> = sqlx::query_scalar(
            "SELECT password_hash FROM users WHERE id = $1 AND disabled_at IS NULL",
        )
        .bind(id.as_str())
        .fetch_optional(&mut *read)
        .await
        .map_err(StoreError::query(ACTION))?;
        drop(read);
        let Some(old) = old.flatten() else {
            return Err(StoreError::WrongPassword);
        };
        if current.len() > MAX_PASSWORD_BYTES || !self.verify_password(current, &old).await {
            return Err(StoreError::WrongPassword);
        }
        let hash = self.hash_password(new).await?;
        let mut tx = self.begin(ctx).await?;
        // Only if the password is still the one that was checked: a reset in between wins.
        let changed = sqlx::query(
            "UPDATE users SET password_hash = $2, must_change_password = false \
             WHERE id = $1 AND password_hash = $3",
        )
        .bind(id.as_str())
        .bind(hash)
        .bind(&old)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if changed == 0 {
            return Err(StoreError::WrongPassword);
        }
        into_platform(&mut tx).await?;
        sqlx::query(
            "UPDATE api_tokens SET revoked_at = now() \
             WHERE tenant_id = $1 AND kind = 'session' AND subject_id = $2 \
             AND token_hash <> $3 AND revoked_at IS NULL",
        )
        .bind(ctx.id().as_str())
        .bind(id.as_str())
        .bind(keep.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// What a session of this user may do now, or `None` when the user is gone or disabled.
    pub(crate) async fn session_user(
        &self,
        tenant: &TenantId,
        id: &UserId,
    ) -> Result<Option<(Role, bool)>, StoreError> {
        let ctx = self.tenant(tenant.clone()).await?;
        let mut tx = self.begin(&ctx).await?;
        let row: Option<(String, bool)> = sqlx::query_as(
            "SELECT role, must_change_password FROM users WHERE id = $1 AND disabled_at IS NULL",
        )
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a session's user"))?;
        Ok(
            row.map(|(role, must_change)| {
                (Role::parse(&role).unwrap_or(Role::Member), must_change)
            }),
        )
    }
}
