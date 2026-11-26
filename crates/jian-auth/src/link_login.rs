//! Signing in with a link sent by e-mail (a magic link).
//!
//! Asking for a link must not tell whether an address belongs to a member, so the work is split
//! in a way that the answer to the request cannot depend on it: the request only queues a job
//! (`jian-server`), and [`Auth::issue_login_link`], which the job calls, is the one place that
//! looks at the address. It makes a token for a member and nothing for anybody else. The token is
//! random, kept as a hash, works once for [`Auth::with_link_ttl`] (15 minutes), and making
//! another for the same address in the same workspace kills the first.

use std::time::Duration;

use jian_store::secrets::Secret;
use jian_store::{CredentialKind, Database, TenantId, normalize_email};

use crate::{Auth, AuthError, LoginOutcome};

/// A link made for a member: what goes in the e-mail.
#[derive(Debug)]
pub struct IssuedLoginLink {
    /// The token, which the link carries. Shown once.
    pub token: Secret,
    /// The address, as stored.
    pub email: String,
    /// How long the link works.
    pub ttl: Duration,
}

impl Auth {
    /// Whether the policy lets people sign in by a link sent to their address.
    pub fn login_link_enabled(&self) -> bool {
        self.policy.allows(CredentialKind::EmailLink)
    }

    /// Makes a link for `email` to open `tenant`, or `None` when the address is not an active
    /// member of it (no account, a disabled one or member, another workspace). Calling it for a
    /// non-member writes nothing.
    pub async fn issue_login_link(
        &self,
        db: &Database,
        tenant: &TenantId,
        email: &str,
    ) -> Result<Option<IssuedLoginLink>, AuthError> {
        self.policy.require(CredentialKind::EmailLink)?;
        let Ok(email) = normalize_email(email) else {
            return Ok(None);
        };
        let Some(found) = db.login_candidate(&email).await? else {
            return Ok(None);
        };
        if found.account.disabled || !found.tenants.iter().any(|(t, _)| t == tenant) {
            return Ok(None);
        }
        let token = db.create_login_link(tenant, &email, self.link_ttl).await?;
        Ok(Some(IssuedLoginLink {
            token,
            email,
            ttl: self.link_ttl,
        }))
    }

    /// Spends a link and starts a session in the workspace it was made for, the same session a
    /// password sign-in makes. Unknown, used, replaced and expired links are
    /// [`AuthError::InvalidLink`], all the same; so is one whose member was disabled since.
    pub async fn redeem_login_link(
        &self,
        db: &Database,
        token: &str,
    ) -> Result<LoginOutcome, AuthError> {
        self.policy.require(CredentialKind::EmailLink)?;
        let live = db
            .live_login_link(token)
            .await?
            .ok_or(AuthError::InvalidLink)?;
        let found = db
            .login_candidate(&live.email)
            .await?
            .ok_or(AuthError::InvalidLink)?;
        let tenant =
            Self::choose_tenant(&found, Some(&live.tenant))?.ok_or(AuthError::InvalidLink)?;
        // The one that wins the race starts the session; the other is told the link is spent.
        if !db.use_login_link(token).await? {
            return Err(AuthError::InvalidLink);
        }
        self.start(db, &found, tenant, CredentialKind::EmailLink)
            .await
    }
}
