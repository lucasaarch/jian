//! Signing in with an email address and a password, and managing the people who can: the JSON
//! bodies of the gateway's `/v1/auth/*` and `/v1/users*` routes.
//!
//! These are plain HTTP, not the WebSocket: a person has no token before they sign in. A server
//! install turns the password login on; a gateway that does not (the Cloud, which signs people in
//! by other means) answers 404 to the login routes. Nobody can sign themselves up: a user is
//! added by an admin ([`AddUserRequest`]).
//!
//! The wire is JSON in camelCase, and a refusal is [`ErrorBody`] with a status that says the
//! class of failure.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a user may do in the tenant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum UserRole {
    /// Manages the tenant's users, machines and phones.
    Admin,
    /// Uses the tenant. Manages nobody.
    Member,
}

/// A user as an admin lists them. The password, in any form, is never in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    /// Its id.
    pub id: String,
    /// The address they sign in with, trimmed and lower case.
    pub email: String,
    /// What they are called.
    pub name: String,
    /// What they may do.
    pub role: UserRole,
    /// An admin chose their password: it must be replaced before anything else.
    pub must_change_password: bool,
    /// They have a password. Not yet for someone invited who has not accepted.
    pub has_password: bool,
    /// When they were added, UTC ISO 8601.
    pub created_at: String,
    /// They can no longer sign in.
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
}

// A password in a log is a password leaked: debug output says only that there is one.
impl std::fmt::Debug for LoginRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRequest")
            .field("email", &self.email)
            .field("password", &"[redacted]")
            .finish()
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
    /// Who signed in. When `must_change_password` is set, the token opens nothing but
    /// `POST /v1/auth/password`, `POST /v1/auth/logout` and `GET /v1/me`.
    pub user: UserSummary,
}

impl std::fmt::Debug for LoginResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginResponse")
            .field("token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("user", &self.user)
            .finish()
    }
}

/// `POST /v1/auth/password`: the signed-in user replaces their own password. Every other session
/// of theirs ends.
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

/// `POST /v1/auth/invite/accept`: someone invited chooses their password and is signed in.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteRequest {
    /// The invitation token the admin passed on.
    pub token: String,
    /// The password to have.
    pub password: String,
}

impl std::fmt::Debug for AcceptInviteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcceptInviteRequest")
            .finish_non_exhaustive()
    }
}

/// `POST /v1/users`, for an admin.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AddUserRequest {
    /// The address they will sign in with.
    pub email: String,
    /// What they are called.
    pub name: String,
    /// What they may do.
    pub role: UserRole,
    /// A provisional password they must replace at their first sign-in. Without one the user is
    /// invited instead, and the answer carries the invitation.
    pub password: Option<String>,
}

impl std::fmt::Debug for AddUserRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddUserRequest")
            .field("email", &self.email)
            .field("role", &self.role)
            .finish_non_exhaustive()
    }
}

/// An invitation, shown once.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InviteSummary {
    /// What the person gives to `POST /v1/auth/invite/accept`. Works once.
    pub token: String,
    /// When it stops working, UTC ISO 8601.
    pub expires_at: String,
}

impl std::fmt::Debug for InviteSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InviteSummary")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// The answer to [`AddUserRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AddUserResponse {
    /// The user that was added.
    pub user: UserSummary,
    /// Present when no password was given.
    pub invite: Option<InviteSummary>,
}

/// `POST /v1/users/{id}/reset-password`, for an admin: the user must replace this at their next
/// sign-in, and every session they have ends.
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

/// `GET /v1/users`: a page of the tenant's users, in the order they were added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsersPage {
    /// The users of this page.
    pub items: Vec<UserSummary>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `GET /v1/me`: who the token is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    /// The tenant the token belongs to.
    pub tenant: String,
    /// `owner`, `machine`, `device` or `session`.
    pub kind: String,
    /// The machine, phone or user the token acts as; `null` for the owner's.
    pub subject: Option<String>,
    /// The person behind the token, when there is one.
    pub user_id: Option<String>,
    /// What a signed-in user may do; `null` for the other kinds of token.
    pub role: Option<UserRole>,
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
