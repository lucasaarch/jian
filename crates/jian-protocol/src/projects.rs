//! Projects: the JSON bodies of `/v1/projects*`, and the project a thread is in.
//!
//! A project is a folder that groups conversations, files and instructions. A repository is an
//! optional attachment, not what the project is.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::threads::ThreadSummary;

/// A repository attached to a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepositoryView {
    /// Its id.
    pub id: String,
    /// Where it is.
    pub url: String,
    /// The branch to work on, when it is not the repository's own default.
    pub default_branch: Option<String>,
    /// When it was attached, UTC ISO 8601.
    pub created_at: String,
}

/// One project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    /// Its id.
    pub id: String,
    /// What it is called.
    pub name: String,
    /// What it is about.
    pub description: String,
    /// What to keep in mind in its conversations.
    pub instructions: String,
    /// An emoji or an icon name.
    pub icon: Option<String>,
    /// A color name or `#rrggbb`.
    pub color: Option<String>,
    /// `private`, `members` or `workspace`.
    pub visibility: String,
    /// The members who see it besides its creator, for `members`.
    pub viewers: Vec<String>,
    /// The repositories attached, in the order they were.
    pub repositories: Vec<ProjectRepositoryView>,
    /// The member who made it. Its creator and the admins change it.
    pub created_by: String,
    /// When, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// `GET /v1/projects`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsPage {
    /// The projects the caller sees, oldest first.
    pub items: Vec<ProjectView>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `POST /v1/projects`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    /// 1 to 120 characters.
    pub name: String,
    /// What it is about; up to 500 characters.
    #[serde(default)]
    pub description: String,
    /// What to keep in mind.
    #[serde(default)]
    pub instructions: String,
    /// An emoji or an icon name.
    #[serde(default)]
    pub icon: Option<String>,
    /// A color name or `#rrggbb`.
    #[serde(default)]
    pub color: Option<String>,
    /// `private` (the default), `members` or `workspace`.
    #[serde(default)]
    pub visibility: Option<String>,
    /// Accounts that see it besides the creator, for `members`.
    #[serde(default)]
    pub viewers: Vec<String>,
}

/// `PATCH /v1/projects/{id}`: a field left out stays as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new description.
    #[serde(default)]
    pub description: Option<String>,
    /// New instructions.
    #[serde(default)]
    pub instructions: Option<String>,
    /// A new icon; an empty text removes it.
    #[serde(default)]
    pub icon: Option<String>,
    /// A new color; an empty text removes it.
    #[serde(default)]
    pub color: Option<String>,
    /// A new visibility.
    #[serde(default)]
    pub visibility: Option<String>,
    /// The new list of viewers, replacing the old one.
    #[serde(default)]
    pub viewers: Option<Vec<String>>,
}

/// `POST /v1/projects/{id}/repositories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AttachRepositoryRequest {
    /// An HTTPS or SSH address.
    pub url: String,
    /// The branch to work on.
    #[serde(default)]
    pub default_branch: Option<String>,
}

/// `GET /v1/projects/{id}/repositories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepositories {
    /// The repositories attached.
    pub items: Vec<ProjectRepositoryView>,
}

/// A file of a project, without its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileView {
    /// Its id.
    pub id: String,
    /// The project it is in.
    pub project_id: String,
    /// The label it was given.
    pub name: String,
    /// How many bytes it has.
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Its media type.
    pub mime: String,
    /// The SHA-256 of its bytes, lowercase hex, computed by the gateway.
    pub sha256: String,
    /// The member who sent it.
    pub uploaded_by: String,
    /// When, UTC ISO 8601.
    pub created_at: String,
}

/// `GET /v1/projects/{id}/files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    /// The files, oldest first.
    pub items: Vec<ProjectFileView>,
}

/// `GET /v1/projects/{id}/threads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectThreadsPage {
    /// The threads of the project the caller sees, newest first.
    pub items: Vec<ThreadSummary>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `PUT /v1/threads/{id}/project`: the project the thread is in, or `null` for none. A thread is
/// in one project at most, so this moves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjectRequest {
    /// A project's id, or `null`.
    pub project_id: Option<String>,
}

/// `GET /v1/threads/{id}/project`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProject {
    /// The project, or `null` when the thread is in none.
    pub project: Option<ProjectView>,
}

/// What `project.file.added` and `project.file.removed` say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileChange {
    /// The project.
    pub project_id: String,
    /// The file, as it is or as it was.
    pub file: ProjectFileView,
}

/// What `project.thread.changed` says: a thread came into a project or left it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectThreadChange {
    /// The project.
    pub project_id: String,
    /// The thread.
    pub thread_id: String,
    /// `true` when the thread is in the project now, `false` when it left.
    pub linked: bool,
}

/// What `project.deleted` says. Whoever stops seeing a project gets it too, so a client drops
/// the project either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGone {
    /// The project.
    pub project_id: String,
}
