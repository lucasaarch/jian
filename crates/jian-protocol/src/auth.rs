//! Signing in with an email address and a password, and managing the people of a workspace: the
//! JSON bodies of the gateway's `/v1/auth/*`, `/v1/members*` and `/v1/invites*` routes.
//!
//! These are plain HTTP, not the WebSocket: a person has no token before they sign in. A
//! self-hosted install turns the password login on; a gateway that does not (the Cloud, which
//! signs people in by other means) answers 404 to those routes. Nobody can sign themselves up:
//! an account is made when an admin adds someone ([`AddMemberRequest`]) or invites them
//! ([`CreateInviteRequest`]).
//!
//! A person is an *account* (one per email address, in every workspace) and a *member* of each
//! workspace they belong to, with a role in it. A session opens one workspace.
//!
//! The wire is JSON in camelCase, and a refusal is [`ErrorBody`] with a status that says the
//! class of failure.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a member may do in the workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MemberRole {
    /// Manages the workspace's members, invitations, machines and phones.
    Admin,
    /// Uses the workspace. Manages nobody.
    Member,
}

/// A member as an admin lists them. The password, in any form, is never in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MemberSummary {
    /// The account's id: the same in every workspace the person belongs to.
    pub account_id: String,
    /// The address they sign in with, trimmed and lower case.
    pub email: String,
    /// What they are called.
    pub name: String,
    /// What they may do in this workspace.
    pub role: MemberRole,
    /// An admin chose their password: it must be replaced before anything else.
    pub must_change_password: bool,
    /// They have a password.
    pub has_password: bool,
    /// When they joined this workspace, UTC ISO 8601.
    pub created_at: String,
    /// They can no longer use this workspace.
    pub disabled: bool,
}

/// `POST /v1/auth/login`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// The address, whatever its case and surrounding spaces.
    pub email: String,
    /// The password.
    pub password: String,
    /// The workspace to open. May be left out when the account belongs to exactly one; with
    /// several, the answer asks for it (`tenant_required`).
    #[serde(default)]
    pub tenant: Option<String>,
}

// A password in a log is a password leaked: debug output says only that there is one.
impl std::fmt::Debug for LoginRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRequest")
            .field("email", &self.email)
            .field("tenant", &self.tenant)
            .finish_non_exhaustive()
    }
}

/// A new session, the answer to a login and to accepting an invitation.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    /// The bearer token to present from now on. Shown once; the gateway keeps its hash.
    pub token: String,
    /// When the session ends, UTC ISO 8601.
    pub expires_at: String,
    /// The workspace the session opens.
    pub tenant: String,
    /// Who signed in. When `must_change_password` is set, the token opens nothing but
    /// `POST /v1/auth/password`, `POST /v1/auth/logout` and `GET /v1/me`.
    pub member: MemberSummary,
}

impl std::fmt::Debug for LoginResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginResponse")
            .field("token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("tenant", &self.tenant)
            .field("member", &self.member)
            .finish()
    }
}

/// `POST /v1/auth/password`: the signed-in person replaces their own password. Every other
/// session of theirs ends, in every workspace.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    /// The password they have now.
    pub current: String,
    /// The one to have: at least 12 characters, at most 256 bytes.
    pub new: String,
}

impl std::fmt::Debug for ChangePasswordRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChangePasswordRequest")
            .finish_non_exhaustive()
    }
}

/// `POST /v1/auth/invite/accept`: someone invited joins the workspace and is signed in.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteRequest {
    /// The invitation token the admin passed on.
    pub token: String,
    /// For an address with no account yet: the password to have. For one that already has an
    /// account: that account's own password, which is checked and never changed.
    pub password: String,
    /// What to call a new account. Left out: what is before the `@`.
    #[serde(default)]
    pub name: Option<String>,
}

impl std::fmt::Debug for AcceptInviteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcceptInviteRequest")
            .finish_non_exhaustive()
    }
}

/// `POST /v1/members`, for an admin: adds someone directly.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberRequest {
    /// The address they will sign in with.
    pub email: String,
    /// What a new account is called. Left out: what is before the `@`.
    #[serde(default)]
    pub name: Option<String>,
    /// What they may do.
    pub role: MemberRole,
    /// The provisional password of a new account, which they must replace at their first
    /// sign-in. Required whatever the address, so a refusal never tells whether it has an
    /// account; **ignored** when it has one, whose credentials are never touched.
    pub password: String,
}

impl std::fmt::Debug for AddMemberRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddMemberRequest")
            .field("email", &self.email)
            .field("role", &self.role)
            .finish_non_exhaustive()
    }
}

/// The answer to [`AddMemberRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberResponse {
    /// The member that was added.
    pub member: MemberSummary,
    /// The address had no account and one was made with the password given.
    pub account_created: bool,
}

/// `POST /v1/members/{account_id}/reset-password`, for an admin: the member must replace this
/// at their next sign-in, and every session they have ends. Refused (409
/// `account_in_other_workspaces`) when the account belongs to another workspace too.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    /// The provisional password.
    pub password: String,
}

impl std::fmt::Debug for ResetPasswordRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResetPasswordRequest")
            .finish_non_exhaustive()
    }
}

/// `GET /v1/members`: a page of the workspace's members, in the order they joined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MembersPage {
    /// The members of this page.
    pub items: Vec<MemberSummary>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `POST /v1/invites`, for an admin. Inviting an address that has a live invitation revokes it
/// and makes a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteRequest {
    /// Who is invited.
    pub email: String,
    /// What they will be able to do.
    pub role: MemberRole,
}

/// A pending invitation, as an admin lists it. There is no token in it: that was shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InviteSummary {
    /// Names it in `POST /v1/invites/{id}/revoke`.
    pub id: String,
    /// Who is invited.
    pub email: String,
    /// What they will be able to do.
    pub role: MemberRole,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it stops working, UTC ISO 8601.
    pub expires_at: String,
}

/// The answer to [`CreateInviteRequest`]: the invitation and its token, once.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InviteCreated {
    /// The invitation.
    pub invite: InviteSummary,
    /// What the person gives to `POST /v1/auth/invite/accept`. Works once, and is not shown
    /// again: the gateway keeps its hash.
    pub token: String,
}

impl std::fmt::Debug for InviteCreated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InviteCreated")
            .field("invite", &self.invite)
            .finish_non_exhaustive()
    }
}

/// `GET /v1/invites`: the workspace's pending invitations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InvitesPage {
    /// The pending invitations, oldest first.
    pub items: Vec<InviteSummary>,
}

/// `GET /v1/me`: who the token is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    /// The workspace the token belongs to.
    pub tenant: String,
    /// `owner`, `machine`, `device` or `session`.
    pub kind: String,
    /// The machine, phone or account the token acts as; `null` for the owner's.
    pub subject: Option<String>,
    /// The person behind the token, when there is one.
    pub account_id: Option<String>,
    /// What a signed-in member may do; `null` for the other kinds of token.
    pub role: Option<MemberRole>,
    /// The session may do nothing but change its password.
    pub must_change_password: bool,
}

/// The body of every refusal of these routes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// A short code that does not change: `invalid_credentials`, `forbidden`, `not_found`, ...
    pub error: String,
    /// A sentence for a person. Never says whether an address is registered.
    pub message: String,
}
