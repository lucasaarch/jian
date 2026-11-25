//! Invitations: how someone an admin names becomes a member without the admin knowing a
//! password.
//!
//! An invitation is a random token of 256 bits, shown once to the admin, who passes it on, by
//! link or by e-mail (the e-mail is `jian-server`'s job, which records how it went here). The
//! database keeps the token's SHA-256, an expiry, and whether it was used or revoked. The
//! invitation has an id of its own that does not change: "copy the link" and "send it again"
//! replace the token of the same invitation ([`Database::rotate_invite`]), so the admin sees one
//! invitation per address and the old token dies. It works once. Issuing a new invitation for
//! the same address in the same tenant revokes the first. A token that is unknown, used,
//! revoked or expired is the same refusal, [`StoreError::InvalidInvite`].

use std::time::Duration;

use sqlx::AssertSqlSafe;

use crate::accounts::{NewAccount, find_or_create_account, normalize_email};
use crate::machines::iso;
use crate::members::{Member, Role, insert_member, member_in};
use crate::secrets::Secret;
use crate::tokens::{AccountId, TokenHash, generate_prefixed, random_id};
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

/// How sending an invitation by e-mail stands. It says nothing about whether the person read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendStatus {
    /// No e-mail was sent for this token: a link only, or the link was copied while a send waited.
    Unsent,
    /// A job is to send it.
    Pending,
    /// The provider took it.
    Sent,
    /// It will not be sent; [`Invite::send_error`] says why.
    Failed,
}

impl SendStatus {
    /// The word the database keeps.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsent => "none",
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "pending" => Self::Pending,
            "sent" => Self::Sent,
            "failed" => Self::Failed,
            _ => Self::Unsent,
        }
    }
}

/// How a send ended, for [`Database::finish_invite_send`].
#[derive(Clone, Copy, Debug)]
pub enum SendOutcome<'a> {
    /// The provider took it, and maybe said its id for the message.
    Sent {
        /// The provider's id.
        message_id: Option<&'a str>,
    },
    /// It will not be sent. The reason is short and holds no key or message body.
    Failed {
        /// Why.
        reason: &'a str,
    },
}

/// The longest `send_error` kept, in characters.
const MAX_SEND_ERROR_CHARS: usize = 300;

/// One invitation as listed. The token is not in it: it was shown once, when it was made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    /// What names it to list, revoke, copy and resend. It stays the same when its token is
    /// replaced.
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
    /// How sending it by e-mail stands.
    pub send_status: SendStatus,
    /// Why the last send failed, short; cleared when a new send is queued.
    pub send_error: Option<String>,
    /// When the provider took the e-mail, UTC ISO 8601.
    pub sent_at: Option<String>,
    /// The provider's id for that e-mail, when it gave one.
    pub provider_message_id: Option<String>,
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
    send_status: String,
    send_error: Option<String>,
    sent_at: Option<String>,
    provider_message_id: Option<String>,
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
            send_status: SendStatus::parse(&row.send_status),
            send_error: row.send_error,
            sent_at: row.sent_at,
            provider_message_id: row.provider_message_id,
        }
    }
}

const INVITE_COLUMNS: &str = concat!(
    "id, email, role, invited_by, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("expires_at"),
    " AS expires_at, CASE WHEN used_at IS NOT NULL THEN 'used' \
     WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' \
     ELSE 'pending' END AS status, send_status, send_error, ",
    iso!("sent_at"),
    " AS sent_at, provider_message_id"
);

