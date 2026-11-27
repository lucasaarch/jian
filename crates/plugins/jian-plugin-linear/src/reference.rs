//! Small reads the gateway makes for its own routes (not tools of an agent): which issue a person
//! named, and which workspace of Linear an account is.
//!
//! They ask Linear for ids only. A title or a description is never read here, so nothing a
//! stranger wrote can reach what the gateway stores, links or puts in a thread.

use jian_plugin_api::AccountContext;
use serde_json::json;

use crate::api::Api;
use crate::error::LinearError;
use crate::ids::{id, identifier};

/// An issue as the gateway keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueRef {
    /// Linear's id: what a webhook names.
    pub id: String,
    /// `ENG-12`, when Linear's is in the shape of one.
    pub identifier: Option<String>,
}

/// The issue `issue` (Linear's id or its identifier) is, read through the account.
///
/// # Errors
///
/// [`LinearError::Input`] when the account has no such issue; Linear's own errors otherwise.
pub async fn issue<'a>(ctx: &'a AccountContext<'a>, issue: &str) -> Result<IssueRef, LinearError> {
    let query = "query($id: String!) { issue(id: $id) { id identifier } }";
    let data = Api::new(ctx)?
        .graphql(query, json!({ "id": issue }))
        .await?;
    let found = &data["issue"];
    let issue_id = found["id"]
        .as_str()
        .and_then(id)
        .ok_or_else(|| LinearError::Input("Linear has no such issue".to_owned()))?;
    Ok(IssueRef {
        id: issue_id.to_owned(),
        identifier: identifier(found["identifier"].as_str()).map(str::to_owned),
    })
}

/// The Linear workspace the account is signed in to: what a webhook's `organizationId` names.
///
/// # Errors
///
/// Linear's own errors, or [`LinearError::Input`] when it gives no usable id.
pub async fn organization<'a>(ctx: &'a AccountContext<'a>) -> Result<String, LinearError> {
    let data = Api::new(ctx)?
        .graphql("query { organization { id } }", json!({}))
        .await?;
    data["organization"]["id"]
        .as_str()
        .and_then(id)
        .map(str::to_owned)
        .ok_or_else(|| LinearError::Input("Linear did not say which workspace this is".to_owned()))
}
