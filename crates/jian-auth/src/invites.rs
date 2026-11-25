//! Invitations: making them, and accepting them.

use jian_store::{
    AccountId, CredentialKind, Database, IssuedInvite, MAX_INVITE_TOKEN_LEN, NewAccount, Role,
    StoreError, TenantCtx, TokenHash, default_name,
};

use crate::login::Session;
use crate::password::{MAX_PASSWORD_BYTES, check_password};
use crate::{Auth, AuthError};

/// What a person gives to accept an invitation.
#[derive(Clone, Copy, Debug)]
pub struct AcceptInvite<'a> {
    /// The invitation token the admin passed on.
    pub token: &'a str,
    /// For an address with no account yet: the password to have. For an address that already
    /// has one: that account's own password, which proves it is them and is never replaced.
    pub password: &'a str,
    /// What to call a new account. `None`: what is before the `@`.
    pub name: Option<&'a str>,
}

impl Auth {
    /// Makes an invitation for `email` to join the workspace as `role`, and revokes the live one
    /// for the same address, if any (so "copy the link" and "send it again" always hand out a
    /// new token and the old one dies). The token is in the answer, once.
    pub async fn invite(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        email: &str,
        role: Role,
        invited_by: Option<&AccountId>,
    ) -> Result<IssuedInvite, AuthError> {
        Ok(db
            .create_invite(ctx, email, role, invited_by, self.invite_ttl)
            .await?)
    }

    /// Spends an invitation and signs the person in to the workspace it was for.
    ///
    /// For a new address the account is made with the password given. For an address that
    /// already has an account the password must be that account's, and is never changed: the
    /// invitation only adds the membership. A token that is unknown, used, revoked or expired is
    /// [`AuthError::InvalidInvite`], all the same; an existing account's wrong password is
    /// [`AuthError::InvalidCredentials`] and does not use the invitation up.
    pub async fn accept_invite(
        &self,
        db: &Database,
        accept: AcceptInvite<'_>,
    ) -> Result<Session, AuthError> {
        self.policy.require(CredentialKind::Password)?;
        if accept.token.is_empty() || accept.token.len() > MAX_INVITE_TOKEN_LEN {
            return Err(AuthError::InvalidInvite);
        }
        let token = TokenHash::of(accept.token);
        // Before any hashing: a made-up token costs a lookup, not 19 MiB of argon2.
        let target = db
            .live_invite(&token)
            .await?
            .ok_or(AuthError::InvalidInvite)?;
        let accepted = if let Some(account) = db.account_by_email(&target.email).await? {
            self.prove_password(db, &account.id, accept.password)
                .await?;
            db.accept_invite(&token, None).await
        } else {
            check_password(accept.password)?;
            let hash = self.hasher.hash(accept.password).await?;
            let name = accept
                .name
                .map_or_else(|| default_name(&target.email), str::to_owned);
            db.accept_invite(
                &token,
                Some(NewAccount {
                    name: &name,
                    password_hash: Some(&hash),
                    must_change: false,
                }),
            )
            .await
        }
        .map_err(|error| match error {
            StoreError::InvalidInvite => AuthError::InvalidInvite,
            other => AuthError::Store(other),
        })?;
        let ctx = db.tenant(accepted.tenant.clone()).await?;
        let session = db
            .start_session(&ctx, &accepted.member.account_id, self.session_ttl)
            .await?;
        Ok(Session {
            token: session.token,
            expires_at: session.expires_at,
            tenant: accepted.tenant,
            member: accepted.member,
        })
    }

    /// `Ok` when `password` is the account's own. A wrong one, or none to check against, costs
    /// a hash and is [`AuthError::InvalidCredentials`].
    async fn prove_password(
        &self,
        db: &Database,
        account: &AccountId,
        password: &str,
    ) -> Result<(), AuthError> {
        let Some(credential) = db.password_credential(account).await? else {
            self.hasher.spend().await;
            return Err(AuthError::InvalidCredentials);
        };
        let right = password.len() <= MAX_PASSWORD_BYTES
            && self.hasher.verify(password, credential.hash.expose()).await;
        if right {
            Ok(())
        } else {
            Err(AuthError::InvalidCredentials)
        }
    }
}
