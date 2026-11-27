//! Downloads of an artifact's latest version: `GET /v1/artifacts/{id}/export?format=` for a
//! member, and, with `public-url`, `GET /v1/public/artifacts/{token}/export?format=` for whoever
//! its link opens.
//!
//! Who may download is who may read, and nothing else: the member route has the rules of
//! `GET /v1/artifacts/{id}` (an artifact the caller does not see is a 404, whatever the format
//! asked), and the link route reads as the link does (`artifact_public::readable`), so a password
//! the link asks for (401 `password_required`), a link that was replaced (404) and a member
//! without access (404) are the same as when it is opened. Only after that is the format
//! looked at: one the kind does not have is a 400 that says which it has.
//!
//! The files of each kind are [`formats`]. The source ones (`md`, `html`, `tsx`, `mmd`, `json`,
//! `csv`) are the content as written; `xlsx`, `docx` and `pptx` are made here
//! ([`artifact_office`](crate::artifact_office)); `pdf` and `png` are drawn, which takes a
//! browser this gateway may not have: they go through the [`ArtifactRenderer`] in the state, and
//! without one the answer is a 501.
//!
//! The file is an attachment and never a page: `nosniff`, and a policy that runs nothing, so an
//! `html` artifact that an agent wrote cannot run from the gateway's own address if someone
//! opens the download inline.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::future::BoxFuture;
use jian_core::ArtifactKind;
use jian_store::{ArtifactActor, ArtifactId};
use serde::Deserialize;

use crate::AppState;
use crate::artifact_office::{docx, pptx, xlsx};
#[cfg(feature = "public-url")]
use crate::artifact_public::readable;
use crate::auth::Principal;
#[cfg(feature = "public-url")]
use crate::auth::{Address, AuthRejection};
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::workspace::{failure, viewer};

/// A file only a browser can draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderFormat {
    /// A document or a deck, paged.
    Pdf,
    /// A deck's slides as pictures.
    Png,
}

/// What draws `pdf` and `png`: the gateway's browser, when it has one. It is given the kind,
/// title and source of the version to download and answers the file's bytes; any error is logged
/// and told to the caller as a 502, without its text. A public link can ask for a file as often
/// as it is let in, so an implementation holds its own cap on how many it draws at once.
pub trait ArtifactRenderer: Send + Sync {
    /// The file `format` of this version.
    fn render<'a>(
        &'a self,
        kind: ArtifactKind,
        title: &'a str,
        content: &'a str,
        format: RenderFormat,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// The renderer a state may carry.
pub type Renderer = Arc<dyn ArtifactRenderer>;

#[derive(Deserialize)]
pub(crate) struct ExportQuery {
    format: Option<String>,
}

/// The files a kind is downloaded as, as the extension they take.
fn formats(kind: ArtifactKind) -> &'static [&'static str] {
    match kind {
        ArtifactKind::Html => &["html"],
        ArtifactKind::React => &["tsx"],
        ArtifactKind::Markdown => &["md", "docx", "pdf"],
        ArtifactKind::Mermaid => &["mmd"],
        ArtifactKind::Diagram => &["json"],
        ArtifactKind::Deck => &["pptx", "pdf", "png"],
        ArtifactKind::Sheet => &["xlsx", "csv"],
    }
}

/// `asked` if this kind has that file.
fn pick(kind: ArtifactKind, asked: Option<&str>) -> Result<&'static str, Refusal> {
    let has = formats(kind);
    let invalid = |why: String| refuse(StatusCode::BAD_REQUEST, "invalid_input", &why);
    let Some(asked) = asked.filter(|a| !a.is_empty()) else {
        return Err(invalid(format!(
            "say which file with ?format=: a {} is downloaded as {}",
            kind.as_str(),
            has.join(", ")
        )));
    };
    has.iter().find(|f| **f == asked).copied().ok_or_else(|| {
        invalid(format!(
            "a {} is downloaded as {}, not {asked:?}",
            kind.as_str(),
            has.join(", ")
        ))
    })
}

/// A word of `title` is letters and numbers; what is between words becomes one `-`.
fn words(title: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if keep(c) {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(60).collect();
    if out.is_empty() {
        "artifact".to_owned()
    } else {
        out
    }
}

/// How the file is named when saved: the title in words a file system takes, then the extension.
/// `filename` is ASCII for an old client and `filename*` keeps the title's letters (RFC 6266).
/// Nothing else of the title can reach the header: what is left is letters, numbers and dashes,
/// and the second form is percent-encoded.
fn attachment(title: &str, extension: &str) -> String {
    let plain = words(title, |c| c.is_ascii_alphanumeric());
    let unicode: String = words(title, char::is_alphanumeric)
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{plain}.{extension}\"; filename*=UTF-8''{unicode}.{extension}")
}

