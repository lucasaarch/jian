//! Messages of a thread: `/v1/threads/{id}/messages`.
//!
//! Anyone who sees a thread reads it; only members in it write, and only the author edits or
//! deletes their message. Posting as an agent has no route: the agent loop calls the store.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_core::{MessagePart, MessageParts};
use jian_protocol::client::DeltaPayload;
use jian_protocol::threads::{
    EditMessageRequest, MessagePartView, MessageView, MessagesPage, PostMessageRequest,
};
use jian_store::{MessageId, NewMessage, ThreadId, Window};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::workspace::{
    DEFAULT_PAGE, announce, announce_thread, failure, message_view, number, viewer,
};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    before: Option<String>,
    after: Option<String>,
    limit: Option<u32>,
}

/// Parts a client may send: text only. `legacy` parts are what the import keeps; tool parts are
/// written by a run.
fn parts(views: Vec<MessagePartView>) -> Result<MessageParts, Refusal> {
    let list = views
        .into_iter()
        .map(|view| match view {
            MessagePartView::Text { text } => Ok(MessagePart::Text(text)),
            MessagePartView::Legacy { .. }
            | MessagePartView::ToolCall { .. }
            | MessagePartView::ToolResult { .. } => Err("only text parts can be sent"),
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(bad)?;
    MessageParts::new(list).map_err(|e| bad(&e.to_string()))
}

fn bad(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

/// `GET /v1/threads/{id}/messages`: the newest, or those `before` or `after` a `seq`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<MessagesPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let window = match (
        number(query.before.as_deref(), "before")?,
        number(query.after.as_deref(), "after")?,
    ) {
        (None, None) => Window::Latest,
        (Some(seq), None) => Window::Before(seq),
        (None, Some(seq)) => Window::After(seq),
        (Some(_), Some(_)) => return Err(bad("give before or after, not both")),
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_messages(
            &ctx,
            &viewer,
            &ThreadId::new(id),
            window,
            query.limit.unwrap_or(DEFAULT_PAGE),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    Ok(Json(MessagesPage {
        items: page.items.iter().map(message_view).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `POST /v1/threads/{id}/messages`: 201 for a new message, 200 with the earlier one when the
/// `clientKey` was already used.
pub(crate) async fn post(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<PostMessageRequest>,
) -> Result<(StatusCode, Json<MessageView>), Refusal> {
    let viewer = viewer(&principal)?;
    let new = NewMessage {
        parts: parts(body.parts)?,
        reply_to: body.reply_to.map(MessageId::new),
        client_key: body.client_key,
    };
    let thread = ThreadId::new(id);
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let posted = app
        .db
        .post_message(&ctx, &viewer, &thread, new)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let view = message_view(&posted.message);
    if !posted.created {
        return Ok((StatusCode::OK, Json(view)));
    }
    announce(
        &app,
        &ctx,
        &thread,
        None,
        DeltaPayload::MessageCreated(view.clone()),
    )
    .await;
    announce_thread(&app, &ctx, &viewer, &thread).await;
    Ok((StatusCode::CREATED, Json(view)))
}

/// `PATCH /v1/threads/{id}/messages/{message_id}`: the author edits.
pub(crate) async fn edit(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, message)): Path<(String, String)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<MessageView>, Refusal> {
    let viewer = viewer(&principal)?;
    let parts = parts(body.parts)?;
    let thread = ThreadId::new(id);
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let changed = app
        .db
        .edit_message(&ctx, &viewer, &thread, &MessageId::new(message), &parts)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("message"))?;
    let view = message_view(&changed);
    announce(
        &app,
        &ctx,
        &thread,
        None,
        DeltaPayload::MessageUpdated(view.clone()),
    )
    .await;
    Ok(Json(view))
}

/// `DELETE /v1/threads/{id}/messages/{message_id}`: the author deletes; the place stays.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, message)): Path<(String, String)>,
) -> Result<Json<MessageView>, Refusal> {
    let viewer = viewer(&principal)?;
    let thread = ThreadId::new(id);
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let changed = app
        .db
        .delete_message(&ctx, &viewer, &thread, &MessageId::new(message))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("message"))?;
    let view = message_view(&changed);
    announce(
        &app,
        &ctx,
        &thread,
        None,
        DeltaPayload::MessageUpdated(view.clone()),
    )
    .await;
    Ok(Json(view))
}
