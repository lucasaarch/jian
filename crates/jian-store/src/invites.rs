//! Invitations: how someone an admin names becomes a member without the admin knowing a
//! password.
//!
//! An invitation is a random token of 256 bits, shown once to the admin, who passes it on (sending
//! it by email is not done here). The database keeps its SHA-256, which doubles as the
//! invitation's id for listing and revoking, an expiry, and whether it was used or revoked. It
//! works once. Issuing another for the same address in the same tenant revokes the first, which
//! is what "copy the link" and "send it again" are. A token that is unknown, used, revoked or
//! expired is the same refusal, [`StoreError::InvalidInvite`].

use std::time::Duration;

use sqlx::AssertSqlSafe;

use crate::accounts::{NewAccount, find_or_create_account, normalize_email};
use crate::machines::iso;
use crate::members::{Member, Role, insert_member, member_in};
use crate::secrets::Secret;
use crate::tokens::{AccountId, TokenHash, generate_prefixed};
use crate::{Database, StoreError, TenantCtx, TenantId};

/// The longest an invitation token is taken to be, in bytes. A real one is 46.
pub const MAX_INVITE_TOKEN_LEN: usize = 128;

/// Where an invitation stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InviteStatus {
    /// It can still be accepted.
    Pending,
    /// It was accepted.
    Used,
    /// An admin revoked it, or issued a newer one for the same address.
    Revoked,
    /// Its time ran out.
    Expired,
}

/// One invitation as listed. The token is not in it: it was shown once, when it was made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    /// The SHA-256 of the token, in hex: what names it to list and revoke.
    pub id: String,
    /// The address invited, trimmed and lower case.
    pub email: String,
    /// What the person will be.
    pub role: Role,
    /// The admin who made it; `None` for the owner's command line.
    pub invited_by: Option<AccountId>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it stops working, UTC ISO 8601.
    pub expires_at: String,
    /// Where it stands.
    pub status: InviteStatus,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: String,
    email: String,
    role: String,
    invited_by: Option<String>,
    created_at: String,
    expires_at: String,
    status: String,
}

impl From<InviteRow> for Invite {
    fn from(row: InviteRow) -> Self {
        Self {
            id: row.id,
            email: row.email,
            role: Role::parse(&row.role).unwrap_or(Role::Member),
            invited_by: row.invited_by.map(AccountId::new),
            created_at: row.created_at,
            expires_at: row.expires_at,
            status: match row.status.as_str() {
                "used" => InviteStatus::Used,
                "revoked" => InviteStatus::Revoked,
                "expired" => InviteStatus::Expired,
                _ => InviteStatus::Pending,
            },
        }
    }
}

const INVITE_COLUMNS: &str = concat!(
    "token_hash AS id, email, role, invited_by, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("expires_at"),
    " AS expires_at, CASE WHEN used_at IS NOT NULL THEN 'used' \
     WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' \
     ELSE 'pending' END AS status"
);

/// An invitation just made, and the token that accepts it.
#[derive(Debug)]
pub struct IssuedInvite {
    /// The invitation.
    pub invite: Invite,
    /// What the person gives to accept. Shown once: the store keeps its hash.
    pub token: Secret,
}

/// Where a live invitation leads, read by whoever holds its token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InviteTarget {
    /// The tenant it opens.
    pub tenant: TenantId,
    /// The address it was made for.
    pub email: String,
    /// What the person will be.
    pub role: Role,
}

/// What [`Database::accept_invite`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accepted {
    /// The tenant the person joined.
    pub tenant: TenantId,
    /// The new member.
    pub member: Member,
    /// The account was made now. When `false` it already existed and its credentials are as
    /// they were.
    pub account_created: bool,
}

