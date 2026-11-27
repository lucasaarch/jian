//! Reading a tool's input. The model writes it, so every value that ends up in a request path is
//! checked here: a repository is `owner/name` of GitHub-legal characters, a number is a number.

use serde_json::{Map, Value, json};

use crate::config::is_name;
use crate::error::GithubError;

fn bad(what: &str) -> GithubError {
    GithubError::Input(what.to_owned())
}

/// `owner/name` from `repo`, as the pair and as the path piece (`/repos/owner/name`).
pub fn repo(input: &Value) -> Result<(String, String), GithubError> {
    let text = input["repo"]
        .as_str()
        .ok_or_else(|| bad("`repo` is required, as owner/name"))?;
    match text.split_once('/') {
        Some((owner, name)) if is_name(owner) && is_name(name) => {
            Ok((owner.to_owned(), name.to_owned()))
        }
        _ => Err(bad("`repo` is owner/name, such as acme/widgets")),
    }
}

/// The path of the repository: `/repos/owner/name`.
pub fn repo_path(input: &Value) -> Result<String, GithubError> {
    let (owner, name) = repo(input)?;
    Ok(format!("/repos/{owner}/{name}"))
}

/// A positive whole number.
pub fn number(input: &Value, key: &str) -> Result<u64, GithubError> {
    input[key]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad(&format!("`{key}` is required, a positive number")))
}

/// A required text.
pub fn text<'v>(input: &'v Value, key: &str) -> Result<&'v str, GithubError> {
    input[key]
        .as_str()
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| bad(&format!("`{key}` is required")))
}

/// An optional text.
pub fn optional<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    input[key].as_str().filter(|t| !t.is_empty())
}

/// An optional list of texts (labels, assignees).
pub fn list(input: &Value, key: &str) -> Result<Option<Vec<String>>, GithubError> {
    match &input[key] {
        Value::Null => Ok(None),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| bad(&format!("`{key}` is a list of texts")))
            })
            .collect::<Result<_, _>>()
            .map(Some),
        _ => Err(bad(&format!("`{key}` is a list of texts"))),
    }
}

/// A page number, from 1.
pub fn page(input: &Value) -> String {
    input["page"]
        .as_u64()
        .filter(|p| *p > 0)
        .unwrap_or(1)
        .to_string()
}

/// `value` cut down to the fields that are in `keep`, one level deep, with the person fields
/// (`user`, `assignee`) reduced to their login. What the model reads is short and carries no
/// URL it has no use for.
#[must_use]
pub fn slim(value: &Value, keep: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keep {
        let Some(found) = value.get(*key).filter(|v| !v.is_null()) else {
            continue;
        };
        let shown = match *key {
            "user" | "assignee" | "merged_by" => found["login"].clone(),
            "assignees" | "labels" => Value::Array(
                found
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|item| {
                        item.get("login")
                            .or_else(|| item.get("name"))
                            .cloned()
                            .unwrap_or(Value::Null)
                    })
                    .collect(),
            ),
            "head" | "base" => json!({ "ref": found["ref"], "sha": found["sha"] }),
            _ => found.clone(),
        };
        out.insert((*key).to_owned(), shown);
    }
    Value::Object(out)
}

/// `slim` over a list.
#[must_use]
pub fn slim_all(values: &Value, keep: &[&str]) -> Value {
    Value::Array(
        values
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| slim(v, keep))
            .collect(),
    )
}

/// An answer as the text the model reads.
#[must_use]
pub fn render(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}
