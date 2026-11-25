//! An agent's memories: the JSON bodies of `/v1/agents/{id}/memories*`.
//!
//! A memory is the agent's, whoever wrote it. Each one says where it was learned (`origin`), so
//! a reader can weigh what is safe to repeat. Lists are pages by key with a `nextCursor`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a memory was learned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOriginView {
    /// The thread, when it still exists.
    pub thread: Option<String>,
    /// `dm`, `group`, `channel`, `manual` (outside any thread) or `imported` (from the old Jian).
    pub kind: String,
    /// Who was there: `member:<id>`, `agent:<id>` or `external:<id>`.
    pub participants: Vec<String>,
}

/// One memory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView {
    /// Its key, unique per agent.
    pub key: String,
    /// The text.
    pub content: String,
    /// Grows with each write; send it back as `expectedVersion` to write only over what you read.
    pub version: i64,
    /// When a flash memory ends, UTC ISO 8601; `null` for a permanent one.
    pub expires_at: Option<String>,
    /// Where it was learned.
    pub origin: MemoryOriginView,
    /// The keys it is linked to. Filled when one memory is read or written, empty in a list.
    pub links: Vec<String>,
    /// When it was first written, UTC ISO 8601.
    pub created_at: String,
    /// When it was last written, UTC ISO 8601.
    pub updated_at: String,
}

/// `GET /v1/agents/{id}/memories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MemoriesPage {
    /// The memories, by key (best match first with `q`).
    pub items: Vec<MemoryView>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `PUT /v1/agents/{id}/memories/{key}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WriteMemoryRequest {
    /// The text, up to 20000 characters.
    pub content: String,
    /// The version read: the write fails with 409 if it changed since. `0` means "create only".
    #[serde(default)]
    pub expected_version: Option<i64>,
    /// Makes it a flash memory of 1 to 24 hours. Left out, it is permanent (and a permanent one
    /// never becomes flash).
    #[serde(default)]
    pub flash_hours: Option<u32>,
    /// The thread the agent learned this in; it must be one the caller sees.
    #[serde(default)]
    pub thread: Option<String>,
}
