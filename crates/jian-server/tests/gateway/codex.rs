//! A ChatGPT (Codex) account through the gateway: the sign-in's start and end, the refresh when
//! several calls find the token ended together, and a refresh token OpenAI refuses. OpenAI is a
//! fake server here; nothing leaves the machine.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_protocol::providers::{CodexLoginStarted, ModelCatalog, ProviderAccountSummary};
use jian_store::SlotOptions;
use jian_testkit::TwoTenants;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::accounts::open_settings;
use super::support::{Gateway, http_get, http_post, no_network};

const REFRESH_TOKEN: &str = "rt-WORKSPACE-A-SECRET";

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A token shaped like ChatGPT's, ending `seconds_left` from now (negative: already ended).
fn jwt(seconds_left: i64, tag: &str) -> String {
    let claims = json!({
        "exp": unix_now().saturating_add_signed(seconds_left),
        "tag": tag,
        "https://api.openai.com/auth": { "chatgpt_account_id": "acct-fake" },
    });
    format!(
        "e30.{}.sig",
        URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes())
    )
}

/// What the fake OpenAI does and has seen.
struct Openai {
    /// The access token a code's exchange gives: how long it lives.
    first_token_lives: i64,
    /// Whether a refresh is refused.
    refuse_refresh: AtomicBool,
    refreshes: AtomicUsize,
    /// The `code_verifier` of the last exchange.
    verifier: Mutex<Option<String>>,
}

type Shared = Arc<Openai>;

