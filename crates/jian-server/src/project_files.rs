//! The files of a project: `/v1/projects/{id}/files*`.
//!
//! An upload is the raw body of a `POST`, named by `?name=` and typed by `Content-Type`; no
//! multipart, so what the gateway reads is exactly the bytes. It is held in memory up to the
//! store's limit and no further: a larger body is refused with a 413 before it is all read. The
//! gateway computes the SHA-256 and the size itself.
//!
//! A download is always an attachment, never shown by the browser, with `nosniff` and a sandbox
//! policy: a member's HTML file is data here, not a page of the gateway's origin.

use std::fmt::Write as _;

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jian_protocol::projects::{ProjectFileView, ProjectFiles};
use jian_store::{MAX_PROJECT_FILE_BYTES, ProjectFileId, ProjectId, StoreError};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, internal, not_found, refuse, tenant_ctx};
use crate::project_events::{announce_file, file_view};
use crate::workspace::{failure, viewer};

/// How many bytes the body of an upload may have: the file's limit.
pub(crate) const MAX_UPLOAD_BODY: usize = MAX_PROJECT_FILE_BYTES as usize;

#[derive(Deserialize)]
pub(crate) struct UploadQuery {
    name: Option<String>,
}

/// `GET /v1/projects/{id}/files`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ProjectFiles>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let files = app
        .db
        .list_project_files(&ctx, &viewer, &ProjectId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    Ok(Json(ProjectFiles {
        items: files.iter().map(file_view).collect(),
    }))
}

/// `POST /v1/projects/{id}/files?name=`: the project's creator or an admin.
pub(crate) async fn upload(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<ProjectFileView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let name = query.name.unwrap_or_default();
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    // `+ 1`: a body of exactly the limit is fine, one byte more is not.
    let bytes = to_bytes(body, MAX_UPLOAD_BODY + 1).await.map_err(|_| {
        failure(&StoreError::FileTooLarge {
            max: MAX_PROJECT_FILE_BYTES,
        })
    })?;
    let file = app
        .db
        .add_project_file(&ctx, &viewer, &ProjectId::new(id), &name, mime, &bytes)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    announce_file(&app, &ctx, &file, true).await;
    Ok((StatusCode::CREATED, Json(file_view(&file))))
}

/// `GET /v1/projects/{id}/files/{file_id}`: the bytes, as a download.
pub(crate) async fn download(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, file_id)): Path<(String, String)>,
) -> Result<Response, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (file, bytes) = app
        .db
        .read_project_file(
            &ctx,
            &viewer,
            &ProjectId::new(id),
            &ProjectFileId::new(file_id),
        )
        .await
        .map_err(|error| {
            if jian_store::Database::is_missing_blob(&error) {
                refuse(
                    StatusCode::NOT_FOUND,
                    "file_bytes_missing",
                    "the bytes of this file are gone",
                )
            } else {
                failure(&error)
            }
        })?
        .ok_or_else(|| not_found("file"))?;
    let disposition = disposition(&file.name);
    let (Ok(mime), Ok(disposition)) = (
        HeaderValue::from_str(&file.mime),
        HeaderValue::from_str(&disposition),
    ) else {
        return Err(internal(&StoreError::InvalidWorkspace(
            "a stored file has a header that cannot be sent",
        )));
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, disposition),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// `DELETE /v1/projects/{id}/files/{file_id}`: the project's creator or an admin.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, file_id)): Path<(String, String)>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let project = ProjectId::new(id);
    let file_id = ProjectFileId::new(file_id);
    // Read first: the event says which file went, and the row is gone after.
    let files = app
        .db
        .list_project_files(&ctx, &viewer, &project)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    let gone = files.into_iter().find(|f| f.id == file_id);
    let removed = app
        .db
        .delete_project_file(&ctx, &viewer, &project, &file_id)
        .await
        .map_err(|e| failure(&e))?;
    match (removed, gone) {
        (true, Some(file)) => announce_file(&app, &ctx, &file, false).await,
        (false, _) => return Err(not_found("file")),
        (true, None) => {}
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `attachment; filename="…"; filename*=UTF-8''…`: an ASCII fallback with nothing that can end
/// the quotes, and the real name percent-encoded.
fn disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::disposition;

    #[test]
    fn a_file_name_cannot_break_out_of_the_header() {
        let header = disposition("a\"b\r\nX: y é.txt");
        assert!(!header.contains('\r') && !header.contains('\n'));
        assert!(header.starts_with("attachment; filename=\"a_b__X_ y _.txt\""));
        assert!(header.ends_with("filename*=UTF-8''a%22b%0D%0AX%3A%20y%20%C3%A9.txt"));
    }
}
