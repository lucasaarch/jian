//! Signing in with GitHub and with an e-mailed link: who gets in, what a refusal gives away, and
//! that a state or a link works once. GitHub is a fake server on loopback that checks what the
//! real one would (the client secret, the redirect, the PKCE verifier against its challenge) and
//! the mailer is a recorder, so nothing here leaves the machine.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_auth::{Auth, AuthPolicy, CredentialKind, GithubApp, PasswordParams};
use jian_mail::Mailbox;
use jian_protocol::auth::{
    AuthorizeUrlResponse, ErrorBody, GithubAccount, GithubStatus, LoginResponse, MagicLinkAccepted,
    Me,
};
use jian_server::{
    DeployMail, JobRegistry, LOGIN_LINK_SEND_KIND, Limit, LoginLinkSender, MailConfig, PublicUrl,
    Settings,
};
use jian_store::secrets::Secret;
use jian_testkit::PASSWORD;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::net::TcpListener;

use super::accounts::{open_settings, start};
use super::invites::Outbox;
use super::support::{Gateway, http_get, http_post, http_request, stop};

const CLIENT_ID: &str = "client-1";
const CLIENT_SECRET: &str = "test-secret-value";
const REDIRECT: &str = "https://jian.example.test/login/github";
const ALL: [CredentialKind; 3] = [
    CredentialKind::Password,
    CredentialKind::Github,
    CredentialKind::EmailLink,
];

struct Grant {
    challenge: String,
    user: u64,
}

struct Person {
    login: String,
    emails: Vec<(String, bool)>,
}

#[derive(Default)]
struct Inner {
    codes: HashMap<String, Grant>,
    people: HashMap<u64, Person>,
    tokens: HashMap<String, u64>,
    issued: u32,
}

type Shared = Arc<Mutex<Inner>>;

/// GitHub, as far as signing in goes. A code works once; a token is only what it handed out.
struct FakeGithub {
    url: String,
    inner: Shared,
}

fn challenge_of(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

async fn token(State(inner): State<Shared>, body: String) -> Json<Value> {
    let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    let mut inner = inner.lock().unwrap();
    let right = |key: &str, want: &str| form.get(key).map(String::as_str) == Some(want);
    let known = right("client_id", CLIENT_ID)
        && right("client_secret", CLIENT_SECRET)
        && right("redirect_uri", REDIRECT);
    // Removed whatever the outcome: a code is spent by being tried.
    let grant = form.get("code").and_then(|code| inner.codes.remove(code));
    match grant {
        Some(grant)
            if known
                && form
                    .get("code_verifier")
                    .is_some_and(|v| challenge_of(v) == grant.challenge) =>
        {
            inner.issued += 1;
            let token = format!("gho_fake_{}", inner.issued);
            inner.tokens.insert(token.clone(), grant.user);
            Json(json!({ "access_token": token, "token_type": "bearer" }))
        }
        _ => Json(json!({ "error": "bad_verification_code" })),
    }
}

fn who(inner: &Inner, headers: &HeaderMap) -> Option<u64> {
    let value = headers.get("authorization")?.to_str().ok()?;
    inner.tokens.get(value.strip_prefix("Bearer ")?).copied()
}

async fn user(State(inner): State<Shared>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    let inner = inner.lock().unwrap();
    let id = who(&inner, &headers).ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(json!({ "id": id, "login": inner.people[&id].login })))
}

async fn emails(
    State(inner): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let inner = inner.lock().unwrap();
    let id = who(&inner, &headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let list: Vec<Value> = inner.people[&id]
        .emails
        .iter()
        .map(|(email, verified)| json!({ "email": email, "verified": verified, "primary": false }))
        .collect();
    Ok(Json(Value::Array(list)))
}

impl FakeGithub {
    async fn start() -> Self {
        let inner = Shared::default();
        let app = Router::new()
            .route("/login/oauth/access_token", post(token))
            .route("/user", get(user))
            .route("/user/emails", get(emails))
            .with_state(inner.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, inner }
    }

    /// Who GitHub knows, with their addresses and whether GitHub verified each.
    fn person(&self, id: u64, login: &str, emails: &[(&str, bool)]) {
        self.inner.lock().unwrap().people.insert(
            id,
            Person {
                login: login.to_owned(),
                emails: emails
                    .iter()
                    .map(|(email, verified)| ((*email).to_owned(), *verified))
                    .collect(),
            },
        );
    }

    /// What the person does at GitHub's authorize page: checks what was asked for and comes
    /// back with a code (tied to the challenge) and the state they were given.
    fn consent(&self, authorize_url: &str, user: u64) -> (String, String) {
        let url = url::Url::parse(authorize_url).unwrap();
        assert_eq!(url.path(), "/login/oauth/authorize");
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["client_id"], CLIENT_ID);
        assert_eq!(query["redirect_uri"], REDIRECT);
        assert_eq!(query["code_challenge_method"], "S256");
        assert!(query["scope"].contains("user:email"));
        assert!(!authorize_url.contains(CLIENT_SECRET));
        let mut inner = self.inner.lock().unwrap();
        let code = format!("code-{}", inner.codes.len() + inner.issued as usize + 1);
        inner.codes.insert(
            code.clone(),
            Grant {
                challenge: query["code_challenge"].clone(),
                user,
            },
        );
        (code, query["state"].clone())
    }
}

