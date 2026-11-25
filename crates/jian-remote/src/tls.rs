//! The TLS crypto provider of the worker's HTTP clients.

/// Installs ring as the process's rustls provider. Call before building a `reqwest::Client`.
///
/// The workspace builds reqwest on `rustls-no-provider` because its `rustls` feature brings
/// aws-lc (C and cmake), and without a provider `Client::build` panics. Safe to call again: an
/// error only means a provider is already installed (by this function or by another crate).
pub fn install_provider() {
    drop(rustls::crypto::ring::default_provider().install_default());
}