/// What makes an invitation live: not used, not revoked, not expired.
const LIVE: &str = "used_at IS NULL AND revoked_at IS NULL AND expires_at > now()";

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
            "INSERT INTO invites (id, token_hash, tenant_id, email, role, invited_by, expires_at) \
             VALUES ($7, $1, $2, $3, $4, $5, now() + make_interval(secs => $6)) \
             RETURNING {INVITE_COLUMNS}"
        )))
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(&email)
        .bind(role.as_str())
        .bind(invited_by.map(AccountId::as_str))
        .bind(ttl.as_secs_f64())
        .bind(random_id("inv_")?)
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
            "UPDATE invites SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 \
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

    /// Replaces the token of a live invitation of the tenant with a new one and gives the expiry
    /// a new `ttl`, so the old token stops working at once. The id, the address and the role stay.
    /// `None` when the tenant has no such live invitation (another tenant's is none). This is
    /// what "copy the link" and "send it again" do.
    ///
    /// `cancel_pending_send`: a send that was waiting is set to [`SendStatus::Unsent`], because
    /// the token it was going to mail is the one that just died. A send that is itself rotating
    /// passes `false`.
    pub async fn rotate_invite(
        &self,
        ctx: &TenantCtx,
        id: &str,
        ttl: Duration,
        cancel_pending_send: bool,
    ) -> Result<Option<IssuedInvite>, StoreError> {
        const ACTION: &str = "replace an invitation's token";
        let token = generate_prefixed("ji_")?;
        let hash = TokenHash::of(token.expose());
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<InviteRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE invites SET token_hash = $3, expires_at = now() + make_interval(secs => $4), \
             send_status = CASE WHEN $5 AND send_status = 'pending' THEN 'none' ELSE send_status END \
             WHERE tenant_id = $1 AND id = $2 AND {LIVE} RETURNING {INVITE_COLUMNS}"
        )))
        .bind(ctx.id().as_str())
        .bind(id)
        .bind(hash.as_str())
        .bind(ttl.as_secs_f64())
        .bind(cancel_pending_send)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.map(|row| IssuedInvite {
            invite: row.into(),
            token,
        }))
    }

    /// Marks a live invitation of the tenant as waiting for its e-mail to be sent, and clears
    /// the last error. `None` when the tenant has no such live invitation. Call it before
    /// queueing the job, so the job's result is never overwritten by this.
    pub async fn queue_invite_send(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<Option<Invite>, StoreError> {
        const ACTION: &str = "queue an invitation's e-mail";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<InviteRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE invites SET send_status = 'pending', send_error = NULL \
             WHERE tenant_id = $1 AND id = $2 AND {LIVE} RETURNING {INVITE_COLUMNS}"
        )))
        .bind(ctx.id().as_str())
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.map(Invite::from))
    }

    /// Records how a send ended, only while the invitation is still waiting for it
    /// ([`SendStatus::Pending`]) and, when `generation` is given, still has that token: a token
    /// replaced since (the link was copied, the invitation was sent again) belongs to a newer
    /// send or to none, and this one's result must not overwrite it. `false` when nothing was
    /// recorded for either reason.
    pub async fn finish_invite_send(
        &self,
        ctx: &TenantCtx,
        id: &str,
        generation: Option<&TokenHash>,
        outcome: SendOutcome<'_>,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "record an invitation's e-mail";
        let (status, error, message_id) = match outcome {
            SendOutcome::Sent { message_id } => (SendStatus::Sent, None, message_id),
            SendOutcome::Failed { reason } => (SendStatus::Failed, Some(reason), None),
        };
        let error: Option<String> = error.map(|reason| {
            reason
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(MAX_SEND_ERROR_CHARS)
                .collect()
        });
        let mut tx = self.platform_tx(ACTION).await?;
        let done = sqlx::query(
            "UPDATE invites SET send_status = $3, send_error = $4, \
             sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END, \
             provider_message_id = $5 \
             WHERE tenant_id = $1 AND id = $2 AND send_status = 'pending' \
             AND ($6::text IS NULL OR token_hash = $6)",
        )
        .bind(ctx.id().as_str())
        .bind(id)
        .bind(status.as_str())
        .bind(error)
        .bind(message_id)
        .bind(generation.map(TokenHash::as_str))
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
