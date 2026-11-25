//! One-use invitations: how a person added by an admin chooses their own password.
//!
//! An invitation is a random token of 256 bits, shown once to the admin, who passes it on. The
//! database keeps its SHA-256, an expiry and whether it was used. Accepting it sets the password
//! and signs the person in; the same token never works twice, and a token that has expired or
//! was used says nothing about which of the two it was. There is no email in a self-hosted
//! install: the admin hands the token over.

use std::time::Duration;

use sqlx::AssertSqlSafe;

use super::sessions::Login;
use super::{NewUser, Role, USER_COLUMNS, User, UserRow, insert_user};
use crate::secrets::Secret;
use crate::tokens::{TokenHash, generate_prefixed};
use crate::{Database, StoreError, TenantCtx};

/// The longest an invitation token is taken to be, in bytes. A real one is 46.
const MAX_INVITE_LEN: usize = 128;

/// A user added without a password, and the way to give them one.
#[derive(Debug)]
pub struct Invite {
    /// The person, who cannot sign in yet.
    pub user: User,
    /// What they present to [`Database::accept_invite`]. Shown once: the store keeps its hash.
    pub token: Secret,
    /// When it stops working, UTC ISO 8601.
    pub expires_at: String,
}

impl Database {
    /// Adds a user with no password and an invitation that works once for `ttl`.
    pub async fn invite_user(
        &self,
        ctx: &TenantCtx,
        email: &str,
        name: &str,
        role: Role,
        ttl: Duration,
    ) -> Result<Invite, StoreError> {
        const ACTION: &str = "invite a user";
        let new = NewUser {
            email,
            name,
            role,
            password: None,
            must_change_password: false,
        };
        let token = generate_prefixed("ji_")?;
        let mut tx = self.begin(ctx).await?;
        let user = insert_user(&mut tx, &new, None).await?;
        let expires_at: String = sqlx::query_scalar(
            "INSERT INTO user_invites (token_hash, user_id, expires_at) \
             VALUES ($1, $2, now() + make_interval(secs => $3)) \
             RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
        )
        .bind(TokenHash::of(token.expose()).as_str())
        .bind(user.id.as_str())
        .bind(ttl.as_secs_f64())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Invite {
            user,
            token,
            expires_at,
        })
    }

    /// Spends an invitation: the person's password becomes `password` and they are signed in
    /// for `session_ttl`. [`StoreError::InvalidInvite`] for a token that is unknown, used,
    /// expired or whose user was disabled in the meantime; the password is checked first, so a
    /// refusal for it does not use the invitation up.
    pub async fn accept_invite(
        &self,
        ctx: &TenantCtx,
        token: &str,
        password: &str,
        session_ttl: Duration,
    ) -> Result<Login, StoreError> {
        const ACTION: &str = "accept an invitation";
        crate::passwords::check_password(password)?;
        if token.is_empty() || token.len() > MAX_INVITE_LEN {
            return Err(StoreError::InvalidInvite);
        }
        let hash = TokenHash::of(token);
        // Before hashing: a made-up token should cost a lookup, not 19 MiB of argon2.
        let mut tx = self.begin(ctx).await?;
        let live: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT FROM user_invites WHERE token_hash = $1 \
             AND used_at IS NULL AND expires_at > now())",
        )
        .bind(hash.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        drop(tx);
        if !live {
            return Err(StoreError::InvalidInvite);
        }
        let password_hash = self.hash_password(password).await?;
        let mut tx = self.begin(ctx).await?;
        // The claim and the password are one transaction, and the claim is the UPDATE: of two
        // that race, one gets the row back and the other gets nothing.
        let claimed: Option<String> = sqlx::query_scalar(
            "UPDATE user_invites SET used_at = now() WHERE token_hash = $1 \
             AND used_at IS NULL AND expires_at > now() RETURNING user_id",
        )
        .bind(hash.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(user_id) = claimed else {
            return Err(StoreError::InvalidInvite);
        };
        let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE users SET password_hash = $2, must_change_password = false \
             WHERE id = $1 AND disabled_at IS NULL RETURNING {USER_COLUMNS}"
        )))
        .bind(&user_id)
        .bind(password_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // A disabled user rolls the claim back by dropping `tx`: the token stays unused, but it
        // opens nothing.
        let Some(row) = row else {
            return Err(StoreError::InvalidInvite);
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.start_session(ctx, row.into(), session_ttl).await
    }
}