impl Database {
    /// Makes an invitation for `email` to join the tenant as `role`, working once for `ttl`,
    /// and revokes any live one for the same address. [`StoreError::MemberExists`] when the
    /// address is already a member here.
    pub async fn create_invite(
        &self,
        ctx: &TenantCtx,
        email: &str,
        role: Role,
        invited_by: Option<&AccountId>,
        ttl: Duration,
    ) -> Result<IssuedInvite, StoreError> {
        const ACTION: &str = "invite someone";
        let email = normalize_email(email)?;
        let token = generate_prefixed("ji_")?;
        let hash = TokenHash::of(token.expose());
        let mut tx = self.platform_tx(ACTION).await?;
        let member: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT FROM members m JOIN accounts a ON a.id = m.account_id \
             WHERE m.tenant_id = $1 AND a.email = $2)",
        )
        .bind(ctx.id().as_str())
        .bind(&email)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if member {
            return Err(StoreError::MemberExists);
        }
        sqlx::query(
            "UPDATE invites SET revoked_at = now() \
             WHERE tenant_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL",
        )
        .bind(ctx.id().as_str())
        .bind(&email)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let row: InviteRow = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO invites (token_hash, tenant_id, email, role, invited_by, expires_at) \
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) \
             RETURNING {INVITE_COLUMNS}"
        )))
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(&email)
        .bind(role.as_str())
        .bind(invited_by.map(AccountId::as_str))
        .bind(ttl.as_secs_f64())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(IssuedInvite {
            invite: row.into(),
            token,
        })
    }

    /// The tenant's invitations that can still be accepted, newest first, at most a hundred.
    pub async fn list_invites(&self, ctx: &TenantCtx) -> Result<Vec<Invite>, StoreError> {
        const ACTION: &str = "list invitations";
        let mut tx = self.platform_tx(ACTION).await?;
        let rows: Vec<InviteRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {INVITE_COLUMNS} FROM invites WHERE tenant_id = $1 \
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() \
             ORDER BY created_at DESC LIMIT 100"
        )))
        .bind(ctx.id().as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(rows.into_iter().map(Invite::from).collect())
    }

    /// Revokes a pending invitation of the tenant. `false` when the tenant has no such pending
    /// invitation (another tenant's is none).
    pub async fn revoke_invite(&self, ctx: &TenantCtx, id: &str) -> Result<bool, StoreError> {
        const ACTION: &str = "revoke an invitation";
        let mut tx = self.platform_tx(ACTION).await?;
        let done = sqlx::query(
            "UPDATE invites SET revoked_at = now() WHERE tenant_id = $1 AND token_hash = $2 \
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
        )
        .bind(ctx.id().as_str())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }

    /// Where the invitation of this token leads, or `None` when it is unknown, used, revoked or
    /// expired. Whoever holds the token may ask: it is what names the tenant, as for any token.
    pub async fn live_invite(&self, token: &TokenHash) -> Result<Option<InviteTarget>, StoreError> {
        const ACTION: &str = "read an invitation";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<(String, String, String)> = sqlx::query_as(
            "SELECT tenant_id, email, role FROM invites WHERE token_hash = $1 \
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
        )
        .bind(token.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(row.and_then(|(tenant, email, role)| {
            Some(InviteTarget {
                tenant: TenantId::parse(&tenant).ok()?,
                email,
                role: Role::parse(&role)?,
            })
        }))
    }

    /// Spends the invitation and makes its address a member of its tenant, in one transaction:
    /// a failure leaves the invitation unused. Of two that race for one token, one wins.
    ///
    /// `new` is what a new account is made of; it is not used when the address already has an
    /// account, whose credentials are never touched here. [`StoreError::InvalidInvite`] for a
    /// token that is unknown, used, revoked or expired, for an account that is disabled, and
    /// for an address that has no account when `new` is `None`.
    pub async fn accept_invite(
        &self,
        token: &TokenHash,
        new: Option<NewAccount<'_>>,
    ) -> Result<Accepted, StoreError> {
        const ACTION: &str = "accept an invitation";
        let mut tx = self.platform_tx(ACTION).await?;
        let claimed: Option<(String, String, String, Option<String>)> = sqlx::query_as(
            "UPDATE invites SET used_at = now() WHERE token_hash = $1 \
             AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() \
             RETURNING tenant_id, email, role, invited_by",
        )
        .bind(token.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some((tenant, email, role, invited_by)) = claimed else {
            return Err(StoreError::InvalidInvite);
        };
        let tenant = TenantId::parse(&tenant).map_err(|_| StoreError::InvalidInvite)?;
        let role = Role::parse(&role).ok_or(StoreError::InvalidInvite)?;
        let invited_by = invited_by.map(AccountId::new);
        let existing: Option<(String, bool)> =
            sqlx::query_as("SELECT id, disabled_at IS NOT NULL FROM accounts WHERE email = $1")
                .bind(&email)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let (account, account_created) = match (existing, new) {
            (Some((_, true)), _) | (None, None) => return Err(StoreError::InvalidInvite),
            (Some((id, false)), _) => (AccountId::new(id), false),
            (None, Some(new)) => find_or_create_account(&mut tx, &email, &new).await?,
        };
        insert_member(
            &mut tx,
            tenant.as_str(),
            &account,
            role,
            invited_by.as_ref(),
        )
        .await?;
        let member = member_in(&mut tx, tenant.as_str(), &account)
            .await?
            .ok_or(StoreError::Vanished)?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Accepted {
            tenant,
            member,
            account_created,
        })
    }
}
