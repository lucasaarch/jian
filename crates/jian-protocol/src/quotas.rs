//! What a workspace may use and what it has used: the body of `GET /v1/usage`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `GET /v1/usage`: an admin's view of the limits the workspace is held to and where it stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    /// The most runs at the same time; `null` for no limit.
    pub max_concurrent_runs: Option<u32>,
    /// The most tokens in a UTC calendar month; `null` for no limit.
    pub monthly_token_limit: Option<u64>,
    /// The most bytes of data; `null` for no limit.
    pub disk_limit_bytes: Option<u64>,
    /// The most minutes of machine time in a UTC calendar month; `null` for no limit.
    pub machine_minute_limit: Option<u64>,
    /// Runs holding a place now.
    pub concurrent_runs: u32,
    /// Tokens used this UTC month: input, output and both cache kinds.
    pub monthly_tokens: u64,
    /// Whole minutes of machine time the runs held this UTC month.
    pub machine_minutes: u64,
    /// Bytes the workspace's data takes: tables, indexes and large values.
    pub disk_bytes: u64,
}
