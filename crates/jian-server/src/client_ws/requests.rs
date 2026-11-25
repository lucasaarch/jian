//! What each client request does. Every call runs as the principal's own tenant context, which
//! the session got from the token: nothing here reads a tenant from the request.

use jian_protocol::client::{
    ApiError, ClientRequest, ClientResponse, ErrorCode, MAX_PAGE_ITEMS, Page,
};
use jian_protocol::machine::CLOSE_TOKEN_REVOKED;
use jian_store::{DeviceId, MachineId, StoreError, TenantCtx};

use crate::AppState;
use crate::auth::Principal;
use crate::summary::device_summary;

/// How many machines a page holds when the client does not say.
const DEFAULT_PAGE_ITEMS: u32 = 50;

fn refuse(code: ErrorCode, message: &str) -> ApiError {
    ApiError {
        code,
        message: message.to_owned(),
        retry_after_ms: None,
    }
}

fn not_found(what: &str) -> ApiError {
    refuse(ErrorCode::NotFound, &format!("no such {what}"))
}

/// Store failures a client caused are told; the rest are logged and answered with nothing to
/// probe.
fn failed(error: &StoreError) -> ApiError {
    match error {
        StoreError::InvalidName(_) => {
            refuse(ErrorCode::BadRequest, "the name is empty or too long")
        }
        other => {
            tracing::error!(error = %other, "a client request failed");
            refuse(ErrorCode::Internal, "internal error")
        }
    }
}

/// The page cursor is the store's, written as text so the client treats it as opaque.
fn after(cursor: Option<&str>) -> Result<Option<i64>, ApiError> {
    cursor
        .map(|text| {
            text.parse::<i64>().map_err(|_| {
                refuse(
                    ErrorCode::BadRequest,
                    "the cursor is not one this gateway gave",
                )
            })
        })
        .transpose()
}

/// Everything but subscribing, which the session handles because it holds the subscriptions.
pub(super) async fn handle(
    app: &AppState,
    principal: &Principal,
    ctx: &TenantCtx,
    request: ClientRequest,
) -> Result<ClientResponse, ApiError> {
    let tenant = &principal.tenant;
    let owner_only = || {
        if principal.is_admin() {
            Ok(())
        } else {
            Err(refuse(
                ErrorCode::Forbidden,
                "only the owner's token or an admin may do this",
            ))
        }
    };
    match request {
        ClientRequest::ListMachines { cursor, limit } => {
            let limit = limit.unwrap_or(DEFAULT_PAGE_ITEMS).clamp(1, MAX_PAGE_ITEMS);
            let page = app
                .db
                .list_machines(ctx, after(cursor.as_deref())?, limit)
                .await
                .map_err(|error| failed(&error))?;
            Ok(ClientResponse::Machines(Page {
                items: page
                    .items
                    .iter()
                    .map(|machine| app.summarize(tenant, machine))
                    .collect(),
                next_cursor: page.next.map(|next| next.to_string()),
            }))
        }
        ClientRequest::IssueMachine { name } => {
            owner_only()?;
            let (machine, token) = app
                .db
                .issue_machine(ctx, &name)
                .await
                .map_err(|error| failed(&error))?;
            app.publish_machine(tenant, &machine).await;
            Ok(ClientResponse::MachineToken {
                machine: app.summarize(tenant, &machine),
                token: token.expose().to_owned(),
            })
        }
        ClientRequest::RotateMachine { id } => {
            owner_only()?;
            let id = MachineId::new(id.as_str());
            let (machine, token) = app
                .db
                .rotate_machine_token(ctx, &id)
                .await
                .map_err(|error| failed(&error))?
                .ok_or_else(|| not_found("machine"))?;
            // The worker that holds the old token is cut off; the new one has to be given to it.
            app.hub.disconnect(tenant, &id, CLOSE_TOKEN_REVOKED);
            app.publish_machine(tenant, &machine).await;
            Ok(ClientResponse::MachineToken {
                machine: app.summarize(tenant, &machine),
                token: token.expose().to_owned(),
            })
        }
        ClientRequest::RevokeMachine { id } => {
            owner_only()?;
            let id = MachineId::new(id.as_str());
            let machine = app
                .db
                .revoke_machine(ctx, &id)
                .await
                .map_err(|error| failed(&error))?
                .ok_or_else(|| not_found("machine"))?;
            app.hub.disconnect(tenant, &id, CLOSE_TOKEN_REVOKED);
            app.publish_machine(tenant, &machine).await;
            Ok(ClientResponse::Machine(app.summarize(tenant, &machine)))
        }
        ClientRequest::IssueDevice { name } => {
            owner_only()?;
            let (device, token) = app
                .db
                .issue_device(ctx, &name)
                .await
                .map_err(|error| failed(&error))?;
            Ok(ClientResponse::DeviceToken {
                device: device_summary(&device),
                token: token.expose().to_owned(),
            })
        }
        ClientRequest::RotateDevice { id } => {
            owner_only()?;
            let (device, token) = app
                .db
                .rotate_device_token(ctx, &DeviceId::new(id))
                .await
                .map_err(|error| failed(&error))?
                .ok_or_else(|| not_found("device"))?;
            Ok(ClientResponse::DeviceToken {
                device: device_summary(&device),
                token: token.expose().to_owned(),
            })
        }
        ClientRequest::RevokeDevice { id } => {
            owner_only()?;
            let device = app
                .db
                .revoke_device(ctx, &DeviceId::new(id))
                .await
                .map_err(|error| failed(&error))?
                .ok_or_else(|| not_found("device"))?;
            Ok(ClientResponse::Device(device_summary(&device)))
        }
        ClientRequest::Subscribe { .. } | ClientRequest::Unsubscribe { .. } => {
            Err(refuse(ErrorCode::Internal, "internal error"))
        }
    }
}
