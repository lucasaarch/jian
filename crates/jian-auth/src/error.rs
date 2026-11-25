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
    /// The store failed, or refused for a reason of its own (an address that is not one, a member
    /// that already exists, a reset that crosses workspaces).
    #[error(transparent)]
    Store(#[from] StoreError),
}
