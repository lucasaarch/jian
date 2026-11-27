//! Pull request tools: read one whole, merge, bring its branch up to date, comment and review.

use jian_plugin_api::ToolDef;
use serde_json::{Value, json};

use crate::api::Api;
use crate::error::GithubError;
use crate::input::{self, optional, render, slim, slim_all};

const PULL_FIELDS: &[&str] = &[
    "number",
    "title",
    "state",
    "draft",
    "merged",
    "mergeable",
    "mergeable_state",
    "user",
    "head",
    "base",
    "html_url",
    "body",
    "updated_at",
    "merged_by",
];
const SUMMARY_FIELDS: &[&str] = &[
    "number",
    "title",
    "state",
    "draft",
    "user",
    "head",
    "base",
    "html_url",
    "updated_at",
];

/// The tools of this file.
pub fn defs() -> Vec<ToolDef> {
    let repo = json!({ "type": "string", "description": "owner/name" });
    let number = json!({ "type": "integer", "minimum": 1 });
    vec![
        ToolDef {
            name: "list_pulls",
            description: "Lists a repository's pull requests (30 a page).".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo"], "properties": {
                "repo": repo, "state": { "enum": ["open", "closed", "all"] }, "page": number } }),
            read_only: true,
        },
        ToolDef {
            name: "get_pull",
            description: "Reads a pull request whole: its state and whether it merges, its \
                reviews with their text, comments, and the checks on its head commit."
                .to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"],
                "properties": { "repo": repo, "number": number } }),
            read_only: true,
        },
        ToolDef {
            name: "merge_pull",
            description: "Merges a pull request. If GitHub refuses, the answer is GitHub's own \
                reason (a failing check, a required review, a conflict)."
                .to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"], "properties": {
                "repo": repo, "number": number,
                "method": { "enum": ["merge", "squash", "rebase"] },
                "commit_title": { "type": "string" },
                "sha": { "type": "string", "description": "merge only if the head is still this commit" } } }),
            read_only: false,
        },
        ToolDef {
            name: "update_pull_branch",
            description: "Merges the base branch into a pull request's branch. GitHub does it in \
                the background; the pull request stays open."
                .to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"],
                "properties": { "repo": repo, "number": number } }),
            read_only: false,
        },
        ToolDef {
            name: "review_pull",
            description: "Submits a review on a pull request.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number", "event"], "properties": {
                "repo": repo, "number": number,
                "event": { "enum": ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
                "body": { "type": "string" } } }),
            read_only: false,
        },
    ]
}

/// Runs a pull request tool; `None` when `tool` is not one of them.
pub async fn call(api: &Api<'_>, tool: &str, v: &Value) -> Option<Result<String, GithubError>> {
    Some(match tool {
        "list_pulls" => list(api, v).await,
        "get_pull" => get(api, v).await,
        "merge_pull" => merge(api, v).await,
        "update_pull_branch" => update_branch(api, v).await,
        "review_pull" => review(api, v).await,
        _ => return None,
    })
}

async fn list(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let path = format!("{}/pulls", input::repo_path(v)?);
    let state = optional(v, "state").unwrap_or("open").to_owned();
    let query = [
        ("state", state),
        ("per_page", "30".to_owned()),
        ("page", input::page(v)),
    ];
    let answer = api.get(&path, &query).await?;
    Ok(render(&slim_all(&answer, SUMMARY_FIELDS)))
}

/// The pull request with what a reviewer reads next to it. The checks are of the head commit
/// as GitHub has it now; the reviews keep their text.
async fn get(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let pull = api.get(&format!("{repo}/pulls/{number}"), &[]).await?;
    let per = [("per_page", "100".to_owned())];
    let reviews = api
        .get(&format!("{repo}/pulls/{number}/reviews"), &per)
        .await?;
    let comments = api
        .get(&format!("{repo}/issues/{number}/comments"), &per)
        .await?;
    let inline = api
        .get(&format!("{repo}/pulls/{number}/comments"), &per)
        .await?;
    let sha = pull["head"]["sha"].as_str().unwrap_or_default();
    let checks = if sha.is_empty() {
        Value::Null
    } else {
        api.get(&format!("{repo}/commits/{sha}/check-runs"), &per)
            .await?
    };
    Ok(render(&json!({
        "pull": slim(&pull, PULL_FIELDS),
        "reviews": slim_all(&reviews, &["user", "state", "body", "commit_id", "submitted_at"]),
        "comments": slim_all(&comments, &["user", "body", "created_at"]),
        "review_comments": slim_all(&inline, &["user", "path", "line", "body"]),
        "checks": slim_all(&checks["check_runs"], &["name", "status", "conclusion"]),
    })))
}

async fn merge(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let mut body = json!({ "merge_method": optional(v, "method").unwrap_or("merge") });
    for key in ["commit_title", "sha"] {
        if let Some(value) = optional(v, key) {
            body[key] = json!(value);
        }
    }
    // A refusal (405, 409) is GitHub's reason as it is, in `GithubError::Api`.
    let answer = api
        .send(
            "PUT",
            &format!("{repo}/pulls/{number}/merge"),
            &[],
            Some(&body),
        )
        .await?;
    if answer["merged"].as_bool() == Some(true) {
        Ok(format!(
            "merged: {}",
            answer["sha"].as_str().unwrap_or_default()
        ))
    } else {
        Err(GithubError::Input(format!(
            "GitHub did not merge it: {}",
            answer["message"].as_str().unwrap_or("no reason given")
        )))
    }
}

/// GitHub answers 202 "updating" at once and moves the head later. The state told back is read
/// from the pull request, so it never says merged for a branch that was only updated.
async fn update_branch(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let asked = api
        .send(
            "PUT",
            &format!("{repo}/pulls/{number}/update-branch"),
            &[],
            Some(&json!({})),
        )
        .await?;
    let pull = api.get(&format!("{repo}/pulls/{number}"), &[]).await?;
    Ok(format!(
        "{} The pull request is {}{}.",
        asked["message"].as_str().unwrap_or("Update requested."),
        pull["state"].as_str().unwrap_or("open"),
        if pull["merged"].as_bool() == Some(true) {
            " and merged"
        } else {
            ", not merged"
        },
    ))
}

async fn review(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let event = input::text(v, "event")?;
    if !matches!(event, "APPROVE" | "REQUEST_CHANGES" | "COMMENT") {
        return Err(GithubError::Input(
            "`event` is APPROVE, REQUEST_CHANGES or COMMENT".to_owned(),
        ));
    }
    let mut body = json!({ "event": event });
    if let Some(text) = optional(v, "body") {
        body["body"] = json!(text);
    } else if event != "APPROVE" {
        return Err(GithubError::Input(
            "a review that is not an approval needs a `body`".to_owned(),
        ));
    }
    let made = api
        .send(
            "POST",
            &format!("{repo}/pulls/{number}/reviews"),
            &[],
            Some(&body),
        )
        .await?;
    Ok(format!(
        "review {} submitted: {}",
        made["id"],
        made["state"].as_str().unwrap_or_default()
    ))
}