async fn token(State(openai): State<Shared>, body: Bytes) -> Response {
    let form: Vec<(String, String)> = url::form_urlencoded::parse(&body).into_owned().collect();
    let field = |name: &str| {
        form.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    match field("grant_type").as_deref() {
        Some("authorization_code") => {
            *openai.verifier.lock().unwrap() = field("code_verifier");
            axum::Json(json!({
                "access_token": jwt(openai.first_token_lives, "first"),
                "refresh_token": REFRESH_TOKEN,
            }))
            .into_response()
        }
        Some("refresh_token") => {
            openai.refreshes.fetch_add(1, Ordering::SeqCst);
            // A token request takes time; without the vault's lock every caller would make one.
            tokio::time::sleep(Duration::from_millis(150)).await;
            if openai.refuse_refresh.load(Ordering::SeqCst) {
                return (StatusCode::BAD_REQUEST, "{\"error\":\"invalid_grant\"}").into_response();
            }
            axum::Json(json!({ "access_token": jwt(3600, "refreshed") })).into_response()
        }
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn models(headers: HeaderMap) -> Response {
    if headers.get("chatgpt-account-id").is_none() {
        return axum::Json(json!({ "models": [] })).into_response();
    }
    axum::Json(json!({ "models": [
        { "slug": "gpt-6.2-astra", "display_name": "GPT-6.2 Astra", "priority": 1 },
        { "slug": "gpt-6-luna", "priority": 2 },
    ] }))
    .into_response()
}

async fn fake_openai(first_token_lives: i64) -> (String, Shared) {
    let openai = Arc::new(Openai {
        first_token_lives,
        refuse_refresh: AtomicBool::new(false),
        refreshes: AtomicUsize::new(0),
        verifier: Mutex::new(None),
    });
    let app = Router::new()
        .route("/oauth/token", post(token))
        .route("/models", get(models))
        .with_state(openai.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), openai)
}

async fn gateway_for(fake: &str) -> (Gateway, TwoTenants) {
    let llm = jian_server::LlmAccess {
        codex_auth_origin: fake.to_owned(),
        ..no_network()
    };
    let gateway = Gateway::start_with_llm(open_settings(), SlotOptions::default(), llm).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    (gateway, tenants)
}

fn query(url: &str, name: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

async fn start_login(gateway: &Gateway, session: &str) -> CodexLoginStarted {
    let (status, text) = http_post(
        gateway.addr,
        "/v1/providers/codex/start",
        Some(session),
        &json!({}),
    )
    .await;
    assert_eq!(status, 200, "{text}");
    serde_json::from_str(&text).unwrap()
}

/// Signs in as `session` and returns the new account.
async fn sign_in(gateway: &Gateway, session: &str, fake: &str) -> ProviderAccountSummary {
    let started = start_login(gateway, session).await;
    let body = json!({ "state": started.state, "code": "the-code", "baseUrl": fake });
    let (status, text) = http_post(
        gateway.addr,
        "/v1/providers/codex/complete",
        Some(session),
        &body,
    )
    .await;
    assert_eq!(status, 201, "{text}");
    serde_json::from_str(&text).unwrap()
}

async fn catalog(gateway: &Gateway, session: &str) -> ModelCatalog {
    let (status, text) = http_get(gateway.addr, "/v1/providers/models", Some(session)).await;
    assert_eq!(status, 200, "{text}");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn a_chatgpt_sign_in_belongs_to_the_workspace_that_started_it() {
    let (fake, openai) = fake_openai(3600).await;
    let (gateway, tenants) = gateway_for(&fake).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let complete = |session: Option<&str>, body: Value| {
        let addr = gateway.addr;
        let session = session.map(str::to_owned);
        async move {
            http_post(
                addr,
                "/v1/providers/codex/complete",
                session.as_deref(),
                &body,
            )
            .await
        }
    };

    // Admin only: a member and a caller with no token get nothing.
    for token in [Some(a.member_session.as_str()), None] {
        let (status, _) =
            http_post(gateway.addr, "/v1/providers/codex/start", token, &json!({})).await;
        assert!(matches!(status, 401 | 403), "{status}");
        let (status, _) = complete(token, json!({ "state": "x", "code": "y" })).await;
        assert!(matches!(status, 401 | 403), "{status}");
    }

    // The page asks for a PKCE challenge, and the verifier never leaves the gateway.
    let started = start_login(&gateway, &a.admin_session).await;
    assert_eq!(query(&started.authorize_url, "state"), started.state);
    assert_eq!(
        query(&started.authorize_url, "code_challenge_method"),
        "S256"
    );

    // B holds A's state and a good code, and gets the answer of a state that never was.
    let (status, theirs) = complete(
        Some(&b.admin_session),
        json!({ "state": started.state, "code": "c" }),
    )
    .await;
    assert_eq!(status, 400, "{theirs}");
    let (status, never) = complete(
        Some(&b.admin_session),
        json!({ "state": "nothing", "code": "c" }),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(theirs, never);
    assert!(
        openai.verifier.lock().unwrap().is_none(),
        "B reached OpenAI"
    );

    // An address that belongs to another sign-in is refused, and the state is spent either way.
    let landed = "http://localhost:1455/auth/callback?code=c&state=another";
    let (status, _) = complete(
        Some(&a.admin_session),
        json!({ "state": started.state, "code": landed }),
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = complete(
        Some(&a.admin_session),
        json!({ "state": started.state, "code": "c" }),
    )
    .await;
    assert_eq!(status, 400);

    // A new sign-in finishes with the address the browser landed on, and OpenAI was asked with
    // the verifier whose hash the page carried.
    let started = start_login(&gateway, &a.admin_session).await;
    let landed = format!(
        "http://localhost:1455/auth/callback?code=the-code&state={}",
        started.state
    );
    let body = json!({ "state": started.state, "code": landed, "baseUrl": fake });
    let (status, text) = complete(Some(&a.admin_session), body).await;
    assert_eq!(status, 201, "{text}");
    assert!(
        !text.contains(REFRESH_TOKEN) && !text.contains("e30."),
        "{text}"
    );
    let made: ProviderAccountSummary = serde_json::from_str(&text).unwrap();
    assert_eq!(
        (made.provider.as_str(), made.mode.as_str()),
        ("openai", "subscription")
    );
    assert!(made.has_key && !made.active);
    let verifier = openai.verifier.lock().unwrap().clone().unwrap();
    assert_eq!(
        query(&started.authorize_url, "code_challenge"),
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    );

    // One try per state.
    let (status, _) = complete(
        Some(&a.admin_session),
        json!({ "state": started.state, "code": "the-code" }),
    )
    .await;
    assert_eq!(status, 400);

    // B sees nothing of the account and its models.
    let (status, text) = http_get(gateway.addr, "/v1/providers", Some(&b.admin_session)).await;
    assert_eq!(status, 200);
    assert!(!text.contains(&made.id), "{text}");
    assert!(
        catalog(&gateway, &b.admin_session)
            .await
            .accounts
            .is_empty()
    );
    gateway.stop().await;
}

#[tokio::test]
async fn calls_that_find_the_token_ended_together_make_one_refresh() {
    // The first token is already over: the first call to the account must renew it.
    let (fake, openai) = fake_openai(-60).await;
    let (gateway, tenants) = gateway_for(&fake).await;
    let a = &tenants.a;
    let account = sign_in(&gateway, &a.admin_session, &fake).await;

    let (one, two, three, four) = tokio::join!(
        catalog(&gateway, &a.admin_session),
        catalog(&gateway, &a.admin_session),
        catalog(&gateway, &a.admin_session),
        catalog(&gateway, &a.admin_session),
    );
    for seen in [one, two, three, four] {
        assert_eq!(seen.accounts.len(), 1);
        let listed = &seen.accounts[0];
        assert_eq!(listed.account_id, account.id);
        assert!(listed.error.is_none(), "{:?}", listed.error);
        let ids: Vec<&str> = listed.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6.2-astra", "gpt-6-luna"]);
    }
    assert_eq!(openai.refreshes.load(Ordering::SeqCst), 1);
    gateway.stop().await;
}

#[tokio::test]
async fn a_refused_refresh_token_asks_for_a_new_sign_in_and_is_not_asked_again() {
    let (fake, openai) = fake_openai(-60).await;
    openai.refuse_refresh.store(true, Ordering::SeqCst);
    let (gateway, tenants) = gateway_for(&fake).await;
    let a = &tenants.a;
    sign_in(&gateway, &a.admin_session, &fake).await;

    // The error says what to do and shows no token; a second call does not ask OpenAI again.
    for _ in 0..2 {
        let (status, text) =
            http_get(gateway.addr, "/v1/providers/models", Some(&a.admin_session)).await;
        assert_eq!(status, 200, "{text}");
        assert!(
            !text.contains(REFRESH_TOKEN) && !text.contains("e30."),
            "{text}"
        );
        let seen: ModelCatalog = serde_json::from_str(&text).unwrap();
        let error = seen.accounts[0].error.clone().unwrap();
        assert!(error.contains("sign in again"), "{error}");
        assert!(seen.accounts[0].models.is_empty());
    }
    assert_eq!(openai.refreshes.load(Ordering::SeqCst), 1);
    gateway.stop().await;
}
