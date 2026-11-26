//! Artifacts: the JSON bodies of `/v1/artifacts*` and `/v1/artifact-folders*`, and what the
//! `artifact.*` deltas carry.
//!
//! An artifact is a page, component, document, sheet, diagram or deck that an agent (or a member)
//! makes beside a conversation, kept with every version it had.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Who made an artifact or wrote a version of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactAuthorView {
    /// `agent` or `member`.
    pub kind: String,
    /// The agent's or the account's id.
    pub id: String,
}

/// One artifact, without its content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactView {
    /// Its id.
    pub id: String,
    /// `html`, `react`, `markdown`, `mermaid`, `deck`, `sheet` or `diagram`.
    pub kind: String,
    /// A short name for a list.
    pub title: String,
    /// The folder it is kept in.
    pub folder_id: Option<String>,
    /// Pinned to the top of a list.
    pub pinned: bool,
    /// The thread it was made in; `null` once that is deleted, or when it had none.
    pub thread_id: Option<String>,
    /// The project it belongs to.
    pub project_id: Option<String>,
    /// Who made it.
    pub created_by: ArtifactAuthorView,
    /// The number of its latest version, from 1.
    pub version: i32,
    /// When, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// One version of an artifact, with its content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionView {
    /// Its artifact.
    pub artifact_id: String,
    /// Its number.
    pub version: i32,
    /// The whole source.
    pub content: String,
    /// For a React component, the object it declares as `tweaks`, as written.
    pub tweaks: Option<String>,
    /// Who wrote it.
    pub author: ArtifactAuthorView,
    /// When, UTC ISO 8601.
    pub created_at: String,
}

/// An artifact with the content of one of its versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDetail {
    /// The artifact.
    pub artifact: ArtifactView,
    /// The version asked for, the latest by default.
    pub version: ArtifactVersionView,
}

/// A version in a list: who and when, without its content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionInfoView {
    /// Its number.
    pub version: i32,
    /// Who wrote it.
    pub author: ArtifactAuthorView,
    /// How long its content is, in characters.
    #[ts(type = "number")]
    pub chars: i64,
    /// When, UTC ISO 8601.
    pub created_at: String,
}

/// `GET /v1/artifacts/{id}/versions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionsList {
    /// The versions, oldest first.
    pub items: Vec<ArtifactVersionInfoView>,
}

/// `GET /v1/artifacts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsPage {
    /// The artifacts the caller sees, newest first.
    pub items: Vec<ArtifactView>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `POST /v1/artifacts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtifactRequest {
    /// What it is drawn as.
    pub kind: String,
    /// Its title.
    pub title: String,
    /// The whole source of its first version.
    pub content: String,
    /// The thread it is made in: one the caller is in.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// The project it belongs to; without one, that of the thread.
    #[serde(default)]
    pub project_id: Option<String>,
}

/// `PATCH /v1/artifacts/{id}`: only what is set changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArtifactRequest {
    /// A new title.
    #[serde(default)]
    pub title: Option<String>,
    /// Pin it or unpin it.
    #[serde(default)]
    pub pinned: Option<bool>,
    /// The folder to move it to; an empty string takes it out of any folder.
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// `PUT /v1/artifacts/{id}/content`: the editor's save of the whole source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SaveArtifactRequest {
    /// The whole source.
    pub content: String,
    /// Names one editing stretch: autosaves with the same key rewrite the version it began
    /// while it is still the latest and the caller's own, instead of making a hundred.
    #[serde(default)]
    pub edit_key: Option<String>,
}

/// One exact-text change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SourceEditView {
    /// Text that occurs exactly once in the source the edits before it left.
    pub find: String,
    /// What replaces it.
    pub replace: String,
}

/// `POST /v1/artifacts/{id}/edits`: changes the latest source by exact text, all or nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EditArtifactRequest {
    /// The changes, applied in order.
    pub edits: Vec<SourceEditView>,
}

/// A folder of artifacts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFolderView {
    /// Its id.
    pub id: String,
    /// Its name.
    pub name: String,
    /// The account that made it.
    pub created_by: String,
    /// When, UTC ISO 8601.
    pub created_at: String,
}

/// `GET /v1/artifact-folders`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFoldersList {
    /// The folders, oldest first.
    pub items: Vec<ArtifactFolderView>,
}

/// `POST /v1/artifact-folders` and `PATCH /v1/artifact-folders/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFolderRequest {
    /// The folder's name.
    pub name: String,
}

/// An artifact got a new version: the artifact as it is now, and who wrote which version. The
/// content is read with `GET /v1/artifacts/{id}`, so a delta stays small.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersioned {
    /// The artifact now.
    pub artifact: ArtifactView,
    /// The version that was written (or rewritten).
    pub version: i32,
    /// Who wrote it.
    pub author: ArtifactAuthorView,
}

/// An artifact was deleted, or the client no longer sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGone {
    /// Its id.
    pub artifact_id: String,
}
