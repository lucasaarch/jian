//! What the gateway needs to reach model providers for its tenants: how long to wait, and what
//! each subscription account's last answer said of its usage.

use jian_llm::{HttpConfig, LimitsBoard};

/// Shared by every handler. Cloning shares the board.
#[derive(Clone, Debug, Default)]
pub struct LlmAccess {
    /// Timeouts and retries of every call to a provider.
    pub http: HttpConfig,
    /// The usage windows of subscription accounts, from the answers they last gave.
    pub limits: LimitsBoard,
}

impl LlmAccess {
    /// Where an account's windows are kept: the tenant is part of it, so two workspaces never
    /// share a row even if their account ids met.
    pub(crate) fn board_key(tenant: &impl std::fmt::Display, account: &str) -> String {
        format!("{tenant}/{account}")
    }
}