fn auth(methods: &[CredentialKind], github: Option<&FakeGithub>) -> Auth {
    let auth = Auth::new(
        AuthPolicy::new(methods.iter().copied()),
        PasswordParams::insecure_for_tests(),
    );
    match github {
        Some(fake) => auth.with_github(
            GithubApp::new(CLIENT_ID, Secret::new(CLIENT_SECRET), REDIRECT)
                .unwrap()
                .with_urls(&fake.url, &fake.url),
        ),
        None => auth,
    }
}

fn settings(auth: Auth, outbox: Option<&Arc<Outbox>>) -> Settings {
    Settings {
        auth,
        public_url: Some(PublicUrl::parse("https://jian.example.test").unwrap()),
        mail: MailConfig {
            deploy: outbox.map(|outbox| DeployMail {
                mailer: outbox.clone(),
                from: Mailbox::parse("Jian <signin@example.test>").unwrap(),
            }),
            ..MailConfig::default()
        },
        ..open_settings()
    }
}

fn error_of(body: &str) -> String {
    serde_json::from_str::<ErrorBody>(body).unwrap().error
}

async fn authorize_url(gateway: &Gateway, path: &str, token: Option<&str>, body: Value) -> String {
    let (status, body) = http_post(gateway.addr, path, token, &body).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<AuthorizeUrlResponse>(&body)
        .unwrap()
        .authorize_url
}

/// A whole sign-in at GitHub as `user`: its answer.
async fn github_sign_in(
    gateway: &Gateway,
    fake: &FakeGithub,
    user: u64,
    tenant: Option<&str>,
) -> (u16, String) {
    let url = authorize_url(
        gateway,
        "/v1/auth/github/start",
        None,
        json!({ "tenant": tenant }),
    )
    .await;
    let (code, state) = fake.consent(&url, user);
    http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &json!({ "code": code, "state": state }),
    )
    .await
}

