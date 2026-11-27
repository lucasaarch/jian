//! GitHub's webhook: `POST /v1/public/github/webhook/{tenant}`, and the job that acts on it,
//! `github.webhook`.
//!
//! GitHub calls with no token, so the signature is the only thing that says who is calling. The
//! route finds the installation accounts of the workspace the address names, takes the webhook
//! secret of the one the payload says it is for out of the vault, and checks `X-Hub-Signature-256`
//! against the raw body (`jian_plugin_github::webhook::verify`, constant time). A delivery that
//! does not verify against any account is a `401` that says nothing more, and nothing is written:
//! no job, no event, no log of its content. The installation id is read from the unverified
//! body only to know which secret to try.
//!
//! A verified delivery that means nothing to an agent (a star, a label) is a `204`. One that does
//! becomes a `github.webhook` job keyed by `X-GitHub-Delivery`, so GitHub redelivering it (it does,
//! on a timeout) finds the first job and queues nothing. The job writes the event for the agents
//! that reach the account, keyed again by the delivery, so a job that runs twice writes it once.
//! Delivering is therefore idempotent in both places, and the payload of the job and of the event
//! hold ids, logins and addresses, never a token or text a stranger wrote.
//!
//! When the installation has a `reviewAgent` and the delivery is a pull request opened, pushed to
//! or made ready, the job also asks that agent for a review, once per head commit (see
//! `github_review`).
//!
//! The workspace is in the address because a GitHub App is a workspace's own: the address is made
//! by the panel when the App is registered (see `PublicUrl::github_webhook`). A workspace that does
//! not exist is a 404.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use futures_util::future::BoxFuture;
use jian_plugin_api::{AgentEvent, Secret};
use jian_plugin_github::webhook::{installation_of, translate, verify};
use jian_plugin_github::{GITHUB_ID, KIND_INSTALLATION, account::webhook_secret_of};
use jian_store::{AgentId, ConnectorAccount, Database, NewJob, TenantCtx, TenantId};
use serde_json::{Value, json};

use crate::AppState;
use crate::github_review::{Asked, ask};
use crate::http::{Refusal, internal, not_found, refuse};
use crate::plugins::Plugins;
use crate::{JobContext, JobError, JobHandler};

/// The kind of job this handler runs.
pub const GITHUB_WEBHOOK_KIND: &str = "github.webhook";

/// The longest `X-GitHub-Delivery` taken: GitHub's are 36-character UUIDs.
const MAX_DELIVERY_CHARS: usize = 64;

/// The most a delivery's body may be; GitHub itself caps them at 25 MB, and what an agent needs is
/// in the first lines of it.
pub(crate) const MAX_WEBHOOK_BODY: usize = 5 * 1024 * 1024;

fn unauthorized() -> Refusal {
    refuse(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "the signature is not right",
    )
}

/// The installation account the signature is of, when there is one.
async fn signed_for(
    app: &AppState,
    ctx: &TenantCtx,
    payload: &Value,
    body: &[u8],
    signature: &str,
) -> Result<Option<ConnectorAccount>, Refusal> {
    let installation = installation_of(payload);
    let accounts = app
        .db
        .plugin_connector_accounts(ctx, GITHUB_ID)
        .await
        .map_err(|e| internal(&e))?;
    for account in accounts {
        if account.kind != KIND_INSTALLATION {
            continue;
        }
        if installation.is_some_and(|id| account.config["installationId"].as_u64() != Some(id)) {
            continue;
        }
        let secret = app
            .db
            .connector_account_secret(ctx, &account.id)
            .await
            .map_err(|e| internal(&e))?;
        let Some(secret) = secret else { continue };
        let Some(webhook) = webhook_secret_of(&Secret::new(secret.expose())) else {
            continue;
        };
        if verify(&webhook, body, signature) {
            return Ok(Some(account));
        }
    }
    Ok(None)
}

