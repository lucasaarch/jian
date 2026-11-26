//! Who people are and how they get in: the sign-in flows, with no HTTP in them.
//!
//! `jian-server` calls these behind its routes, `bins/jian` behind `jian members`, and the
//! Cloud's backend (another repository) imports this crate and `jian-store` and calls the same
//! functions, so a person is the same record in a self-hosted gateway and in the Cloud. The crate
//! talks to Postgres only through [`jian_store::Database`] and does no IO of its own besides
//! hashing passwords.
//!
//! # One person, three layers
//!
//! 1. **Account** (`platform.accounts`): the person and their email address. Outside any
//!    tenant. The same account can be a member of many workspaces.
//! 2. **Credentials** (`platform.credentials`): the ways they prove who they are, one row each:
//!    `password`, `github`, `email_link` (a magic link), `passkey`, `totp` (a second factor).
//!    `password`, `github` ([`GithubApp`]) and `email_link` have code here. `passkey` and `totp`
//!    are in the model so that adding them is no migration: a passkey is a credential row like
//!    GitHub's (its credential id as `subject`), and a second factor is another step after the
//!    first, which is why a [`LoginOutcome`] is `#[non_exhaustive]` and every flow that signs
//!    somebody in ends in one function (`Auth::start`), where that step hooks in.
//! 3. **Member** (`platform.members`): an account in a tenant, with a role, `admin` or
//!    `member`.
//!
//! There is no "Cloud user" linked to a "gateway user": it is the same record. A session
//! (`platform.api_tokens`, kind `session`) belongs to an account and opens ONE tenant.
//!
//! # The policy
//!
//! [`AuthPolicy`] says which credential kinds a deploy accepts. It is configuration: a
//! self-hosted install allows `password` (add `github` and `email_link` to let members use
//! them); the Cloud allows `github` and `email_link` and no password. A method that is off
//! makes its flows fail with [`AuthError::MethodDisabled`] (the server answers 404), and no
//! credential of that kind is created: with `password` off nobody signs in with one and no flow
//! makes one.
//!
//! # What the flows promise
//!
//! - There is no sign-up. Accounts are made when an admin adds someone
//!   ([`Auth::add_member`]), when an invitation is accepted ([`Auth::accept_invite`]), as the
//!   first admin ([`Auth::add_first_admin`]), or by the Cloud's own signup.
//! - [`Auth::login`] answers the same [`AuthError::InvalidCredentials`], in about the same time,
//!   for an unknown address, a wrong password, a disabled account or member, and an account
//!   without a password (a dummy hash is spent). Slowing guesses down is the caller's: this
//!   crate has no clock or counters.
//! - **GitHub and the link by e-mail only let in somebody who is already a member.** Neither
//!   makes accounts here ([`Auth::github_sign_in`], [`Auth::redeem_login_link`]): a GitHub user
//!   that matches nobody is refused, and a link is only made for a member
//!   ([`Auth::issue_login_link`]). The GitHub user is identified by its numeric id, never its
//!   login, and an address counts only when GitHub says it is verified. GitHub's access token is
//!   never stored.
//! - An admin never changes a password the person uses elsewhere. Adding an existing account to
//!   a workspace leaves its credentials alone, and accepting an invitation with an existing
//!   account asks for the account's own password and sets no new one. An admin's reset
//!   ([`Auth::reset_password`]) is refused for an account that belongs to another workspace.
//! - Changing your own password ends your other sessions in every tenant. Disabling a member
//!   ends theirs in that tenant only.
//! - A password an admin chose is provisional (`must_change`): the session it opens may do
//!   nothing but change it. The server enforces that on every route.
//!
//! # How the Cloud uses it
//!
//! The Cloud's backend does not keep its own users or sessions (no `NextAuth` as the source of
//! them). On a GitHub or magic-link sign-in it finds or creates the account by email
//! (`Database::account_by_email`, `add_member` / a new credential of kind `github`), makes the
//! workspace's tenant when it is the person's first, adds them as `admin`, and starts a session
//! with `Database::start_session`, the same one the password flow ends with. It builds its [`Auth`]
//! with [`AuthPolicy::cloud`]. Everything downstream (the gateway's `Principal`, the WebSocket)
//! sees an ordinary session.
//!
//! # Tests
//!
//! Hashing at the real cost is slow. A test builds its [`Auth`] with
//! [`PasswordParams::insecure_for_tests`], which is trivially guessable and must never reach a
//! binary: hashes carry their own cost, so a test hash and a production hash verify the same way.

