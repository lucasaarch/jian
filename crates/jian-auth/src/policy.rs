//! Which ways of signing in a deploy accepts.
//!
//! The policy is configuration, not a compile-time feature: one binary serves a self-hosted
//! install (a password) and the Cloud (GitHub and a link by email, no password) and the
//! difference is what its operator turns on. A method that is off answers as if it did not
//! exist, and no credential of that kind can be created.

use std::collections::BTreeSet;
use std::str::FromStr;

use jian_store::CredentialKind;

use crate::AuthError;

/// The set of [`CredentialKind`]s a deploy lets people sign in with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthPolicy {
    methods: BTreeSet<CredentialKind>,
}

impl AuthPolicy {
    /// A policy that allows exactly these kinds.
    pub fn new(methods: impl IntoIterator<Item = CredentialKind>) -> Self {
        Self {
            methods: methods.into_iter().collect(),
        }
    }

    /// A self-hosted or desktop install: the password, and nothing else.
    pub fn self_hosted() -> Self {
        Self::new([CredentialKind::Password])
    }

    /// The Cloud: GitHub and a link by email, no password ("password off"). The flows are
    /// [`Auth::github_sign_in`](crate::Auth::github_sign_in) and
    /// [`Auth::redeem_login_link`](crate::Auth::redeem_login_link); making the account and the
    /// workspace of a new person is the Cloud backend's.
    pub fn cloud() -> Self {
        Self::new([CredentialKind::Github, CredentialKind::EmailLink])
    }

    /// Whether people may sign in with this kind.
    pub fn allows(&self, kind: CredentialKind) -> bool {
        self.methods.contains(&kind)
    }

    /// `Ok` when the kind is allowed, [`AuthError::MethodDisabled`] when not.
    pub fn require(&self, kind: CredentialKind) -> Result<(), AuthError> {
        if self.allows(kind) {
            Ok(())
        } else {
            Err(AuthError::MethodDisabled(kind))
        }
    }
}

/// The list [`FromStr`] reads back: `password,github`.
impl std::fmt::Display for AuthPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, kind) in self.methods.iter().enumerate() {
            if i > 0 {
                f.write_str(",")?;
            }
            f.write_str(kind.as_str())?;
        }
        Ok(())
    }
}

impl Default for AuthPolicy {
    fn default() -> Self {
        Self::self_hosted()
    }
}

/// A comma-separated list of kinds, as `password,github`: how a binary reads its configuration.
/// An unknown kind, or an empty list (nobody could sign in), is refused.
impl FromStr for AuthPolicy {
    type Err = AuthError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let methods = text
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| {
                CredentialKind::parse(name).ok_or_else(|| AuthError::InvalidPolicy(name.to_owned()))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        if methods.is_empty() {
            return Err(AuthError::InvalidPolicy(String::new()));
        }
        Ok(Self { methods })
    }
}
