//! `GET /v1/usage`: the workspace's limits and what it has used.

use axum::Json;
use axum::extract::State;
use jian_protocol::quotas::UsageView;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, require_admin, tenant_ctx};
use crate::workspace::{failure, now_ms};

/// `GET /v1/usage`: an admin.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<UsageView>, Refusal> {
    require_admin(&principal, "see the workspace's usage")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let limits = app.db.quotas(&ctx).await.map_err(|e| failure(&e))?;
    let used = app
        .db
        .quota_usage(&ctx, now_ms())
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(UsageView {
        max_concurrent_runs: limits.max_concurrent_runs,
        monthly_token_limit: limits.monthly_tokens,
        disk_limit_bytes: limits.disk_bytes,
        concurrent_runs: used.concurrent_runs,
        monthly_tokens: used.monthly_tokens,
        disk_bytes: used.disk_bytes,
    }))
}