mod error;
mod github;
mod github_login;
mod invites;
mod link_login;
mod login;
mod members;
mod password;
mod policy;

use std::sync::Arc;
use std::time::Duration;

pub use error::AuthError;
pub use github::{GITHUB_API_URL, GITHUB_OAUTH_URL, GithubApp};
pub use invites::AcceptInvite;
pub use jian_store::{CredentialKind, GithubLink, Role};
pub use link_login::IssuedLoginLink;
pub use login::{LoginOutcome, LoginRequest, Session};
pub use members::AddMember;
pub use password::{
    MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS, PasswordHasher, PasswordParams, check_password,
};
pub use policy::AuthPolicy;

/// How long a login session lasts when nothing else is said: 30 days.
const DEFAULT_SESSION_TTL: Duration = Duration::from_hours(24 * 30);

/// How long an invitation works when nothing else is said: 7 days.
const DEFAULT_INVITE_TTL: Duration = Duration::from_hours(24 * 7);

/// How long the `state` of a GitHub round trip works: the time to sign in at GitHub.
const DEFAULT_STATE_TTL: Duration = Duration::from_mins(10);

/// How long a sign-in link by e-mail works.
const DEFAULT_LINK_TTL: Duration = Duration::from_mins(15);

/// The flows, with the policy and the settings they need. Cheap to clone. It holds no database:
/// every flow takes the [`Database`](jian_store::Database) it acts on.
#[derive(Clone, Debug)]
pub struct Auth {
    policy: AuthPolicy,
    hasher: PasswordHasher,
    session_ttl: Duration,
    invite_ttl: Duration,
    state_ttl: Duration,
    link_ttl: Duration,
    github: Option<Arc<GithubApp>>,
}

impl Auth {
    /// The flows under this policy, hashing new passwords at this cost.
    pub fn new(policy: AuthPolicy, params: PasswordParams) -> Self {
        Self {
            policy,
            hasher: PasswordHasher::new(params),
            session_ttl: DEFAULT_SESSION_TTL,
            invite_ttl: DEFAULT_INVITE_TTL,
            state_ttl: DEFAULT_STATE_TTL,
            link_ttl: DEFAULT_LINK_TTL,
            github: None,
        }
    }

    /// How long a session made by a login lasts.
    #[must_use]
    pub fn with_session_ttl(mut self, ttl: Duration) -> Self {
        self.session_ttl = ttl;
        self
    }

    /// How long an invitation works.
    #[must_use]
    pub fn with_invite_ttl(mut self, ttl: Duration) -> Self {
        self.invite_ttl = ttl;
        self
    }

    /// How long the state of a GitHub round trip works.
    #[must_use]
    pub fn with_state_ttl(mut self, ttl: Duration) -> Self {
        self.state_ttl = ttl;
        self
    }

    /// How long a sign-in link by e-mail works.
    #[must_use]
    pub fn with_link_ttl(mut self, ttl: Duration) -> Self {
        self.link_ttl = ttl;
        self
    }

    /// The policy in force.
    pub fn policy(&self) -> &AuthPolicy {
        &self.policy
    }
}

impl Default for Auth {
    /// A self-hosted install: password sign-in at the production cost.
    fn default() -> Self {
        Self::new(AuthPolicy::self_hosted(), PasswordParams::default())
    }
}