async fn me_of(gateway: &Gateway, token: &str) -> Me {
    let (status, body) = http_get(gateway.addr, "/v1/me", Some(token)).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

fn session_of(body: &str) -> LoginResponse {
    serde_json::from_str(body).unwrap()
}

#[tokio::test]
async fn github_signs_in_a_member_by_a_verified_address_then_by_id() {
    let fake = FakeGithub::start().await;
    let (gateway, tenants) = start(settings(auth(&ALL, Some(&fake)), None)).await;
    let side = &tenants.a;
    // GitHub vouches for the admin's address, and for another one that means nothing here.
    fake.person(
        42,
        "octo",
        &[("someone@else.test", true), (&side.admin.email, true)],
    );

    let (status, body) = github_sign_in(&gateway, &fake, 42, None).await;
    assert_eq!(status, 200, "{body}");
    let session = session_of(&body);
    assert_eq!(session.member.email, side.admin.email);
    assert_eq!(session.tenant, side.id.as_str());
    // GitHub's access token went nowhere.
    assert!(!body.contains("gho_"));
    // The same session a password makes.
    let by_github = me_of(&gateway, &session.token).await;
    let (_, body) = http_post(
        gateway.addr,
        "/v1/auth/login",
        None,
        &json!({ "email": side.admin.email, "password": PASSWORD }),
    )
    .await;
    let by_password = me_of(&gateway, &session_of(&body).token).await;
    assert_eq!(by_github, by_password);

    // Now it is linked by GitHub's id: the address GitHub gives may change.
    assert_eq!(
        gateway.db.account_by_github("42").await.unwrap().as_ref(),
        Some(&side.admin.account_id)
    );
    fake.person(42, "octo-renamed", &[("other@else.test", true)]);
    let (status, body) = github_sign_in(&gateway, &fake, 42, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(session_of(&body).member.email, side.admin.email);

    // A state works once: its code, replayed, finds it spent.
    let url = authorize_url(&gateway, "/v1/auth/github/start", None, json!({})).await;
    let (code, state) = fake.consent(&url, 42);
    let callback = json!({ "code": code, "state": state });
    let first = http_post(gateway.addr, "/v1/auth/github/callback", None, &callback).await;
    assert_eq!(first.0, 200, "{}", first.1);
    let again = http_post(gateway.addr, "/v1/auth/github/callback", None, &callback).await;
    assert_eq!(
        (again.0, error_of(&again.1).as_str()),
        (400, "invalid_state")
    );
    gateway.stop().await;
}

#[tokio::test]
async fn github_never_lets_in_a_stranger_or_another_workspace() {
    let fake = FakeGithub::start().await;
    let (gateway, tenants) = start(settings(auth(&ALL, Some(&fake)), None)).await;
    let (a, b) = (&tenants.a, &tenants.b);

    // An address GitHub did not verify proves nothing: no sign-in and no link left behind.
    fake.person(7, "unverified", &[(&a.admin.email, false)]);
    let (status, body) = github_sign_in(&gateway, &fake, 7, None).await;
    assert_eq!((status, error_of(&body).as_str()), (403, "not_a_member"));
    assert_eq!(gateway.db.account_by_github("7").await.unwrap(), None);

    // Somebody nobody added: no account is made for them.
    fake.person(8, "stranger", &[("stranger@nowhere.test", true)]);
    let (status, body) = github_sign_in(&gateway, &fake, 8, None).await;
    assert_eq!((status, error_of(&body).as_str()), (403, "not_a_member"));
    assert!(
        gateway
            .db
            .account_by_email("stranger@nowhere.test")
            .await
            .unwrap()
            .is_none()
    );

    // A member of A asking for workspace B does not get B, and is not linked by trying.
    fake.person(9, "of-a", &[(&a.admin.email, true)]);
    let (status, body) = github_sign_in(&gateway, &fake, 9, Some(b.id.as_str())).await;
    assert_eq!((status, error_of(&body).as_str()), (403, "not_a_member"));
    assert_eq!(gateway.db.account_by_github("9").await.unwrap(), None);
    // A workspace that does not exist is refused at the start.
    let (status, _) = http_post(
        gateway.addr,
        "/v1/auth/github/start",
        None,
        &json!({ "tenant": "no-such-workspace" }),
    )
    .await;
    assert_eq!(status, 400);

    // A state nobody made; and GitHub refusing the code, which still spends the state.
    let callback = |code: &str, state: &str| json!({ "code": code, "state": state });
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &callback("code-1", "jls_not-a-state"),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_state"));
    let url = authorize_url(&gateway, "/v1/auth/github/start", None, json!({})).await;
    let (_, state) = fake.consent(&url, 9);
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &callback("a-code-github-never-gave", &state),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "github_refused"));
    let (code, _) = fake.consent(&url, 9);
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &callback(&code, &state),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_state"));

    // The state of a link, which a signed-in member began, does not sign anybody in.
    let link_url = authorize_url(
        &gateway,
        "/v1/auth/github/link",
        Some(&a.member_session),
        json!({}),
    )
    .await;
    let (code, state) = fake.consent(&link_url, 9);
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &callback(&code, &state),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_state"));

    // The state belongs to the member who began it: a peer cannot finish it, nor can B.
    fake.person(10, "linker", &[]);
    for token in [&a.peer_session, &b.admin_session] {
        let link_url = authorize_url(
            &gateway,
            "/v1/auth/github/link",
            Some(&a.member_session),
            json!({}),
        )
        .await;
        let (code, state) = fake.consent(&link_url, 10);
        let (status, body) = http_post(
            gateway.addr,
            "/v1/auth/github/link/complete",
            Some(token),
            &callback(&code, &state),
        )
        .await;
        assert_eq!((status, error_of(&body).as_str()), (400, "invalid_state"));
    }
    assert_eq!(gateway.db.account_by_github("10").await.unwrap(), None);
    gateway.stop().await;
}