fn mime(extension: &str) -> &'static str {
    match extension {
        "html" => "text/html; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pdf" => "application/pdf",
        "png" => "image/png",
        _ => "text/plain; charset=utf-8",
    }
}

#[derive(Deserialize)]
struct Deck {
    slides: Vec<String>,
}

fn unreadable() -> Refusal {
    refuse(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unreadable_content",
        "this artifact's content is not what its kind is written as",
    )
}

/// The bytes of `extension`, one the kind has.
async fn bytes(
    app: &AppState,
    kind: ArtifactKind,
    title: &str,
    content: String,
    extension: &str,
) -> Result<Vec<u8>, Refusal> {
    let render = match extension {
        "pdf" => Some(RenderFormat::Pdf),
        "png" => Some(RenderFormat::Png),
        _ => None,
    };
    if let Some(format) = render {
        let Some(renderer) = &app.renderer else {
            return Err(refuse(
                StatusCode::NOT_IMPLEMENTED,
                "render_unavailable",
                "this gateway has no browser to draw PDF or PNG files with",
            ));
        };
        return renderer
            .render(kind, title, &content, format)
            .await
            .map_err(|error| {
                tracing::warn!(%error, "an artifact could not be drawn");
                refuse(
                    StatusCode::BAD_GATEWAY,
                    "render_failed",
                    "the file could not be drawn",
                )
            });
    }
    if !matches!(extension, "xlsx" | "docx" | "pptx") {
        return Ok(content.into_bytes());
    }
    let title = title.to_owned();
    let extension = extension.to_owned();
    // A big source is a lot of XML to write: not on the thread that serves everyone else.
    let made = tokio::task::spawn_blocking(move || match extension.as_str() {
        "xlsx" => Ok(xlsx(&title, &content)),
        "docx" => Ok(docx(&content)),
        _ => serde_json::from_str::<Deck>(&content)
            .map(|deck| pptx(&deck.slides))
            .map_err(|_| unreadable()),
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "writing an Office file stopped");
        refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    })??;
    made.map_err(|error| {
        tracing::error!(%error, "writing an Office file failed");
        refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    })
}

/// The download of this version, as the attachment `extension` is.
async fn file(
    app: &AppState,
    kind: ArtifactKind,
    title: &str,
    content: String,
    asked: Option<&str>,
) -> Result<Response, Refusal> {
    let extension = pick(kind, asked)?;
    let body = bytes(app, kind, title, content, extension).await?;
    let headers: HeaderMap = [
        (CONTENT_TYPE, mime(extension).to_owned()),
        (CONTENT_DISPOSITION, attachment(title, extension)),
        (X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        (
            CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'".to_owned(),
        ),
        (CACHE_CONTROL, "no-store".to_owned()),
    ]
    .into_iter()
    .filter_map(|(name, value)| value.parse().ok().map(|value| (name, value)))
    .collect();
    Ok((headers, body).into_response())
}

/// `GET /v1/artifacts/{id}/export?format=`: for a member who sees the artifact.
pub(crate) async fn export(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ArtifactId::new(id);
    let artifact = app
        .db
        .artifact(&ctx, ArtifactActor::Member(&viewer), &id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    let version = app
        .db
        .artifact_version(&ctx, ArtifactActor::Member(&viewer), &id, None)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    file(
        &app,
        artifact.kind,
        &artifact.title,
        version.content,
        query.format.as_deref(),
    )
    .await
}

/// `GET /v1/public/artifacts/{token}/export?format=`: for whoever the link opens.
#[cfg(feature = "public-url")]
pub(crate) async fn export_public(
    State(app): State<AppState>,
    Address(from): Address,
    principal: Result<Principal, AuthRejection>,
    Path(token): Path<String>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let artifact = readable(&app, &token, &from, &headers, principal).await?;
    file(
        &app,
        artifact.kind,
        &artifact.title,
        artifact.content,
        query.format.as_deref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_cannot_leave_its_header() {
        let name = attachment("Q3 \"plan\"\r\nSet-Cookie: x=1; São Paulo", "md");
        assert!(!name.contains(['\r', '\n']), "{name}");
        assert_eq!(
            name,
            "attachment; filename=\"Q3-plan-Set-Cookie-x-1-S-o-Paulo.md\"; \
             filename*=UTF-8''Q3-plan-Set-Cookie-x-1-S%C3%A3o-Paulo.md"
        );
        assert!(attachment("???", "csv").starts_with("attachment; filename=\"artifact.csv\""));
    }
}
