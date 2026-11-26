//! Signing in with a password, and changing it.

use jian_store::secrets::Secret;
use jian_store::{
    AccountId, CredentialKind, Database, LoginCandidate, Member, TenantId, TokenHash,
};

use crate::password::{MAX_PASSWORD_BYTES, check_password};
use crate::{Auth, AuthError};

/// What a person gives to sign in.
#[derive(Clone, Copy, Debug)]
pub struct LoginRequest<'a> {
    /// The address, whatever its case and surrounding spaces.
    pub email: &'a str,
    /// The password.
    pub password: &'a str,
    /// The workspace to open. May be left out when the account belongs to exactly one.
    pub tenant: Option<&'a TenantId>,
}

/// A new session: the token, shown once, and what it opens.
#[derive(Debug)]
pub struct Session {
    /// What the person presents from now on. The store keeps only its hash.
    pub token: Secret,
    /// When the session ends, UTC ISO 8601.
    pub expires_at: String,
    /// The one workspace it opens.
    pub tenant: TenantId,
    /// Who signed in, as a member of that workspace.
    pub member: Member,
}

/// What a sign-in came to. Another step (a second factor) will be another variant, which is why
/// callers must handle "something I do not know" and cannot match this exhaustively.
#[derive(Debug)]
#[non_exhaustive]
pub enum LoginOutcome {
    /// The person is in.
    Session(Session),
}

impl Auth {
    /// Checks an address and a password and, if they are right, starts a session in a workspace.
    ///
    /// Every way to be refused before the password is known to be right (a bad address, an
    /// unknown one, no password, a wrong one, a disabled account or member) is
    /// [`AuthError::InvalidCredentials`] and costs one hash. A password over the limit is
    /// refused before hashing, the same for every address. Once the password is right, an
    /// account in several workspaces must say which ([`AuthError::TenantRequired`]); a
    /// workspace it does not belong to is [`AuthError::InvalidCredentials`] too.
    pub async fn login(
        &self,
        db: &Database,
        request: LoginRequest<'_>,
    ) -> Result<LoginOutcome, AuthError> {
        self.policy.require(CredentialKind::Password)?;
        if request.password.len() > MAX_PASSWORD_BYTES {
            return Err(AuthError::InvalidCredentials);
        }
        let Some(found) = db.login_candidate(request.email).await? else {
            self.hasher.spend().await;
            return Err(AuthError::InvalidCredentials);
        };
        let Some(password) = &found.password else {
            self.hasher.spend().await;
            return Err(AuthError::InvalidCredentials);
        };
        let right = self
            .hasher
            .verify(request.password, password.hash.expose())
            .await;
        if !right || found.account.disabled {
            return Err(AuthError::InvalidCredentials);
        }
        self.open_session(
            db,
            &found,
            request.tenant,
            CredentialKind::Password,
            AuthError::InvalidCredentials,
        )
        .await
    }

    /// Picks the workspace a person who has proved who they are opens: the one they asked for,
    /// or their only one. `None` when they may not open the one asked for, or any.
    /// [`AuthError::TenantRequired`] when they could open several and did not say.
    pub(crate) fn choose_tenant<'a>(
        found: &'a LoginCandidate,
        wanted: Option<&TenantId>,
    ) -> Result<Option<&'a TenantId>, AuthError> {
        if found.account.disabled {
            return Ok(None);
        }
        match (wanted, found.tenants.as_slice()) {
            (Some(wanted), tenants) => Ok(tenants
                .iter()
                .find(|(tenant, _)| tenant == wanted)
                .map(|(tenant, _)| tenant)),
            (None, [(only, _)]) => Ok(Some(only)),
            (None, []) => Ok(None),
            (None, _) => Err(AuthError::TenantRequired),
        }
    }

    /// Starts the session of a person who has proved who they are, whichever way: the same
    /// token, lifetime and member as a password sign-in. `refused` is what a workspace they may
    /// not open is told as.
    pub(crate) async fn open_session(
        &self,
        db: &Database,
        found: &LoginCandidate,
        wanted: Option<&TenantId>,
        kind: CredentialKind,
        refused: AuthError,
    ) -> Result<LoginOutcome, AuthError> {
        let tenant = Self::choose_tenant(found, wanted)?.ok_or(refused)?;
        self.start(db, found, tenant, kind).await
    }

    /// Writes the session once the workspace is chosen.
    pub(crate) async fn start(
        &self,
        db: &Database,
        found: &LoginCandidate,
        tenant: &TenantId,
        kind: CredentialKind,
    ) -> Result<LoginOutcome, AuthError> {
        let ctx = db.tenant(tenant.clone()).await?;
        let session = db
            .start_session(&ctx, &found.account.id, self.session_ttl)
            .await?;
        db.touch_credential(&found.account.id, kind).await?;
        let member = db
            .member(&ctx, &found.account.id)
            .await?
            .ok_or(AuthError::InvalidCredentials)?;
        Ok(LoginOutcome::Session(Session {
            token: session.token,
            expires_at: session.expires_at,
            tenant: tenant.clone(),
            member,
        }))
    }

    /// Replaces the account's own password, which needs the current one. Every other session of
    /// the account ends, in every workspace (`keep` is the one that asked), and the new
    /// password is not provisional. [`AuthError::WrongPassword`] when the current one is not
    /// right, or changed in the meantime.
    pub async fn change_password(
        &self,
        db: &Database,
        account: &AccountId,
        current: &str,
        new: &str,
        keep: &TokenHash,
    ) -> Result<(), AuthError> {
        self.policy.require(CredentialKind::Password)?;
        check_password(new)?;
        let Some(old) = db.password_credential(account).await? else {
            self.hasher.spend().await;
            return Err(AuthError::WrongPassword);
        };
        if current.len() > MAX_PASSWORD_BYTES
            || !self.hasher.verify(current, old.hash.expose()).await
        {
            return Err(AuthError::WrongPassword);
        }
        let hash = self.hasher.hash(new).await?;
        if db.replace_password(account, &old.hash, &hash, keep).await? {
            Ok(())
        } else {
            Err(AuthError::WrongPassword)
        }
    }
}
