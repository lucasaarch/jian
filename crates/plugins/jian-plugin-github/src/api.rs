//! A small GitHub REST client over the host's one door out.
//!
//! Every request goes through [`AccountContext::http`], so the host's limits and, in the Cloud,
//! its refusal of private addresses apply. The base address is the account's, so a GitHub
//! Enterprise server and a test's fake are the same code. Each request takes its token from
//! [`token::bearer`] at that moment; one that GitHub answers with 401 is asked for again once
//! with a new token (a token revoked before its hour was up), then the failure is told.

use jian_plugin_api::{AccountContext, HttpRequest};
use serde_json::Value;

use crate::config::Config;
use crate::error::GithubError;
use crate::token;

/// Sent on every request; GitHub refuses a request without a `User-Agent`.
const USER_AGENT: &str = "jian";

/// The headers every request has, with `credential` as the bearer.
#[must_use]
pub fn headers(credential: &str) -> Vec<(String, String)> {
    vec![
        (
            "accept".to_owned(),
            "application/vnd.github+json".to_owned(),
        ),
        ("x-github-api-version".to_owned(), "2022-11-28".to_owned()),
        ("user-agent".to_owned(), USER_AGENT.to_owned()),
        ("authorization".to_owned(), format!("Bearer {credential}")),
    ]
}

/// One account's way to GitHub, for the calls of one operation.
pub struct Api<'a> {
    ctx: &'a AccountContext<'a>,
    config: Config,
}

impl<'a> Api<'a> {
    /// A client for the account in `ctx`.
    pub fn new(ctx: &'a AccountContext<'a>) -> Result<Self, GithubError> {
        Ok(Self {
            ctx,
            config: Config::parse(&ctx.account().config)?,
        })
    }

    /// The account's settings.
    #[must_use]
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// `GET path?query`.
    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, GithubError> {
        self.send("GET", path, query, None).await
    }

    /// A request with an optional JSON body. An empty answer is `null`.
    pub async fn send(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, GithubError> {
        let mut stale: Option<String> = None;
        loop {
            let token = token::bearer(self.ctx, &self.config, stale.as_deref()).await?;
            let (status, answer) = self.once(method, path, query, body, token.expose()).await?;
            if status == 401 && stale.is_none() {
                stale = Some(token.expose().to_owned());
                continue;
            }
            if status >= 400 {
                return Err(GithubError::Api {
                    status,
                    message: reason(&answer, token.expose()),
                });
            }
            return Ok(answer);
        }
    }

    async fn once(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        token: &str,
    ) -> Result<(u16, Value), GithubError> {
        let mut url = url::Url::parse(&format!("{}{path}", self.config.api_base))
            .map_err(|_| GithubError::Input("the request address is not a URL".to_owned()))?;
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        let mut headers = headers(token);
        if body.is_some() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        let response = self
            .ctx
            .http(HttpRequest {
                method: method.to_owned(),
                url: url.into(),
                headers,
                body: body.map(|b| b.to_string().into_bytes()),
            })
            .await
            .map_err(|error| GithubError::Transport(error.to_string()))?;
        let answer = serde_json::from_slice(&response.body).unwrap_or_else(|_| {
            Value::String(String::from_utf8_lossy(&response.body).into_owned())
        });
        Ok((response.status, answer))
    }
}

/// GitHub's reason for an error, in its words: `message`, and the `errors` that say which field.
/// The token is cut out in case GitHub echoes it, and the text is bounded.
fn reason(answer: &Value, token: &str) -> String {
    let mut text = answer["message"]
        .as_str()
        .or_else(|| answer.as_str())
        .unwrap_or("no reason given")
        .to_owned();
    if let Some(errors) = answer["errors"].as_array().filter(|e| !e.is_empty()) {
        text = format!("{text} {}", Value::Array(errors.clone()));
    }
    if !token.is_empty() {
        text = text.replace(token, "[redacted]");
    }
    text.chars().take(500).collect()
}
