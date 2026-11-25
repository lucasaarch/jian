//! Credentials: the ways an account proves who it is, one row each.
//!
//! The store keeps what a credential is and checks nothing about it: whether a password is
//! right, and whether a deploy accepts a kind at all, are `jian-auth`'s. Only the password is
//! implemented. The others (`github`, `email_link`, `passkey`, `totp`) exist so the table and
//! [`CredentialKind`] need no migration when they arrive.
//!
//! A password credential's `secret` is the argon2id hash in PHC form, never the password. The
//! material of a future passkey or TOTP is encrypted, through the vault, before it is written
//! here.

use crate::members::{Member, member_in};
use crate::secrets::Secret;
use crate::sessions::revoke_sessions;
use crate::tokens::{AccountId, TokenHash, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A way of signing in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CredentialKind {
    /// An email address and a password.
    Password,
    /// A GitHub login (the Cloud).
    Github,
    /// A link sent to the address, a magic link (the Cloud).
    EmailLink,
    /// A passkey. Not implemented yet.
    Passkey,
    /// A second factor, a one-time code. Not implemented yet.
    Totp,
}

impl CredentialKind {
    /// Every kind the table accepts.
    pub const ALL: [Self; 5] = [
        Self::Password,
        Self::Github,
        Self::EmailLink,
        Self::Passkey,
        Self::Totp,
    ];

    /// How the kind is written in `credentials.kind`, and in configuration.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Github => "github",
            Self::EmailLink => "email_link",
            Self::Passkey => "passkey",
            Self::Totp => "totp",
        }
    }

    /// The kind written as [`as_str`](CredentialKind::as_str) does.
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }
}

/// An account's password, as the login needs it.
#[derive(Debug)]
pub struct PasswordCredential {
    /// The argon2id hash, in PHC form.
    pub hash: Secret,
    /// An admin chose this password: it must be replaced before anything else.
    pub must_change: bool,
}

impl Database {
    /// The account's password credential, if it has one.
    pub async fn password_credential(
        &self,
        account: &AccountId,
    ) -> Result<Option<PasswordCredential>, StoreError> {
        const ACTION: &str = "read a credential";
        let mut tx = self.platform_tx(ACTION).await?;
        password_of(&mut tx, account).await
    }

    /// Notes that the account just signed in with a credential of this kind.
    pub async fn touch_credential(
        &self,
        account: &AccountId,
        kind: CredentialKind,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "note a sign-in";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "UPDATE credentials SET last_used_at = now() WHERE account_id = $1 AND kind = $2",
        )
        .bind(account.as_str())
        .bind(kind.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Replaces the account's password when it is still `old` (what the caller verified): a
    /// reset in between wins, and this answers `false`. The new password is not provisional.
    /// Every session of the account ends, in every tenant, except `keep`, the one that made the
    /// change: the password is the account's, not a workspace's, and a stolen session must not
    /// outlive it.
    pub async fn replace_password(
        &self,
        account: &AccountId,
        old: &Secret,
        new_hash: &str,
        keep: &TokenHash,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "change a password";
        let mut tx = self.platform_tx(ACTION).await?;
        let changed = sqlx::query(
            "UPDATE credentials SET secret = $3, must_change = false \
             WHERE account_id = $1 AND kind = 'password' AND secret = $2",
        )
        .bind(account.as_str())
        .bind(old.expose())
        .bind(new_hash)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        revoke_sessions(&mut tx, account, None, Some(keep)).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// Sets a password an admin of the tenant chose: the person must replace it at their next
    /// sign-in and every session they have ends. `None` when the account is not a member of
    /// the tenant.
    ///
    /// Refused with [`StoreError::AccountInOtherTenants`] when the account is a member of
    /// another workspace too: the password is theirs everywhere, and one workspace's admin
    /// must not change what they sign in with in another. The person changes their own.
    pub async fn reset_password(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
        new_hash: &str,
    ) -> Result<Option<Member>, StoreError> {
        const ACTION: &str = "reset a password";
        let mut tx = self.platform_tx(ACTION).await?;
        if member_in(&mut tx, ctx.id().as_str(), account)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        let elsewhere: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT FROM members WHERE account_id = $1 AND tenant_id <> $2)",
        )
        .bind(account.as_str())
        .bind(ctx.id().as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if elsewhere {
            return Err(StoreError::AccountInOtherTenants);
        }
        sqlx::query(
            "INSERT INTO credentials (id, account_id, kind, secret, must_change) \
             VALUES ($1, $2, 'password', $3, true) \
             ON CONFLICT (account_id) WHERE kind = 'password' \
             DO UPDATE SET secret = EXCLUDED.secret, must_change = true",
        )
        .bind(random_id("crd_")?)
        .bind(account.as_str())
        .bind(new_hash)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        revoke_sessions(&mut tx, account, None, None).await?;
        let member = member_in(&mut tx, ctx.id().as_str(), account).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(member)
    }
}

pub(crate) async fn password_of(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    account: &AccountId,
) -> Result<Option<PasswordCredential>, StoreError> {
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT secret, must_change FROM credentials WHERE account_id = $1 AND kind = 'password'",
    )
    .bind(account.as_str())
    .fetch_optional(&mut **tx)
    .await
    .map_err(StoreError::query("read a credential"))?;
    Ok(row.map(|(hash, must_change)| PasswordCredential {
        hash: Secret::new(hash),
        must_change,
    }))
}
