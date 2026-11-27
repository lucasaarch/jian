//! A small GraphQL client for Linear over the host's one door out.
//!
//! Every request goes through [`AccountContext::http`], so the host's limits and, in the Cloud,
//! its refusal of private addresses apply. Each takes its token from [`oauth::bearer`] at that
//! moment; one that Linear refuses is asked for again once with a new token, then the failure is
//! told.
//!
//! # Rate limit
//!
//! Linear answers a call over its budget with HTTP 429, or with HTTP 400 and the code
//! `RATELIMITED` in the body. The wait it asks for comes from `Retry-After` or from
//! `X-RateLimit-Requests-Reset`. A call waits at most [`MAX_WAIT`] seconds per retry and retries
//! [`MAX_RETRIES`] times; a longer wait is told to the model, which can decide to come back later.
//!
//! # Cache
//!
//! The lists of teams, projects, states, labels and milestones change rarely and an agent asks
//! for them again and again, so [`Api::cached`] keeps an answer for [`CACHE_FOR`]. The cache is
//! per account (its id is in the key) and any write through the same account drops that
//! account's entries, so an agent that creates a label sees it at once.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use jian_plugin_api::{AccountContext, HttpRequest};
use serde_json::{Value, json};

use crate::config::Config;
use crate::error::LinearError;
use crate::oauth;

/// The longest a single rate-limit wait may be before the call gives up and says so.
pub const MAX_WAIT: u64 = 10;
/// How many times a call is retried after a rate-limit answer.
pub const MAX_RETRIES: usize = 2;
/// How long a cached list stays fresh. Short, because a person changing a list in Linear should
/// see it soon, and long enough to cover an agent's burst of lookups.
pub const CACHE_FOR: Duration = Duration::from_secs(60);
/// The cache holds at most this many answers; it is emptied when it fills.
const CACHE_ENTRIES: usize = 256;

type Cache = Mutex<HashMap<(String, String), (Instant, Value)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// One account's way to Linear, for the calls of one operation.
pub struct Api<'a> {
    ctx: &'a AccountContext<'a>,
    config: Config,
}

impl<'a> Api<'a> {
    /// A client for the account in `ctx`.
    pub fn new(ctx: &'a AccountContext<'a>) -> Result<Self, LinearError> {
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

    /// Runs a query or mutation and returns its `data`. A write drops the account's cache.
    pub async fn graphql(&self, query: &str, variables: Value) -> Result<Value, LinearError> {
        if query.trim_start().starts_with("mutation") {
            let id = self.ctx.account().id.to_string();
            if let Ok(mut held) = cache().lock() {
                held.retain(|(account, _), _| *account != id);
            }
        }
        let mut stale: Option<String> = None;
        let mut retries = 0;
        loop {
            let token = oauth::bearer(self.ctx, &self.config, stale.as_deref()).await?;
            let answer = self.once(query, &variables, token.expose()).await?;
            if answer.refused && stale.is_none() {
                stale = Some(token.expose().to_owned());
                continue;
            }
            if let Some(wait) = answer.wait {
                if wait > MAX_WAIT {
                    return Err(LinearError::RateLimited(wait));
                }
                if retries < MAX_RETRIES {
                    retries += 1;
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    continue;
                }
                return Err(LinearError::RateLimited(wait));
            }
            return answer.into_data(token.expose());
        }
    }

    /// The same, for a read whose answer may be a minute old.
    pub async fn cached(&self, query: &str, variables: Value) -> Result<Value, LinearError> {
        let key = (
            self.ctx.account().id.to_string(),
            format!("{query}{variables}"),
        );
        if let Ok(held) = cache().lock()
            && let Some((at, value)) = held.get(&key)
            && at.elapsed() < CACHE_FOR
        {
            return Ok(value.clone());
        }
        let value = self.graphql(query, variables).await?;
        if let Ok(mut held) = cache().lock() {
            if held.len() >= CACHE_ENTRIES {
                held.clear();
            }
            held.insert(key, (Instant::now(), value.clone()));
        }
        Ok(value)
    }

    async fn once(
        &self,
        query: &str,
        variables: &Value,
        token: &str,
    ) -> Result<Answer, LinearError> {
        let body = json!({ "query": query, "variables": variables }).to_string();
        let response = self
            .ctx
            .http(HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}/graphql", self.config.api_base),
                headers: vec![
                    ("authorization".to_owned(), format!("Bearer {token}")),
                    ("content-type".to_owned(), "application/json".to_owned()),
                    ("accept".to_owned(), "application/json".to_owned()),
                ],
                body: Some(body.into_bytes()),
            })
            .await
            .map_err(|error| LinearError::Transport(error.to_string()))?;
        let header = |name: &str| {
            response
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        };
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let code = body["errors"][0]["extensions"]["code"]
            .as_str()
            .unwrap_or("");
        let limited = response.status == 429 || code == "RATELIMITED";
        let wait = limited.then(|| {
            header("retry-after")
                .and_then(|v| v.trim().parse::<u64>().ok())
                .or_else(|| header("x-ratelimit-requests-reset").and_then(reset_in))
                .unwrap_or(1)
        });
        Ok(Answer {
            status: response.status,
            refused: response.status == 401 || code == "AUTHENTICATION_ERROR",
            wait,
            body,
        })
    }
}

/// Seconds until a reset header's moment: Linear writes it as a Unix time, in seconds or in
/// milliseconds.
fn reset_in(value: &str) -> Option<u64> {
    let at: u64 = value.trim().parse().ok()?;
    let at = if at > 1_000_000_000_000 {
        at / 1000
    } else {
        at
    };
    Some(at.saturating_sub(u64::try_from(oauth::now()).unwrap_or(0)))
}

struct Answer {
    status: u16,
    refused: bool,
    wait: Option<u64>,
    body: Value,
}

impl Answer {
    fn into_data(self, token: &str) -> Result<Value, LinearError> {
        let errors = self.body["errors"].as_array().filter(|e| !e.is_empty());
        if self.status >= 400 || errors.is_some() {
            let mut text = errors
                .map(|list| {
                    list.iter()
                        .take(3)
                        .filter_map(|e| e["message"].as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "no reason given".to_owned());
            if !token.is_empty() {
                text = text.replace(token, "[redacted]");
            }
            return Err(LinearError::Api {
                status: self.status,
                message: text.chars().take(500).collect(),
            });
        }
        Ok(self.body["data"].clone())
    }
}
