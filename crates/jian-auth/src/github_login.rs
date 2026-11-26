//! Signing in with GitHub, and linking and unlinking it.
//!
//! A round trip has two halves and the gateway's two routes are them: `start` makes a `state` and
//! a PKCE verifier and says where to send the person; the `callback` hands back the `code` and
//! the `state`. The state is the whole of the CSRF defence and of the PKCE binding: it is random,
//! kept as a hash, short-lived, and used by one statement that marks it, so a second use, a
//! guess, a stale one and one made for another purpose are all [`AuthError::InvalidState`].
//!
//! Who gets in: an account that already has this GitHub user id linked; or, the first time, the
//! member whose address GitHub marks **verified** (an unverified address proves nothing). There
//! is no sign-up here: a GitHub user who matches nobody is [`AuthError::GithubNotAMember`]. The
//! Cloud's backend makes the account first and then calls the same functions.

use std::sync::Arc;

use jian_store::{AccountId, CredentialKind, Database, GithubLink, LoginPurpose, TenantId};

use crate::github::{GithubApp, GithubIdentity};
use crate::{Auth, AuthError, LoginOutcome};

impl Auth {
    /// Turns GitHub sign-in on, with this OAuth App. It only works where the policy also allows
    /// `github`.
    #[must_use]
    pub fn with_github(mut self, app: GithubApp) -> Self {
        self.github = Some(Arc::new(app));
        self
    }

    /// Whether GitHub sign-in is allowed and set up here.
    pub fn github_enabled(&self) -> bool {
        self.github.is_some() && self.policy.allows(CredentialKind::Github)
    }

    fn github_app(&self) -> Result<&GithubApp, AuthError> {
        self.policy.require(CredentialKind::Github)?;
        self.github
            .as_deref()
            .ok_or(AuthError::NotConfigured(CredentialKind::Github))
    }

    /// Starts a sign-in: the GitHub address to send the person to. `tenant` is the workspace to
    /// open, kept with the state; left out, the account's only one is opened.
    pub async fn github_start(
        &self,
        db: &Database,
        tenant: Option<&TenantId>,
    ) -> Result<String, AuthError> {
        let app = self.github_app()?;
        if let Some(tenant) = tenant {
            known_tenant(db, tenant).await?;
        }
        let made = db
            .create_login_state(LoginPurpose::SignIn, tenant, None, self.state_ttl)
            .await?;
        Ok(app.authorize_url(made.state.expose(), made.verifier.expose()))
    }

    /// Finishes a sign-in: the code and the state GitHub's redirect carried. Either the account
    /// has this GitHub linked, or a member has a verified address GitHub vouches for, in which
    /// case it is linked now. The session is the one a password sign-in makes.
    pub async fn github_sign_in(
        &self,
        db: &Database,
        code: &str,
        state: &str,
    ) -> Result<LoginOutcome, AuthError> {
        let app = self.github_app()?;
        let used = db
            .use_login_state(state, LoginPurpose::SignIn)
            .await?
            .ok_or(AuthError::InvalidState)?;
        let identity = app.identity(code, used.verifier.expose()).await?;
        let (found, linked) = match db.account_by_github(&identity.id).await? {
            Some(account) => {
                let account = db
                    .account(&account)
                    .await?
                    .ok_or(AuthError::GithubNotAMember)?;
                (db.login_candidate(&account.email).await?, true)
            }
            None => (member_by_verified_email(db, &identity).await?, false),
        };
        let found = found.ok_or(AuthError::GithubNotAMember)?;
        let tenant = Self::choose_tenant(&found, used.tenant.as_ref())?
            .ok_or(AuthError::GithubNotAMember)?;
        // Only now: a person who could not be let in must not end up linked.
        if !linked {
            db.link_github(&found.account.id, &identity.id, &identity.login)
                .await?;
        }
        self.start(db, &found, tenant, CredentialKind::Github).await
    }

    /// Starts adding GitHub to the account of a signed-in member.
    pub async fn github_link_start(
        &self,
        db: &Database,
        account: &AccountId,
    ) -> Result<String, AuthError> {
        let app = self.github_app()?;
        let made = db
            .create_login_state(LoginPurpose::Link, None, Some(account), self.state_ttl)
            .await?;
        Ok(app.authorize_url(made.state.expose(), made.verifier.expose()))
    }

    /// Finishes adding GitHub. The state must be the one this account started: another
    /// member's state is [`AuthError::InvalidState`]. A GitHub user who is already somebody
    /// else's is refused ([`StoreError::GithubTaken`](jian_store::StoreError)).
    pub async fn github_link(
        &self,
        db: &Database,
        account: &AccountId,
        code: &str,
        state: &str,
    ) -> Result<GithubLink, AuthError> {
        let app = self.github_app()?;
        let used = db
            .use_login_state(state, LoginPurpose::Link)
            .await?
            .ok_or(AuthError::InvalidState)?;
        if used.account.as_ref() != Some(account) {
            return Err(AuthError::InvalidState);
        }
        let identity = app.identity(code, used.verifier.expose()).await?;
        db.link_github(account, &identity.id, &identity.login)
            .await?;
        Ok(GithubLink {
            id: identity.id,
            login: identity.login,
        })
    }

    /// Removes the GitHub link, unless it is the last way the account has to sign in
    /// ([`AuthError::LastSignInMethod`]): a password it can still use, or the link by e-mail
    /// (which every address has when the policy allows it) is what keeps them from being locked
    /// out.
    pub async fn github_unlink(&self, db: &Database, account: &AccountId) -> Result<(), AuthError> {
        if db.github_link(account).await?.is_none() {
            return Err(AuthError::NotLinked);
        }
        let password = self.policy.allows(CredentialKind::Password)
            && db.password_credential(account).await?.is_some();
        if !password && !self.policy.allows(CredentialKind::EmailLink) {
            return Err(AuthError::LastSignInMethod);
        }
        db.unlink_github(account).await?;
        Ok(())
    }
}

async fn known_tenant(db: &Database, tenant: &TenantId) -> Result<(), AuthError> {
    match db.tenant(tenant.clone()).await {
        Ok(_) => Ok(()),
        Err(jian_store::StoreError::TenantNotFound(_)) => Err(AuthError::UnknownTenant),
        Err(other) => Err(other.into()),
    }
}

/// The member with one of GitHub's verified addresses, if any.
async fn member_by_verified_email(
    db: &Database,
    identity: &GithubIdentity,
) -> Result<Option<jian_store::LoginCandidate>, AuthError> {
    for email in &identity.verified_emails {
        if let Some(found) = db.login_candidate(email).await?
            && !found.account.disabled
            && !found.tenants.is_empty()
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}