fn valid_delivery(delivery: &str) -> bool {
    !delivery.is_empty()
        && delivery.len() <= MAX_DELIVERY_CHARS
        && delivery
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `POST /v1/public/github/webhook/{tenant}`: 202 when queued, 204 when the delivery is of no
/// interest, 401 when the signature is not right, 400 when it is right and the delivery has no
/// usable id, 404 for a workspace that does not exist.
pub(crate) async fn receive(
    State(app): State<AppState>,
    Path(tenant): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, Refusal> {
    let tenant = TenantId::parse(&tenant).map_err(|_| not_found("workspace"))?;
    let ctx = app
        .db
        .tenant(tenant)
        .await
        .map_err(|_| not_found("workspace"))?;
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let signature = header("x-hub-signature-256").ok_or_else(unauthorized)?;
    let payload: Value = serde_json::from_slice(&body).map_err(|_| unauthorized())?;
    let account = signed_for(&app, &ctx, &payload, &body, signature)
        .await?
        .ok_or_else(unauthorized)?;
    // From here on the delivery is GitHub's, for this account.
    let Some(delivery) = header("x-github-delivery").filter(|d| valid_delivery(d)) else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "the delivery has no usable id",
        ));
    };
    let Some(heard) = translate(header("x-github-event").unwrap_or_default(), &payload) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let review = heard.review.map(|target| {
        json!({ "repo": target.repo, "number": target.number, "headSha": target.head_sha })
    });
    let job = NewJob::new(
        GITHUB_WEBHOOK_KIND,
        json!({
            "delivery": delivery,
            "account": account.id.as_str(),
            "kind": heard.notice.kind,
            "notice": heard.notice.payload,
            "review": review,
        }),
    )
    .idempotent(format!("delivery:{delivery}"));
    app.db
        .enqueue_job(&ctx, job)
        .await
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::ACCEPTED)
}

/// Turns a queued delivery into events for the agents. Built with the plugins the gateway runs
/// with, so the event is written the way a plugin's own would be.
#[derive(Clone)]
pub struct GithubWebhookHandler {
    plugins: Arc<Plugins>,
}

impl GithubWebhookHandler {
    /// A handler writing through `plugins`.
    #[must_use]
    pub fn new(plugins: Plugins) -> Self {
        Self {
            plugins: Arc::new(plugins),
        }
    }

    async fn run(&self, context: JobContext) -> Result<(), JobError> {
        let JobContext { job, tenant, db } = context;
        let payload = &job.payload;
        let (Some(delivery), Some(account), Some(kind)) = (
            payload["delivery"].as_str(),
            payload["account"].as_str(),
            payload["kind"].as_str(),
        ) else {
            return Err(JobError::permanent("the payload is not a delivery"));
        };
        let retry = |error: &dyn std::fmt::Display| JobError::retry(error.to_string());
        let accounts = db
            .plugin_connector_accounts(&tenant, GITHUB_ID)
            .await
            .map_err(|e| retry(&e))?;
        // Deleted since the delivery came: there is nobody to tell.
        let Some(account) = accounts.into_iter().find(|a| a.id.as_str() == account) else {
            return Ok(());
        };
        let event = AgentEvent {
            kind: kind.to_owned(),
            payload: payload["notice"].clone(),
            key: Some(format!("gh:{delivery}")),
        };
        self.plugins
            .emit(&db, &tenant, &account, None, event)
            .await
            .map_err(|e| retry(&e))?;
        self.review(&db, &tenant, &account, &payload["review"])
            .await
            .map_err(JobError::retry)
    }

    /// The review a delivery asks for, when the installation names an agent to make it.
    async fn review(
        &self,
        db: &Database,
        tenant: &TenantCtx,
        account: &ConnectorAccount,
        target: &Value,
    ) -> Result<(), String> {
        let (Some(repo), Some(number), Some(sha)) = (
            target["repo"].as_str(),
            target["number"].as_u64(),
            target["headSha"].as_str(),
        ) else {
            return Ok(());
        };
        let Some(agent) = account.config["reviewAgent"].as_str() else {
            return Ok(());
        };
        let asked = ask(
            &self.plugins,
            db,
            tenant,
            account,
            &AgentId::new(agent),
            (repo, number, sha),
        )
        .await?;
        if asked == Asked::NotReached {
            tracing::warn!(
                "the review agent of an installation no longer reaches it; no review asked"
            );
        }
        Ok(())
    }
}

impl JobHandler for GithubWebhookHandler {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.run(context))
    }
}
