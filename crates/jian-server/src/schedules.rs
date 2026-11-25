//! An agent's schedules and inbox: `/v1/agents/{id}/schedules*` and `/v1/agents/{id}/inbox`.
//!
//! Whoever sees the agent manages its schedules; one who does not gets a 404 for every path. A
//! schedule that has an unsupported time (a past one-shot, a cron more often than every 5
//! minutes, an unknown zone) is a 400. Firing is `schedule_job.rs`, not a route.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_protocol::schedules::{
    CreateScheduleRequest, InboxEventView, InboxPage, ScheduleView, SchedulesPage,
    UpdateScheduleRequest,
};
use jian_store::{InboxEvent, NewSchedule, Schedule, ScheduleId, SchedulePatch, When};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::memories::{seen_agent, seen_thread};
use crate::workspace::{DEFAULT_PAGE, cursor, failure, now_ms, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn view(schedule: Schedule) -> ScheduleView {
    ScheduleView {
        id: schedule.id.to_string(),
        name: schedule.name,
        instruction: schedule.instruction,
        at: schedule.run_at,
        cron: schedule.cron,
        time_zone: schedule.time_zone,
        enabled: schedule.enabled,
        next_run_at: schedule.next_run_at,
        last_run_at: schedule.last_run_at,
        last_error: schedule.last_error,
        thread: schedule.thread_id.map(|t| t.to_string()),
        created_at: schedule.created_at,
    }
}

fn event_view(event: InboxEvent) -> InboxEventView {
    InboxEventView {
        id: event.id,
        kind: event.kind,
        payload: event.payload,
        schedule_id: event.schedule_id.map(|s| s.to_string()),
        due_at: event.due_at,
        created_at: event.created_at,
        consumed_at: event.consumed_at,
    }
}

fn invalid(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

/// `GET /v1/agents/{id}/schedules`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<SchedulesPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let page = app
        .db
        .list_schedules(&ctx, &agent, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(SchedulesPage {
        next_cursor: page.next.map(|n| n.to_string()),
        items: page.items.into_iter().map(view).collect(),
    }))
}

/// `POST /v1/agents/{id}/schedules`.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<CreateScheduleRequest>,
) -> Result<(StatusCode, Json<ScheduleView>), Refusal> {
    let viewer = viewer(&principal)?;
    let when = match (body.at, body.cron) {
        (Some(at), None) => When::Once(
            jian_core::parse_instant_ms(&at)
                .ok_or_else(|| invalid("`at` is not an ISO 8601 time with an offset"))?,
        ),
        (None, Some(cron)) => When::Cron(cron),
        _ => return Err(invalid("give exactly one of `at` and `cron`")),
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let thread = match body.thread {
        Some(thread) => Some(seen_thread(&app, &ctx, &viewer, thread).await?),
        None => None,
    };
    let schedule = app
        .db
        .create_schedule(
            &ctx,
            &viewer.account,
            &agent,
            &NewSchedule {
                name: body.name,
                instruction: body.instruction,
                when,
                time_zone: body.time_zone,
                thread,
            },
            now_ms(),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(view(schedule))))
}

/// `GET /v1/agents/{id}/schedules/{scheduleId}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, schedule)): Path<(String, String)>,
) -> Result<Json<ScheduleView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    app.db
        .schedule(&ctx, &agent, &ScheduleId::new(schedule))
        .await
        .map_err(|e| failure(&e))?
        .map(|s| Json(view(s)))
        .ok_or_else(|| not_found("schedule"))
}

/// `PATCH /v1/agents/{id}/schedules/{scheduleId}`.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, schedule)): Path<(String, String)>,
    Json(body): Json<UpdateScheduleRequest>,
) -> Result<Json<ScheduleView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    app.db
        .update_schedule(
            &ctx,
            &agent,
            &ScheduleId::new(schedule),
            &SchedulePatch {
                name: body.name,
                instruction: body.instruction,
                enabled: body.enabled,
            },
            now_ms(),
        )
        .await
        .map_err(|e| failure(&e))?
        .map(|s| Json(view(s)))
        .ok_or_else(|| not_found("schedule"))
}

/// `DELETE /v1/agents/{id}/schedules/{scheduleId}`.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, schedule)): Path<(String, String)>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let gone = app
        .db
        .delete_schedule(&ctx, &agent, &ScheduleId::new(schedule))
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("schedule"))
    }
}

/// `GET /v1/agents/{id}/inbox`: read-only here; the runtime takes what is in it.
pub(crate) async fn inbox(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<InboxPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let page = app
        .db
        .inbox(&ctx, &agent, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(InboxPage {
        next_cursor: page.next.map(|n| n.to_string()),
        items: page.items.into_iter().map(event_view).collect(),
    }))
}
