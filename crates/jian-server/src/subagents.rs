//! Subagents of a thread: `/v1/threads/{id}/subagents*`, and the report that goes back to the
//! thread that asked when a subagent's run ends.
//!
//! Whoever sees the thread reads its subagents; a member of the thread stops one. Anyone who
//! does not see the thread gets 404 and a viewer who only sees it gets 403 on a stop, so a
//! thread's subagents say nothing of themselves to people outside it. The child thread is an
//! ordinary thread that the same people see, so its own runs and messages are read there.
//!
//! [`report_back`] is the one place a subagent ends. Every way its run can end calls it (the
//! worker that ran it, a stop that ended it at once, a job that finds it ended), and the store
//! lets only the first win, so the report goes back once however the calls race.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_core::{MessageParts, cap_tool_result};
use jian_protocol::client::DeltaPayload;
use jian_protocol::subagents::{SubagentStateView, SubagentView, SubagentsPage};
use jian_runtime::queue_resume;
use jian_store::{
    Database, Run, RunOrigin, RunState, StoreError, Subagent, SubagentState, TenantCtx, ThreadId,
};

use crate::AppState;
use crate::auth::Principal;
use crate::events::EventBus;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::runs::member;
use crate::workspace::{announce_with, failure, message_view, viewer};

/// How much of the brief the message that carries the report quotes, in characters.
const BRIEF_QUOTE_CHARS: usize = 100;

fn state_view(state: SubagentState) -> SubagentStateView {
    match state {
        SubagentState::Running => SubagentStateView::Running,
        SubagentState::Done => SubagentStateView::Done,
        SubagentState::Failed => SubagentStateView::Failed,
        SubagentState::Stopped => SubagentStateView::Stopped,
    }
}

pub(crate) fn subagent_view(sub: &Subagent) -> SubagentView {
    SubagentView {
        thread_id: sub.child_thread.to_string(),
        parent_thread_id: sub.parent_thread.to_string(),
        parent_run_id: sub.parent_run.clone(),
        run_id: sub.child_run.clone(),
        agent_id: sub.agent.to_string(),
        brief: sub.brief.clone(),
        depth: sub.depth,
        wait: sub.wait,
        state: state_view(sub.state),
        report: sub.report.clone(),
        created_at: sub.created_at.clone(),
        finished_at: sub.finished_at.clone(),
    }
}

/// `GET /v1/threads/{id}/subagents`: the subagents the thread asked for, newest first.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<SubagentsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    app.db
        .can_use_thread(&ctx, &viewer, &thread)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let items = app
        .db
        .list_subagents(&ctx, &thread)
        .await
        .map_err(|e| failure(&e))?
        .iter()
        .map(subagent_view)
        .collect();
    Ok(Json(SubagentsPage { items }))
}

/// `POST /v1/threads/{id}/subagents/{child_id}/stop`: stops the subagent whose thread is
/// `child_id`; its report (that it was stopped) goes back to the thread. 409 when it has ended.
pub(crate) async fn stop(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, child)): Path<(String, String)>,
) -> Result<Json<SubagentView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread).await?;
    let child = ThreadId::new(child);
    let sub = app
        .db
        .subagent_of_thread(&ctx, &child)
        .await
        .map_err(|e| failure(&e))?
        .filter(|sub| sub.parent_thread == thread)
        .ok_or_else(|| not_found("subagent"))?;
    if sub.state != SubagentState::Running {
        return Err(refuse(
            StatusCode::CONFLICT,
            "conflict",
            "the subagent has already ended",
        ));
    }
    let run = app
        .db
        .request_run_stop(&ctx, &child, &sub.child_run)
        .await
        .map_err(|e| failure(&e))?;
    if let Some(run) = run.filter(|run| run.state.is_terminal()) {
        // Queued or parked: no worker holds it to say so.
        report_back(&app.db, app.events.as_ref(), &ctx, &run).await;
    }
    let current = app
        .db
        .subagent_of_thread(&ctx, &child)
        .await
        .map_err(|e| failure(&e))?
        .unwrap_or(sub);
    Ok(Json(subagent_view(&current)))
}

/// Called when `run` is over, whichever way it ended: if it was a subagent's run, ends the
/// subagent and takes its report back to the thread that asked. Does nothing for another run,
/// for one that is not over, or for a subagent that already reported. Errors are logged: the
/// run is over and cannot fail again.
pub(crate) async fn report_back(db: &Database, events: &dyn EventBus, ctx: &TenantCtx, run: &Run) {
    if run.origin != RunOrigin::Subagent {
        return;
    }
    if let Err(error) = deliver(db, events, ctx, run).await {
        tracing::warn!(%error, "could not take a subagent's report back to its parent");
    }
}

async fn deliver(
    db: &Database,
    events: &dyn EventBus,
    ctx: &TenantCtx,
    run: &Run,
) -> Result<(), StoreError> {
    // The caller's copy may be older than the end.
    let Some(over) = db.run_by_id(ctx, &run.id).await? else {
        return Ok(());
    };
    let (state, report) = match over.state {
        RunState::Done => (
            SubagentState::Done,
            db.final_answer(ctx, &run.thread, &run.agent)
                .await?
                .unwrap_or_else(|| "the subagent ended without an answer".to_owned()),
        ),
        RunState::Failed => (
            SubagentState::Failed,
            format!(
                "the subagent failed: {}",
                over.error.as_deref().unwrap_or("it ended on an error")
            ),
        ),
        RunState::Stopped => (
            SubagentState::Stopped,
            "the subagent was stopped".to_owned(),
        ),
        RunState::Queued | RunState::Running | RunState::WaitingApproval => return Ok(()),
    };
    // A report is a tool result or a message: both are held to the same size.
    let (report, _) = cap_tool_result(&report);
    let Some(sub) = db.end_subagent(ctx, &run.id, state, &report).await? else {
        return Ok(());
    };
    let payload = DeltaPayload::SubagentUpdated(subagent_view(&sub));
    announce_with(db, events, ctx, &sub.parent_thread, None, payload).await;

    let parent_alive = db
        .run_by_id(ctx, &sub.parent_run)
        .await?
        .is_some_and(|parent| !parent.state.is_terminal());
    if sub.wait && parent_alive {
        // The run takes the report as the result of its call. If it is not parked on the call
        // yet, it checks for the report when it parks: nothing is lost either way.
        if db
            .run_waits_on(ctx, &sub.parent_run, &sub.parent_call)
            .await?
        {
            queue_resume(db, ctx, &sub.parent_run, &sub.parent_call, "child").await?;
        }
        return Ok(());
    }
    let quote: String = sub
        .brief
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(BRIEF_QUOTE_CHARS)
        .collect();
    let text = if state == SubagentState::Done {
        format!(
            "Report from the subagent in conversation {} (task: {quote}):\n\n{report}",
            sub.child_thread
        )
    } else {
        format!(
            "The subagent in conversation {} (task: {quote}) ended: {report}",
            sub.child_thread
        )
    };
    let Ok(parts) = MessageParts::text(&text) else {
        return Ok(());
    };
    let key = format!("subagent:{}", sub.child_thread);
    if let Some(posted) = db
        .post_system_message(ctx, &sub.parent_thread, parts, Some(key))
        .await?
        && posted.created
    {
        let payload = DeltaPayload::MessageCreated(message_view(&posted.message));
        announce_with(db, events, ctx, &sub.parent_thread, None, payload).await;
    }
    Ok(())
}