#[tokio::test]
async fn a_member_links_and_unlinks_github_and_keeps_a_way_in() {
    let fake = FakeGithub::start().await;
    let methods = [CredentialKind::Password, CredentialKind::Github];
    let (gateway, tenants) = start(settings(auth(&methods, Some(&fake)), None)).await;
    let a = &tenants.a;
    let call = |method: &'static str, path: &'static str, token: &str, body: Option<Value>| {
        let body = body.map(|body| body.to_string());
        let token = token.to_owned();
        let addr = gateway.addr;
        async move { http_request(addr, method, path, Some(&token), body.as_deref()).await }
    };

    let (status, body) = call("GET", "/v1/auth/github", &a.member_session, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<GithubStatus>(&body).unwrap().linked,
        None
    );
    let (status, body) = call("DELETE", "/v1/auth/github", &a.member_session, None).await;
    assert_eq!((status, error_of(&body).as_str()), (404, "not_linked"));

    fake.person(5, "member-gh", &[]);
    let url = authorize_url(
        &gateway,
        "/v1/auth/github/link",
        Some(&a.member_session),
        json!({}),
    )
    .await;
    let (code, state) = fake.consent(&url, 5);
    let (status, body) = call(
        "POST",
        "/v1/auth/github/link/complete",
        &a.member_session,
        Some(json!({ "code": code, "state": state })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let linked = GithubAccount {
        id: "5".to_owned(),
        login: "member-gh".to_owned(),
    };
    assert_eq!(
        serde_json::from_str::<GithubAccount>(&body).unwrap(),
        linked
    );
    let (_, body) = call("GET", "/v1/auth/github", &a.member_session, None).await;
    assert_eq!(
        serde_json::from_str::<GithubStatus>(&body).unwrap().linked,
        Some(linked)
    );

    // That GitHub user is the member's: somebody else cannot take it, and the member cannot add a
    // second one.
    let url = authorize_url(
        &gateway,
        "/v1/auth/github/link",
        Some(&a.peer_session),
        json!({}),
    )
    .await;
    let (code, state) = fake.consent(&url, 5);
    let (status, body) = call(
        "POST",
        "/v1/auth/github/link/complete",
        &a.peer_session,
        Some(json!({ "code": code, "state": state })),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (409, "github_taken"));
    fake.person(6, "second", &[]);
    let url = authorize_url(
        &gateway,
        "/v1/auth/github/link",
        Some(&a.member_session),
        json!({}),
    )
    .await;
    let (code, state) = fake.consent(&url, 6);
    let (status, body) = call(
        "POST",
        "/v1/auth/github/link/complete",
        &a.member_session,
        Some(json!({ "code": code, "state": state })),
    )
    .await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "github_already_linked")
    );

    // With a password to fall back on, unlinking is allowed.
    let (status, body) = call("DELETE", "/v1/auth/github", &a.member_session, None).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(gateway.db.account_by_github("5").await.unwrap(), None);
    // The owner's token is not a person: it has nothing to link.
    let (status, _) = call(
        "POST",
        "/v1/auth/github/link",
        &a.owner_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 403);
    gateway.stop().await;
}

#[tokio::test]
async fn the_last_way_to_sign_in_cannot_be_unlinked() {
    let fake = FakeGithub::start().await;
    // Only GitHub signs people in here: no password, no link by e-mail.
    let (gateway, tenants) =
        start(settings(auth(&[CredentialKind::Github], Some(&fake)), None)).await;
    let admin = &tenants.a.admin;
    gateway
        .db
        .link_github(&admin.account_id, "11", "only-way")
        .await
        .unwrap();
    let (status, body) = http_request(
        gateway.addr,
        "DELETE",
        "/v1/auth/github",
        Some(&tenants.a.admin_session),
        None,
    )
    .await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "last_sign_in_method")
    );
    assert!(
        gateway
            .db
            .github_link(&admin.account_id)
            .await
            .unwrap()
            .is_some()
    );
    gateway.stop().await;
}

#[tokio::test]
async fn a_state_and_a_link_run_out() {
    let fake = FakeGithub::start().await;
    let short = auth(&ALL, Some(&fake))
        .with_state_ttl(Duration::from_millis(400))
        .with_link_ttl(Duration::from_millis(400));
    let outbox = Outbox::failing([]);
    let settings = settings(short, Some(&outbox));
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let a = &tenants.a;
    fake.person(12, "slow", &[(&a.admin.email, true)]);

    let url = authorize_url(&gateway, "/v1/auth/github/start", None, json!({})).await;
    let (code, state) = fake.consent(&url, 12);
    let (status, body) = ask(&gateway, &a.admin.email, a.id.as_str()).await;
    assert_eq!(status, 202, "{body}");
    wait_for_mail(&outbox, 1).await;
    let token = token_of(&outbox.last());

    tokio::time::sleep(Duration::from_millis(700)).await;
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/github/callback",
        None,
        &json!({ "code": code, "state": state }),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_state"));
    let (status, body) = redeem(&gateway, &token).await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_link"));
    stop(gateway, runner).await;
}

