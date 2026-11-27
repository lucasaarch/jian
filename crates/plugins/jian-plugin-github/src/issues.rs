//! Issue tools: list with filters, read with comments, create, edit, comment, close.
//!
//! Creating sends the title, body, labels and assignees and nothing else. The old Jian made an
//! issue under a parent of its own invention; here an issue has no parent unless a person sets
//! one on GitHub.

use jian_plugin_api::ToolDef;
use serde_json::{Value, json};

use crate::api::Api;
use crate::error::GithubError;
use crate::input::{self, optional, render, slim, slim_all};

const ISSUE_FIELDS: &[&str] = &[
    "number",
    "title",
    "state",
    "state_reason",
    "user",
    "assignees",
    "labels",
    "html_url",
    "body",
    "comments",
    "updated_at",
];
const SUMMARY_FIELDS: &[&str] = &[
    "number",
    "title",
    "state",
    "user",
    "assignees",
    "labels",
    "html_url",
    "comments",
    "updated_at",
];

/// The tools of this file.
pub fn defs() -> Vec<ToolDef> {
    let repo = json!({ "type": "string", "description": "owner/name" });
    let number = json!({ "type": "integer", "minimum": 1 });
    let texts = json!({ "type": "array", "items": { "type": "string" } });
    vec![
        ToolDef {
            name: "list_issues",
            description: "Lists issues (not pull requests), 30 a page. Without `repo` it \
                searches every repository of the account's owner."
                .to_owned(),
            input_schema: json!({ "type": "object", "properties": {
                "repo": repo, "state": { "enum": ["open", "closed", "all"] },
                "labels": texts, "assignee": { "type": "string" },
                "query": { "type": "string", "description": "words to search for" },
                "page": number } }),
            read_only: true,
        },
        ToolDef {
            name: "get_issue",
            description: "Reads an issue with its comments.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"],
                "properties": { "repo": repo, "number": number } }),
            read_only: true,
        },
        ToolDef {
            name: "create_issue",
            description: "Opens an issue.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "title"], "properties": {
                "repo": repo, "title": { "type": "string" }, "body": { "type": "string" },
                "labels": texts, "assignees": texts } }),
            read_only: false,
        },
        ToolDef {
            name: "edit_issue",
            description: "Changes an issue's title, body, labels, assignees or state.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"], "properties": {
                "repo": repo, "number": number, "title": { "type": "string" },
                "body": { "type": "string" }, "labels": texts, "assignees": texts,
                "state": { "enum": ["open", "closed"] } } }),
            read_only: false,
        },
        ToolDef {
            name: "comment",
            description: "Comments on an issue or a pull request.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number", "body"],
                "properties": { "repo": repo, "number": number, "body": { "type": "string" } } }),
            read_only: false,
        },
        ToolDef {
            name: "close_issue",
            description: "Closes an issue, as completed or as not planned.".to_owned(),
            input_schema: json!({ "type": "object", "required": ["repo", "number"], "properties": {
                "repo": repo, "number": number,
                "reason": { "enum": ["completed", "not_planned"] } } }),
            read_only: false,
        },
    ]
}

/// Runs an issue tool; `None` when `tool` is not one of them.
pub async fn call(api: &Api<'_>, tool: &str, v: &Value) -> Option<Result<String, GithubError>> {
    Some(match tool {
        "list_issues" => list(api, v).await,
        "get_issue" => get(api, v).await,
        "create_issue" => create(api, v).await,
        "edit_issue" => edit(api, v).await,
        "comment" => comment(api, v).await,
        "close_issue" => close(api, v).await,
        _ => return None,
    })
}

/// A word that goes into a search query: no space or quote that would end the qualifier.
fn qualifier(value: &str) -> String {
    if value.contains([' ', '"']) {
        format!("\"{}\"", value.replace('"', ""))
    } else {
        value.to_owned()
    }
}

