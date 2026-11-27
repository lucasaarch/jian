//! Linear's webhook: `POST /v1/public/linear/webhook/{tenant}`, and the job that acts on it,
//! `linear.webhook`.
//!
//! Linear calls with no token, so the signature is the only thing that says who is calling. The
//! route tries the webhook secret of each Linear account of the workspace the address names (an
//! account whose Linear workspace is known and is not the one the payload names is skipped) and
//! checks `Linear-Signature` against the raw body in constant time. A delivery that verifies
//! against no account, or whose signed `webhookTimestamp` is not recent (a recorded delivery
//! replayed), is a `401` that says nothing more, and nothing is written: no job, no event.
//!
//! A verified delivery that means nothing to an agent (a label, an update that assigned nobody,
//! something an app did) is a `204`. One that does becomes a `linear.webhook` job keyed by
//! `Linear-Delivery`, so Linear redelivering it (it does, on a timeout) finds the first job and
//! queues nothing. The job writes the event, keyed again by the delivery, so a job that runs twice
//! writes it once. It goes to the threads started from the issue; when none is linked, or none of
//! their agents still reaches the account, to every agent that reaches the account. What is in
//! the job and the event is ids, an identifier and a Linear address, never a token or text a
//! stranger wrote.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use futures_util::future::BoxFuture;
use jian_plugin_api::{AgentEvent, Secret};
use jian_plugin_linear::account::webhook_secret_of;
use jian_plugin_linear::webhook::{fresh, organization_of, translate, verify};
use jian_plugin_linear::{KIND_WORKSPACE, LINEAR_ID};
use jian_runtime::system_now_ms;
use jian_store::{ConnectorAccount, NewJob, TenantCtx, TenantId};
use serde_json::{Value, json};

use crate::AppState;
use crate::http::{Refusal, internal, not_found, refuse};
use crate::plugins::Plugins;
use crate::{JobContext, JobError, JobHandler};

/// The kind of job this handler runs.
pub const LINEAR_WEBHOOK_KIND: &str = "linear.webhook";

/// The longest `Linear-Delivery` taken: Linear's are 36-character UUIDs.
const MAX_DELIVERY_CHARS: usize = 64;

/// The most a delivery's body may be; what an agent needs is in the first lines of it.
pub(crate) const MAX_WEBHOOK_BODY: usize = 1024 * 1024;

fn unauthorized() -> Refusal {
    refuse(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "the signature is not right",
    )
}

/// The account the signature is of, when there is one.
async fn signed_for(
    app: &AppState,
    ctx: &TenantCtx,
    payload: &Value,
    body: &[u8],
    signature: &str,
) -> Result<Option<ConnectorAccount>, Refusal> {
    let organization = organization_of(payload);
    let accounts = app
        .db
        .plugin_connector_accounts(ctx, LINEAR_ID)
        .await
        .map_err(|e| internal(&e))?;
    for account in accounts {
        if account.kind != KIND_WORKSPACE {
            continue;
        }
        let known = account.config["organizationId"].as_str();
        if known.is_some() && known != organization {
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

/// `POST /v1/public/linear/webhook/{tenant}`: 202 when queued, 204 when the delivery is of no
/// interest, 401 when the signature is not right or the delivery is old, 400 when it is right and
/// the delivery has no usable id, 404 for a workspace that does not exist.
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
    let signature = header("linear-signature").ok_or_else(unauthorized)?;
    let payload: Value = serde_json::from_slice(&body).map_err(|_| unauthorized())?;
    let account = signed_for(&app, &ctx, &payload, &body, signature)
        .await?
        .ok_or_else(unauthorized)?;
    // The timestamp is signed with the rest: an old one is a replay, not a retry.
    if !fresh(&payload, system_now_ms()) {
        return Err(unauthorized());
    }
    // From here on the delivery is Linear's, for this account.
    let Some(delivery) = header("linear-delivery").filter(|d| valid_delivery(d)) else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "the delivery has no usable id",
        ));
    };
    let Some(notice) = translate(&payload) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let job = NewJob::new(
        LINEAR_WEBHOOK_KIND,
        json!({
            "delivery": delivery,
            "account": account.id.as_str(),
            "kind": notice.kind,
            "notice": notice.payload,
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
pub struct LinearWebhookHandler {
    plugins: Arc<Plugins>,
}

impl LinearWebhookHandler {
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
            .plugin_connector_accounts(&tenant, LINEAR_ID)
            .await
            .map_err(|e| retry(&e))?;
        // Deleted since the delivery came: there is nobody to tell.
        let Some(account) = accounts.into_iter().find(|a| a.id.as_str() == account) else {
            return Ok(());
        };
        let notice = &payload["notice"];
        let mut told = 0;
        if let Some(issue) = notice["issueId"].as_str() {
            let linked = db
                .linear_threads_of(&tenant, &account.id, issue)
                .await
                .map_err(|e| retry(&e))?;
            for link in linked {
                let event = AgentEvent {
                    kind: kind.to_owned(),
                    payload: notice.clone(),
                    key: Some(format!("lin:{delivery}:{}", link.thread)),
                };
                told += self
                    .plugins
                    .emit_in_thread(&db, &tenant, &account, (&link.agent, &link.thread), event)
                    .await
                    .map_err(|e| retry(&e))?;
            }
        }
        if told == 0 {
            let event = AgentEvent {
                kind: kind.to_owned(),
                payload: notice.clone(),
                key: Some(format!("lin:{delivery}")),
            };
            self.plugins
                .emit(&db, &tenant, &account, None, event)
                .await
                .map_err(|e| retry(&e))?;
        }
        Ok(())
    }
}

impl JobHandler for LinearWebhookHandler {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.run(context))
    }
}
