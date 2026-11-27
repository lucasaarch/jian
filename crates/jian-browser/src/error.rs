//! What can go wrong, sorted by what to do about it.

/// Why a page could not be opened or read.
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    /// The program would not start or did not answer.
    #[error("the browser could not start: {0}")]
    Launch(String),
    /// The address is not one this gateway lets a page reach (a private network in the Cloud, or
    /// a scheme other than http and https). Said the same on both engines: a second engine
    /// would not be allowed either.
    #[error("{0}")]
    Blocked(String),
    /// The site did not answer: DNS, a refused connection, a certificate, a timeout. Another
    /// engine would see the same.
    #[error("the site could not be reached: {0}")]
    Network(String),
    /// The site was reached but this engine cannot run it (a CSS or web API it lacks, a crash
    /// while drawing). The one failure the second engine is tried for.
    #[error("this browser cannot run the page: {0}")]
    Unsupported(String),
    /// The engine went away mid-call.
    #[error("the browser stopped while it was in use")]
    Closed,
}

impl BrowserError {
    /// Whether the other engine may do better: the site is fine but this engine cannot run it.
    /// A blocked address and an unreachable site are the same on both.
    #[must_use]
    pub fn runs_elsewhere(&self) -> bool {
        matches!(self, Self::Unsupported(_) | Self::Closed)
    }
}
