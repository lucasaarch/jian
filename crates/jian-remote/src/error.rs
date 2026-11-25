//! The errors the worker's operations return.
//!
//! Each one carries a sentence written for the person or agent who reads it, and displays as
//! exactly that sentence: the CLI prints it and a task result sends it to the gateway.

/// Declares an error that is one message, with the conversions the worker's call sites use.
macro_rules! message_error {
    ($($(#[$doc:meta])+ $name:ident),+ $(,)?) => {$(
        $(#[$doc])+
        #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
        #[error("{0}")]
        pub struct $name(pub String);

        impl From<String> for $name {
            fn from(message: String) -> Self {
                Self(message)
            }
        }

        impl From<&str> for $name {
            fn from(message: &str) -> Self {
                Self(message.to_owned())
            }
        }

        impl From<$name> for String {
            fn from(error: $name) -> Self {
                error.0
            }
        }
    )+};
}

message_error! {
    /// A gateway address or connection setting the worker cannot use.
    GatewayError,
    /// A port forward that could not be opened.
    ForwardError,
    /// A file search that could not run.
    SearchError,
    /// An update that could not be checked, downloaded or installed.
    UpdateError,
}
