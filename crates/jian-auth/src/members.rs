//! What an admin does to a workspace's members, and how its first admin is made.

use jian_store::{
    AccountId, AddedMember, CredentialKind, Database, Member, NewMember, Role, TenantCtx,
};

use crate::password::check_password;
use crate::{Auth, AuthError};

/// Someone an admin adds directly, without an invitation.
#[derive(Clone, Copy, Debug)]
pub struct AddMember<'a> {
    /// The address.
    pub email: &'a str,
    /// What they are called, if the account is new. `None`: what is before the `@`.
    pub name: Option<&'a str>,
    /// What they may do in the workspace.
    pub role: Role,
    /// The provisional password of an account that does not exist yet; the person must replace
    /// it at their first sign-in. It is checked and hashed whatever the account, so a refusal
    /// or a timing does not tell whether the address already has one, and it is **ignored** when
    /// the account exists: adding someone never touches how they sign in elsewhere.
    pub password: &'a str,
    /// The admin adding them: `None` for the owner's command line.
    pub invited_by: Option<&'a AccountId>,
}

impl Auth {
    /// Adds someone to the workspace. A new address gets an account with the password given,
    /// provisional; an existing account keeps its credentials and is only made a member.
    /// [`StoreError::MemberExists`](jian_store::StoreError::MemberExists) (as
    /// [`AuthError::Store`]) when they already belong.
    pub async fn add_member(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        add: AddMember<'_>,
    ) -> Result<AddedMember, AuthError> {
        self.policy.require(CredentialKind::Password)?;
        check_password(add.password)?;
        let hash = self.hasher.hash(add.password).await?;
        let added = db
            .add_member(
                ctx,
                NewMember {
                    email: add.email,
                    name: add.name,
                    role: add.role,
                    invited_by: add.invited_by,
                    password_hash: Some(&hash),
                    must_change: true,
                },
            )
            .await?;
        Ok(added)
    }

    /// Makes the workspace's first member, an admin, who keeps the password given (it is
    /// theirs, not provisional). [`StoreError::TenantHasMembers`](jian_store::StoreError) when
    /// there is already one, even if two calls race. For an account that already exists (a
    /// person with another workspace) the password is ignored.
    ///
    /// This is what the first `jian members add --admin` calls, and what the import of the old
    /// Jian calls so its owner becomes the first admin.
    pub async fn add_first_admin(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        email: &str,
        name: Option<&str>,
        password: &str,
    ) -> Result<Member, AuthError> {
        self.policy.require(CredentialKind::Password)?;
        check_password(password)?;
        let hash = self.hasher.hash(password).await?;
        let added = db
            .add_first_admin(
                ctx,
                NewMember {
                    email,
                    name,
                    role: Role::Admin,
                    invited_by: None,
                    password_hash: Some(&hash),
                    must_change: false,
                },
            )
            .await?;
        Ok(added.member)
    }

    /// Sets a provisional password for a member, as an admin of the workspace: the person must
    /// replace it at their next sign-in and every session they have ends. `None` when the
    /// workspace has no such member.
    ///
    /// Refused ([`StoreError::AccountInOtherTenants`](jian_store::StoreError)) when the account
    /// is also a member of another workspace: one workspace's admin must not change the password
    /// the person uses in another. They change their own, or use another way in.
    pub async fn reset_password(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &AccountId,
        new: &str,
    ) -> Result<Option<Member>, AuthError> {
        self.policy.require(CredentialKind::Password)?;
        check_password(new)?;
        let hash = self.hasher.hash(new).await?;
        Ok(db.reset_password(ctx, account, &hash).await?)
    }
}
