use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Request};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use include_dir::{Dir, include_dir};

use crate::AppState;

static PANEL_ASSETS: Dir<'_> =
    include_dir!("$CARGO_MANIFEST_DIR/../../apps/desktop-tauri/dist/web");

pub(crate) fn router() -> Router<AppState> {
    Router::<AppState>::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(asset))
        .fallback(fallback)
}

async fn index() -> Response {
    serve("index.html", false)
}

async fn asset(Path(path): Path<String>) -> Response {
    serve(&format!("assets/{path}"), true)
}

async fn fallback(request: Request) -> Response {
    let path = request.uri().path();
    if request.method() != Method::GET || is_reserved_path(path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve("index.html", false)
}

fn is_reserved_path(path: &str) -> bool {
    path == "/health"
        || path == "/v1"
        || path.starts_with("/v1/")
        || path == "/assets"
        || path.starts_with("/assets/")
        || path
            .rsplit('/')
            .next()
            .is_some_and(|segment| segment.contains('.'))
}

fn serve(path: &str, immutable: bool) -> Response {
    let Some(file) = PANEL_ASSETS.get_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut response = Response::new(Body::from(file.contents().to_vec()));
    if let Ok(content_type) =
        HeaderValue::from_str(mime_guess::from_path(path).first_or_octet_stream().as_ref())
    {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}