fn registry(settings: &Settings) -> JobRegistry {
    JobRegistry::new().register(
        LOGIN_LINK_SEND_KIND,
        Arc::new(LoginLinkSender::new(settings)),
    )
}

async fn ask(gateway: &Gateway, email: &str, tenant: &str) -> (u16, String) {
    http_post(
        gateway.addr,
        "/v1/auth/magic-link",
        None,
        &json!({ "email": email, "tenant": tenant }),
    )
    .await
}

async fn redeem(gateway: &Gateway, token: &str) -> (u16, String) {
    http_post(
        gateway.addr,
        "/v1/auth/magic-link/redeem",
        None,
        &json!({ "token": token }),
    )
    .await
}

/// The token in the link of an e-mail, which is in both its text and its HTML.
fn token_of(message: &jian_mail::Message) -> String {
    let (_, rest) = message.text.split_once("/login/link#token=").unwrap();
    assert!(message.html.contains("/login/link#token="));
    rest.split_whitespace().next().unwrap().to_owned()
}

async fn wait_for_mail(outbox: &Outbox, count: usize) {
    for _ in 0..400 {
        if outbox.count() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    panic!("the e-mail was never sent");
}

/// How long to watch for an e-mail that must not come.
const QUIET: Duration = Duration::from_millis(600);

#[tokio::test]
async fn a_magic_link_opens_only_the_workspace_and_member_it_was_made_for() {
    let outbox = Outbox::failing([]);
    let settings = settings(auth(&ALL, None), Some(&outbox));
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let (a, b) = (&tenants.a, &tenants.b);

    // Several workspaces and none named: the gateway cannot guess.
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/magic-link",
        None,
        &json!({ "email": a.admin.email }),
    )
    .await;
    assert_eq!((status, error_of(&body).as_str()), (400, "tenant_required"));

    // The link for A's admin in B: the address is not a member there, so nothing is sent.
    let (status, _) = ask(&gateway, &a.admin.email, b.id.as_str()).await;
    assert_eq!(status, 202);
    tokio::time::sleep(QUIET).await;
    assert_eq!(outbox.count(), 0);

    // In A it is sent, to that address, once, and opens A as that member.
    let (status, body) = ask(&gateway, &a.admin.email, a.id.as_str()).await;
    assert_eq!(status, 202, "{body}");
    wait_for_mail(&outbox, 1).await;
    let first = outbox.last();
    assert_eq!(first.to, a.admin.email);
    let first_token = token_of(&first);
    // A new request replaces it.
    ask(&gateway, &a.admin.email, a.id.as_str()).await;
    wait_for_mail(&outbox, 2).await;
    let second_token = token_of(&outbox.last());
    assert_ne!(first_token, second_token);
    let (status, body) = redeem(&gateway, &first_token).await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_link"));
    let (status, body) = redeem(&gateway, &second_token).await;
    assert_eq!(status, 200, "{body}");
    let session = session_of(&body);
    assert_eq!(
        (session.tenant.as_str(), session.member.email.as_str()),
        (a.id.as_str(), a.admin.email.as_str())
    );
    let me = me_of(&gateway, &session.token).await;
    assert_eq!(me.tenant, a.id.as_str());
    // One use only; and junk is the same answer as a spent link.
    for token in [second_token.as_str(), "jll_never-made", ""] {
        let (status, body) = redeem(&gateway, token).await;
        assert_eq!((status, error_of(&body).as_str()), (400, "invalid_link"));
    }

    // Disabled since the link was made: the link no longer opens anything.
    ask(&gateway, &a.member.email, a.id.as_str()).await;
    wait_for_mail(&outbox, 3).await;
    let token = token_of(&outbox.last());
    gateway
        .db
        .disable_member(&a.ctx, &a.member.account_id)
        .await
        .unwrap();
    let (status, body) = redeem(&gateway, &token).await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_link"));

    // Two at once with the same link: one session, not two.
    ask(&gateway, &a.peer.email, a.id.as_str()).await;
    wait_for_mail(&outbox, 4).await;
    let token = token_of(&outbox.last());
    let (one, other) = tokio::join!(redeem(&gateway, &token), redeem(&gateway, &token));
    let mut statuses = [one.0, other.0];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 400]);
    stop(gateway, runner).await;
}

