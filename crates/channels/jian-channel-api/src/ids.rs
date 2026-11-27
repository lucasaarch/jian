//! The ids a channel hands out. Each is the provider's own text, wrapped so a chat id is never
//! passed where a message id is wanted.

use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wraps the provider's id.
            #[must_use]
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            /// The id as the provider writes it.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

id! {
    /// A conversation on the provider: one person, or a group. For `WhatsApp` the chat's JID.
    ChatId
}
id! {
    /// A person (or bot) on the provider, the same text whichever chat they speak in.
    ParticipantId
}
id! {
    /// One message, unique inside its chat. It is what makes a repeated delivery one message.
    MessageId
}
id! {
    /// Opaque token for an attachment that has not been downloaded. Only the channel that made it
    /// can open it.
    MediaRef
}
