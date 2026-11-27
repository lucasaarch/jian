//! Asking an agent to review a pull request: `POST /v1/github/reviews`, and the same step the
//! webhook's job takes when a pull request is opened or pushed to.
//!
//! A review request is an event in the agent's inbox (see `jian_plugin_github::review`). The
//! store's `github_reviews` table lets one head commit be asked for once, whoever asks and
//! however often: this route and the webhook share [`ask`], so a person asking for a pull
//! request the webhook already sent is told nothing new was sent. A claim whose event could not
//! be written is given back, so the retry asks again instead of finding the work done.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_plugin_api::AgentEvent;
use jian_plugin_github::KIND_INSTALLATION;
use jian_plugin_github::review::{REVIEW_KIND, request};
use jian_protocol::github::{GithubReviewRequest, GithubReviewView};
use jian_store::{AgentId, ConnectorAccount, ConnectorAccountId, Database, TenantCtx};

use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::plugins::Plugins;
use crate::workspace::{failure, viewer};

/// What [`ask`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Asked {
    /// The request is in the agent's inbox.
    Sent,
    /// This commit had been asked for already: nothing was written.
    Already,
    /// The agent does not reach the account: nothing was asked, and the claim was given back.
    NotReached,
}

/// Asks `agent` to review `repo`#`number` at `head_sha`, once.
///
/// # Errors
///
/// A sentence with no secret in it; the claim is given back, so asking again works.
pub(crate) async fn ask(
    plugins: &Plugins,
    db: &Database,
    ctx: &TenantCtx,
    account: &ConnectorAccount,
    agent: &AgentId,
    (repo, number, head_sha): (&str, u64, &str),
) -> Result<Asked, String> {
    // Made before the claim: a request that cannot be made must not use the commit up.
    let payload = request(&account.name, repo, number, head_sha).map_err(|e| e.to_string())?;
    let fresh = db
        .claim_github_review(ctx, &account.id, agent, repo, number, head_sha)
        .await
        .map_err(|e| e.to_string())?;
    if !fresh {
        return Ok(Asked::Already);
    }
    let event = AgentEvent {
        kind: REVIEW_KIND.to_owned(),
        payload,
        key: Some(format!(
            "review:{}#{number}@{head_sha}",
            repo.to_ascii_lowercase()
        )),
    };
    let written = plugins.emit(db, ctx, account, Some(agent), event).await;
    match written {
        Ok(written) if written > 0 => Ok(Asked::Sent),
        other => {
            give_back(db, ctx, &account.id, (repo, number, head_sha)).await;
            match other {
                Ok(_) => Ok(Asked::NotReached),
                Err(error) => Err(error.to_string()),
            }
        }
    }
}

async fn give_back(
    db: &Database,
    ctx: &TenantCtx,
    account: &ConnectorAccountId,
    (repo, number, head_sha): (&str, u64, &str),
) {
    if let Err(error) = db
        .release_github_review(ctx, account, repo, number, head_sha)
        .await
    {
        tracing::warn!(%error, "could not give back a review claim; the commit will not be asked again");
    }
}

fn bad(code: &str, why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, code, why)
}

/// `POST /v1/github/reviews`: any member who sees the installation and the agent asks for a
/// review of an open pull request. 404 for an installation or agent they do not see; 400 when
/// the pull request is not open or the agent does not reach the installation; 502 when GitHub
/// cannot be asked.
pub(crate) async fn create(
    State(app): State<crate::AppState>,
    principal: Principal,
    Json(body): Json<GithubReviewRequest>,
) -> Result<Json<GithubReviewView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .connector_account(&ctx, &viewer, &ConnectorAccountId::new(&body.account_id))
        .await
        .map_err(|e| failure(&e))?
        .filter(|account| account.kind == KIND_INSTALLATION)
        .ok_or_else(|| not_found("installation"))?;
    let agent = AgentId::new(&body.agent_id);
    app.db
        .agent(&ctx, &viewer, &agent)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    let head_sha = app
        .plugins
        .github_head(&app.db, &ctx, &account, &body.repo, body.number)
        .await
        .map_err(|why| {
            refuse(
                StatusCode::BAD_GATEWAY,
                "github_unavailable",
                &format!("could not read the pull request: {why}"),
            )
        })?;
    let target = (body.repo.as_str(), body.number, head_sha.as_str());
    match ask(&app.plugins, &app.db, &ctx, &account, &agent, target).await {
        Ok(Asked::NotReached) => Err(bad(
            "agent_not_reached",
            "that agent does not reach this installation",
        )),
        Ok(asked) => Ok(Json(GithubReviewView {
            head_sha,
            asked: asked == Asked::Sent,
        })),
        Err(why) => Err(bad("invalid_input", &why)),
    }
}
