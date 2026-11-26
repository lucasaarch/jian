//! What can go wrong in a sign-in flow.

use jian_store::{CredentialKind, StoreError};

/// The error of every flow of this crate.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// The address or the password is not right. It is also what a disabled account or member,
    /// an account with no password and an unknown address say, so the answer does not tell
    /// which of them it was.
    #[error("the email address or the password is not right")]
    InvalidCredentials,
    /// The password is right but the account belongs to several tenants and none was named.
    /// Only said after the password was checked, so it does not tell whether an address is
    /// registered.
    #[error("this account belongs to several workspaces: say which one")]
    TenantRequired,
    /// This deploy does not let people sign in with that kind of credential.
    #[error("signing in with {0:?} is turned off here")]
    MethodDisabled(CredentialKind),
    /// The invitation is unknown, used, revoked or expired. Which one is not said.
    #[error("the invitation is not valid")]
    InvalidInvite,
    /// A password the policy will not take. The limits are in the message so a person can fix it.
    #[error("a password has at least {min_chars} characters and at most {max_bytes} bytes")]
    InvalidPassword {
        /// The fewest characters.
        min_chars: usize,
        /// The most bytes.
        max_bytes: usize,
    },
    /// The password given as the current one is not the account's.
    #[error("the current password is wrong")]
    WrongPassword,
    /// Hashing a password failed. Nothing about the password is in the message.
    #[error("could not hash a password")]
    PasswordHashing,
    /// The list of methods names one that does not exist, or none at all.
    #[error(
        "not a list of sign-in methods ({0:?}): use password, github, email_link, passkey, totp"
    )]
    InvalidPolicy(String),
    /// The deploy allows this way of signing in but has not set it up (no GitHub OAuth App, say).
    #[error("signing in with {0:?} is not set up here")]
    NotConfigured(CredentialKind),
    /// The state of a GitHub round trip is unknown, used, expired, or not for this caller. Which
    /// one is not said.
    #[error("this sign-in expired or was already used: start again")]
    InvalidState,
    /// GitHub did not accept the code, so the person did not sign in with it.
    #[error("GitHub did not accept the sign-in: start again")]
    GithubRefused,
    /// GitHub could not be reached or said something unexpected. No token is in the message.
    #[error("could not reach GitHub: {0}")]
    GithubUnavailable(&'static str),
    /// The GitHub account is not linked to anybody and none of its verified addresses is a
    /// member's. A self-hosted install does not make accounts from a sign-in.
    #[error("no member matches this GitHub account: ask an admin to add you")]
    GithubNotAMember,
    /// The link is unknown, used, replaced or expired. Which one is not said.
    #[error("the sign-in link is not valid")]
    InvalidLink,
    /// Removing this would leave the account with no way to sign in.
    #[error("that is the only way you can sign in: add another before removing it")]
    LastSignInMethod,
    /// The account has no GitHub linked.
    #[error("no GitHub account is linked")]
    NotLinked,
    /// The workspace asked for does not exist.
    #[error("no such workspace")]
    UnknownTenant,
    /// The store failed, or refused for a reason of its own (an address that is not one, a member
    /// that already exists, a reset that crosses workspaces).
    #[error(transparent)]
    Store(#[from] StoreError),
}