async fn list(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let state = optional(v, "state").unwrap_or("open");
    let labels = input::list(v, "labels")?.unwrap_or_default();
    let assignee = optional(v, "assignee");
    let query = optional(v, "query");
    // A search is the only way to look for words, or across repositories; a plain list of one
    // repository is cheaper and keeps GitHub's own order.
    if query.is_some() || v["repo"].is_null() {
        let mut parts = vec!["is:issue".to_owned()];
        if v["repo"].is_null() {
            parts.push(format!("user:{}", api.config().login));
        } else {
            let (owner, name) = input::repo(v)?;
            parts.push(format!("repo:{owner}/{name}"));
        }
        if state != "all" {
            parts.push(format!("state:{state}"));
        }
        for label in &labels {
            parts.push(format!("label:{}", qualifier(label)));
        }
        if let Some(who) = assignee {
            parts.push(format!("assignee:{}", qualifier(who)));
        }
        if let Some(words) = query {
            parts.push(words.to_owned());
        }
        let q = parts.join(" ");
        let answer = api
            .get(
                "/search/issues",
                &[
                    ("q", q),
                    ("per_page", "30".to_owned()),
                    ("page", input::page(v)),
                ],
            )
            .await?;
        return Ok(render(&slim_all(&answer["items"], SUMMARY_FIELDS)));
    }
    let path = format!("{}/issues", input::repo_path(v)?);
    let mut params = vec![
        ("state", state.to_owned()),
        ("per_page", "30".to_owned()),
        ("page", input::page(v)),
    ];
    if !labels.is_empty() {
        params.push(("labels", labels.join(",")));
    }
    if let Some(who) = assignee {
        params.push(("assignee", who.to_owned()));
    }
    let answer = api.get(&path, &params).await?;
    // The issues endpoint lists pull requests too.
    let issues: Vec<Value> = answer
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("pull_request").is_none())
        .cloned()
        .collect();
    Ok(render(&slim_all(&Value::Array(issues), SUMMARY_FIELDS)))
}

async fn get(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let issue = api.get(&format!("{repo}/issues/{number}"), &[]).await?;
    let comments = api
        .get(
            &format!("{repo}/issues/{number}/comments"),
            &[("per_page", "100".to_owned())],
        )
        .await?;
    Ok(render(&json!({
        "issue": slim(&issue, ISSUE_FIELDS),
        "comments": slim_all(&comments, &["user", "body", "created_at"]),
    })))
}

async fn create(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let path = format!("{}/issues", input::repo_path(v)?);
    let mut body = json!({ "title": input::text(v, "title")? });
    if let Some(text) = optional(v, "body") {
        body["body"] = json!(text);
    }
    for key in ["labels", "assignees"] {
        if let Some(list) = input::list(v, key)? {
            body[key] = json!(list);
        }
    }
    let made = api.send("POST", &path, &[], Some(&body)).await?;
    Ok(render(&slim(&made, SUMMARY_FIELDS)))
}

async fn edit(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let mut body = json!({});
    for key in ["title", "body"] {
        if let Some(text) = v[key].as_str() {
            body[key] = json!(text);
        }
    }
    for key in ["labels", "assignees"] {
        if let Some(list) = input::list(v, key)? {
            body[key] = json!(list);
        }
    }
    if let Some(state) = optional(v, "state") {
        if !matches!(state, "open" | "closed") {
            return Err(GithubError::Input("`state` is open or closed".to_owned()));
        }
        body["state"] = json!(state);
    }
    let made = api
        .send(
            "PATCH",
            &format!("{repo}/issues/{number}"),
            &[],
            Some(&body),
        )
        .await?;
    Ok(render(&slim(&made, SUMMARY_FIELDS)))
}

async fn comment(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let body = json!({ "body": input::text(v, "body")? });
    let made = api
        .send(
            "POST",
            &format!("{repo}/issues/{number}/comments"),
            &[],
            Some(&body),
        )
        .await?;
    Ok(format!(
        "commented: {}",
        made["html_url"].as_str().unwrap_or_default()
    ))
}

async fn close(api: &Api<'_>, v: &Value) -> Result<String, GithubError> {
    let repo = input::repo_path(v)?;
    let number = input::number(v, "number")?;
    let reason = optional(v, "reason").unwrap_or("completed");
    if !matches!(reason, "completed" | "not_planned") {
        return Err(GithubError::Input(
            "`reason` is completed or not_planned".to_owned(),
        ));
    }
    let body = json!({ "state": "closed", "state_reason": reason });
    let made = api
        .send(
            "PATCH",
            &format!("{repo}/issues/{number}"),
            &[],
            Some(&body),
        )
        .await?;
    Ok(render(&slim(&made, SUMMARY_FIELDS)))
}
