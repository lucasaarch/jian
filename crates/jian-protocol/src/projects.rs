//! Projects: the JSON bodies of `/v1/projects*` and of the project a thread is about.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    /// Its id.
    pub id: String,
    /// What it is called.
    pub name: String,
    /// The repository it works on.
    pub repository_url: Option<String>,
    /// What to keep in mind in its conversations.
    pub instructions: String,
    /// The member who made it.
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
    /// The projects, oldest first.
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
    /// The repository.
    #[serde(default)]
    pub repository_url: Option<String>,
    /// What to keep in mind.
    #[serde(default)]
    pub instructions: String,
}

/// `PATCH /v1/projects/{id}`: a field left out stays as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new repository; an empty text removes it.
    #[serde(default)]
    pub repository_url: Option<String>,
    /// New instructions.
    #[serde(default)]
    pub instructions: Option<String>,
}

/// `PUT /v1/threads/{id}/project`: the project the thread is about, or `null` for none.
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
    /// The project, or `null` when the thread is about none.
    pub project: Option<ProjectView>,
}
