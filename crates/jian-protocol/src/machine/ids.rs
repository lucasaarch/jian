//! The ids the gateway hands out and the worker only echoes back.
//!
//! Each is a distinct type, so a task's id cannot be passed where a forward's is wanted. On the
//! wire every one is the plain string the gateway wrote: the types change nothing in the JSON.

use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};

/// Declares an id: an opaque string that is compared, hashed and displayed as written.
macro_rules! string_id {
    ($($(#[$doc:meta])+ $name:ident),+ $(,)?) => {$(
        $(#[$doc])+
        #[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// The id as the gateway wrote it.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Deref for $name {
            type Target = str;

            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
                out.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(id: String) -> Self {
                Self(id)
            }
        }

        impl From<&str> for $name {
            fn from(id: &str) -> Self {
                Self(id.to_owned())
            }
        }

        impl std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0 == *other
            }
        }
    )+};
}

string_id! {
    /// The gateway's id for one task, echoed in every output and result of it.
    TaskId,
    /// The gateway's id for one port forward.
    ForwardId,
    /// The gateway's id for the conversation a Computer Use seat belongs to.
    SeatId,
    /// The id the gateway gave a machine.
    MachineId,
}
