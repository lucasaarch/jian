//! The ids a token can act as.

use std::fmt;

use super::TokenKind;

macro_rules! subject_id {
    ($($(#[$doc:meta])+ $name:ident),+ $(,)?) => {$(
        $(#[$doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            /// Wraps an id as the store wrote it. Any text is fine here: an id is only ever
            /// bound as a parameter, and one that names nothing finds nothing.
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            /// The id as text.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
                out.write_str(&self.0)
            }
        }
    )+};
}

subject_id! {
    /// A machine of a tenant: a computer running Jian Remote.
    MachineId,
    /// A phone of a tenant.
    DeviceId,
}

/// What a token acts as inside its tenant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Subject {
    /// The owner.
    Owner,
    /// One machine.
    Machine(MachineId),
    /// One phone.
    Device(DeviceId),
}

impl Subject {
    /// The kind of token that acts as this subject.
    pub fn kind(&self) -> TokenKind {
        match self {
            Self::Owner => TokenKind::Owner,
            Self::Machine(_) => TokenKind::Machine,
            Self::Device(_) => TokenKind::Device,
        }
    }

    pub(crate) fn from_row(kind: TokenKind, id: String) -> Option<Self> {
        match kind {
            TokenKind::Owner => (id == OWNER_SUBJECT).then_some(Self::Owner),
            TokenKind::Machine => Some(Self::Machine(MachineId(id))),
            TokenKind::Device => Some(Self::Device(DeviceId(id))),
        }
    }
}

/// The `subject_id` of an owner token, which acts as no row of the tenant's.
pub(crate) const OWNER_SUBJECT: &str = "owner";