#[tokio::test]
async fn asking_for_a_link_is_answered_alike_for_a_member_and_a_stranger_and_is_limited() {
    let outbox = Outbox::failing([]);
    let mut settings = settings(auth(&ALL, None), Some(&outbox));
    settings.login_per_email_and_address = Limit {
        burst: 3,
        per_second: 0.0001,
    };
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let a = &tenants.a;

    let member = ask(&gateway, &a.admin.email, a.id.as_str()).await;
    let stranger = ask(&gateway, "nobody@nowhere.test", a.id.as_str()).await;
    let junk = ask(&gateway, "not an address", a.id.as_str()).await;
    assert_eq!(member, stranger);
    assert_eq!(member, junk);
    assert_eq!(
        serde_json::from_str::<MagicLinkAccepted>(&member.1).unwrap(),
        MagicLinkAccepted { accepted: true }
    );
    // Only the member got anything.
    wait_for_mail(&outbox, 1).await;
    tokio::time::sleep(QUIET).await;
    assert_eq!(outbox.count(), 1);
    assert_eq!(outbox.last().to, a.admin.email);

    // The same address from the same caller, past the burst: 429, whoever the address is.
    for email in [a.admin.email.as_str(), "nobody@nowhere.test"] {
        for _ in 0..2 {
            ask(&gateway, email, a.id.as_str()).await;
        }
        let (status, body) = ask(&gateway, email, a.id.as_str()).await;
        assert_eq!(
            (status, error_of(&body).as_str()),
            (429, "too_many_attempts")
        );
    }
    stop(gateway, runner).await;
}

#[tokio::test]
async fn methods_that_are_off_or_not_set_up_are_not_there() {
    // Password only, as a self-hosted install is by default.
    let (gateway, tenants) = start(open_settings()).await;
    let tenant = tenants.a.id.as_str();
    for (path, body) in [
        ("/v1/auth/github/start", json!({})),
        (
            "/v1/auth/github/callback",
            json!({ "code": "x", "state": "y" }),
        ),
        (
            "/v1/auth/magic-link",
            json!({ "email": "a@b.test", "tenant": tenant }),
        ),
        ("/v1/auth/magic-link/redeem", json!({ "token": "x" })),
    ] {
        let (status, _) = http_post(gateway.addr, path, None, &body).await;
        assert_eq!(status, 404, "{path}");
    }
    let (status, _) = http_get(
        gateway.addr,
        "/v1/auth/github",
        Some(&tenants.a.admin_session),
    )
    .await;
    assert_eq!(status, 404);
    gateway.stop().await;

    // Allowed, but GitHub has no OAuth App here and there is no e-mail to send a link with.
    let (gateway, tenants) = start(settings(auth(&ALL, None), None)).await;
    let (status, body) = http_post(gateway.addr, "/v1/auth/github/start", None, &json!({})).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (404, "github_login_disabled")
    );
    let (status, body) = ask(&gateway, &tenants.a.admin.email, tenants.a.id.as_str()).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (404, "magic_link_disabled")
    );
    gateway.stop().await;
}

#[tokio::test]
async fn with_the_password_off_nobody_signs_in_with_one_and_the_link_gives_the_same_session() {
    let outbox = Outbox::failing([]);
    let settings = settings(
        auth(&[CredentialKind::Github, CredentialKind::EmailLink], None),
        Some(&outbox),
    );
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let a = &tenants.a;

    // The right password is a 404 whatever the account has.
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/login",
        None,
        &json!({ "email": a.admin.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (404, "password_login_disabled")
    );
    let (status, _) = http_post(
        gateway.addr,
        "/v1/auth/invite/accept",
        None,
        &json!({ "token": "x", "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, 404);

    ask(&gateway, &a.admin.email, a.id.as_str()).await;
    wait_for_mail(&outbox, 1).await;
    let (status, body) = redeem(&gateway, &token_of(&outbox.last())).await;
    assert_eq!(status, 200, "{body}");
    let me = me_of(&gateway, &session_of(&body).token).await;
    assert_eq!(me.kind, "session");
    assert_eq!(me.account_id.as_deref(), Some(a.admin.account_id.as_str()));
    assert!(!me.must_change_password);
    stop(gateway, runner).await;
}
