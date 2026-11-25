//! Schedules and the agent's inbox: the JSON bodies of `/v1/agents/{id}/schedules*` and
//! `/v1/agents/{id}/inbox`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One schedule of an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    /// Its id.
    pub id: String,
    /// What it is called.
    pub name: String,
    /// What the agent is to do.
    pub instruction: String,
    /// The time of a one-shot, UTC ISO 8601.
    pub at: Option<String>,
    /// The cron expression of a repeating one.
    pub cron: Option<String>,
    /// The IANA zone the cron is read in.
    pub time_zone: String,
    /// Whether it fires.
    pub enabled: bool,
    /// When it is next due, UTC ISO 8601; `null` once a one-shot has fired or when it is off.
    pub next_run_at: Option<String>,
    /// When it last fired, UTC ISO 8601.
    pub last_run_at: Option<String>,
    /// Why its last firing failed.
    pub last_error: Option<String>,
    /// The conversation it was made in, when it still exists.
    pub thread: Option<String>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
}

/// `GET /v1/agents/{id}/schedules`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesPage {
    /// The schedules, oldest first.
    pub items: Vec<ScheduleView>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `POST /v1/agents/{id}/schedules`: exactly one of `at` and `cron`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduleRequest {
    /// 1 to 120 characters.
    pub name: String,
    /// What the agent is to do, up to 20000 characters.
    pub instruction: String,
    /// A one-shot's time, ISO 8601 with an offset; it must be in the future.
    #[serde(default)]
    pub at: Option<String>,
    /// A repeating schedule's 5-field cron expression, no more often than every 5 minutes.
    #[serde(default)]
    pub cron: Option<String>,
    /// The IANA zone the cron is read in; `UTC` when left out.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// The conversation it is made in; it must be one the caller sees.
    #[serde(default)]
    pub thread: Option<String>,
}

/// `PATCH /v1/agents/{id}/schedules/{scheduleId}`: a field left out stays as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScheduleRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new instruction.
    #[serde(default)]
    pub instruction: Option<String>,
    /// Turn it on or off.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// One thing in an agent's inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InboxEventView {
    /// Its id.
    pub id: String,
    /// What it is: `schedule`.
    pub kind: String,
    /// Its content; for a schedule, `scheduleId`, `name` and `instruction`.
    #[ts(type = "unknown")]
    pub payload: serde_json::Value,
    /// The schedule that made it, while it exists.
    pub schedule_id: Option<String>,
    /// The time it was due, UTC ISO 8601.
    pub due_at: Option<String>,
    /// When it arrived, UTC ISO 8601.
    pub created_at: String,
    /// When the agent took it, UTC ISO 8601.
    pub consumed_at: Option<String>,
}

/// `GET /v1/agents/{id}/inbox`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    /// The events, oldest first.
    pub items: Vec<InboxEventView>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}
