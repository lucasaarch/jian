//! A ChatGPT (Codex) sign-in: PKCE, the code's exchange, the refresh, the calls' headers and the
//! account's models. Against a fake; the real OpenAI is never called.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_core::{AccountMode, ProviderKind};
use jian_llm::{CodexAuth, CodexTokens, LlmError, Provider, StopReason};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::support::{Fake, Reply, all_ok, ask, drain, http};

const REFRESH: &str = "rt-SECRET-refresh-token";
const NOW: u64 = 1_800_000_000;

/// A token shaped like ChatGPT's: three dot-separated parts whose middle one is the claims.
fn jwt(exp: u64, account: Option<&str>) -> String {
    let mut claims = json!({ "exp": exp });
    if let Some(account) = account {
        claims["https://api.openai.com/auth"] = json!({
            "chatgpt_account_id": account,
            "chatgpt_data_residency": "eu",
        });
    }
    format!(
        "e30.{}.sig",
        URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes())
    )
}

fn stored(access: &str) -> String {
    CodexTokens::new(access, REFRESH).to_secret().to_string()
}

fn answer(status: u16, body: &Value) -> Reply {
    Reply::Status {
        status,
        headers: Vec::new(),
        body: body.to_string(),
    }
}

fn auth(fake: &Fake) -> CodexAuth {
    CodexAuth::new(&fake.url, &http()).unwrap()
}

fn query(url: &str, name: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_sign_in_carries_a_pkce_challenge_and_never_its_verifier() {
    let fake = Fake::start(Vec::new()).await;
    let login = auth(&fake).begin().unwrap();
    assert!(
        login
            .url
            .starts_with(&format!("{}/oauth/authorize?", fake.url))
    );
    assert_eq!(query(&login.url, "code_challenge_method"), "S256");
    let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(login.verifier.as_bytes()));
    assert_eq!(query(&login.url, "code_challenge"), expected);
    assert_eq!(query(&login.url, "state"), login.state);
    assert_eq!(query(&login.url, "response_type"), "code");
    assert!(!login.url.contains(login.verifier.as_str()));
    // Each sign-in has its own state and verifier.
    let other = auth(&fake).begin().unwrap();
    assert_ne!(other.state, login.state);
    assert_ne!(*other.verifier, *login.verifier);
}

#[tokio::test]
async fn the_code_is_exchanged_with_its_verifier_for_tokens() {
    let access = jwt(NOW + 3600, Some("acct-1"));
    let fake = Fake::start(vec![
        answer(
            200,
            &json!({ "access_token": access, "refresh_token": REFRESH }),
        ),
        answer(400, &json!({ "error": "invalid_grant" })),
        answer(200, &json!({ "access_token": access })),
    ])
    .await;
    let tokens = auth(&fake)
        .exchange("the-code", "the-verifier")
        .await
        .unwrap();
    assert_eq!(tokens.access_token(), access);
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/oauth/token");
        assert!(seen.raw.contains("grant_type=authorization_code"));
        assert!(seen.raw.contains("code=the-code"));
        assert!(seen.raw.contains("code_verifier=the-verifier"));
    });
    // A refused code is the person's to redo; an answer without a refresh token is no sign-in.
    let refused = auth(&fake).exchange("bad", "v").await.unwrap_err();
    assert!(
        matches!(refused, LlmError::InvalidRequest(_)),
        "{refused:?}"
    );
    let partial = auth(&fake).exchange("c", "v").await.unwrap_err();
    assert!(matches!(partial, LlmError::Stream(_)), "{partial:?}");
}

#[tokio::test]
async fn a_token_with_time_left_is_not_refreshed_and_an_ended_one_is() {
    let fresh = jwt(NOW + 3600, Some("acct-1"));
    let renewed = jwt(NOW + 7200, Some("acct-1"));
    let fake = Fake::start(vec![
        answer(
            200,
            &json!({ "access_token": renewed, "refresh_token": "rt-rotated" }),
        ),
        answer(200, &json!({ "access_token": renewed })),
    ])
    .await;
    let kept = auth(&fake)
        .ensure_fresh(&stored(&fresh), NOW)
        .await
        .unwrap();
    assert_eq!(kept.access_token(), fresh);
    assert_eq!(fake.requests(), 0);

    // Inside the margin before its end counts as ended: the call would arrive after it.
    let near = jwt(NOW + 60, Some("acct-1"));
    let rotated = auth(&fake).ensure_fresh(&stored(&near), NOW).await.unwrap();
    assert_eq!(rotated.access_token(), renewed);
    assert!(rotated.to_secret().contains("rt-rotated"));
    fake.seen(0, |seen| {
        assert!(seen.raw.contains("grant_type=refresh_token"));
        assert!(seen.raw.contains(&format!("refresh_token={REFRESH}")));
    });

    // No new refresh token in the answer: the old one still stands.
    let same = auth(&fake).ensure_fresh(&stored(&near), NOW).await.unwrap();
    assert!(same.to_secret().contains(REFRESH));
}

#[tokio::test]
async fn a_refused_refresh_token_is_marked_and_not_asked_again() {
    let ended = jwt(NOW - 10, Some("acct-1"));
    let fake = Fake::start(vec![
        answer(400, &json!({ "error": "invalid_grant" })),
        answer(503, &json!({})),
    ])
    .await;
    let marked = auth(&fake)
        .ensure_fresh(&stored(&ended), NOW)
        .await
        .unwrap();
    assert!(marked.needs_login());
    // The mark survives the vault's text, and with it no call goes out.
    let text = marked.to_secret();
    let again = auth(&fake).ensure_fresh(&text, NOW).await.unwrap();
    assert!(again.needs_login());
    assert_eq!(fake.requests(), 1);

    // A server that fails says nothing of the token: an error, and nothing is marked.
    let failed = auth(&fake)
        .ensure_fresh(&stored(&ended), NOW)
        .await
        .unwrap_err();
    assert_eq!(failed, LlmError::Server { status: 503 });

    // A stored text that is not a sign-in is a damaged secret, not an expired login.
    let damaged = auth(&fake).ensure_fresh("not json", NOW).await.unwrap_err();
    assert!(matches!(damaged, LlmError::Config(_)), "{damaged:?}");
}

#[tokio::test]
async fn no_token_shows_in_a_debug_or_an_error() {
    let access = jwt(NOW + 3600, Some("acct-1"));
    let tokens = CodexTokens::new(&access, REFRESH);
    assert!(!format!("{tokens:?}").contains(REFRESH));
    assert!(!format!("{tokens:?}").contains(&access));
    let fake = Fake::start(vec![answer(500, &json!({ "echo": REFRESH }))]).await;
    let error = auth(&fake)
        .ensure_fresh(&stored(&jwt(NOW - 1, None)), NOW)
        .await
        .unwrap_err();
    assert!(!format!("{error} {error:?}").contains(REFRESH));
}

fn codex(base: &str, access: &str) -> Box<dyn Provider> {
    jian_llm::connect_account(
        ProviderKind::OpenAi,
        AccountMode::Subscription,
        access,
        Some(base),
        None,
        &http(),
    )
    .unwrap()
}

const DONE: &str = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n";

#[tokio::test]
async fn a_call_names_the_account_and_sends_what_the_backend_takes() {
    let access = jwt(NOW + 3600, Some("acct-1"));
    let fake = Fake::start(vec![Reply::sse(DONE, 64)]).await;
    let mut request = ask();
    request.params.temperature = Some(0.2);
    let events = all_ok(drain(codex(&fake.url, &access).stream(&request).await.unwrap()).await);
    assert_eq!(
        events.last(),
        Some(&jian_llm::Event::Done(StopReason::EndTurn))
    );
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/responses");
        assert_eq!(seen.headers["authorization"], format!("Bearer {access}"));
        assert_eq!(seen.headers["chatgpt-account-id"], "acct-1");
        assert_eq!(seen.headers["x-openai-internal-codex-residency"], "eu");
        assert_eq!(seen.headers["originator"], "jian");
        assert!(!seen.headers.contains_key("x-api-key"));
        assert_eq!(seen.body["store"], false);
        assert_eq!(seen.body["stream"], true);
        assert!(seen.body.get("max_output_tokens").is_none());
        assert!(seen.body.get("temperature").is_none());
        assert!(seen.body["instructions"].is_string());
    });
}

#[tokio::test]
async fn a_token_that_names_no_account_is_a_sign_in_to_redo_and_sends_nothing() {
    let fake = Fake::start(vec![Reply::sse(DONE, 64)]).await;
    let nameless = jwt(NOW + 3600, None);
    let provider = codex(&fake.url, &nameless);
    assert!(matches!(
        provider.stream(&ask()).await.err(),
        Some(LlmError::LoginRequired)
    ));
    assert_eq!(
        provider.list_models().await.unwrap_err(),
        LlmError::LoginRequired
    );
    assert_eq!(fake.requests(), 0);
}

#[tokio::test]
async fn the_models_come_from_the_account_with_the_client_version_and_no_hidden_ones() {
    let access = jwt(NOW + 3600, Some("acct-1"));
    let page = json!({ "models": [
        { "slug": "gpt-6.1-terra", "display_name": "GPT-6.1 Terra", "priority": 3,
          "supported_reasoning_levels": [
              { "effort": "none" }, { "effort": "low" }, { "effort": "bogus" }] },
        { "slug": "gpt-6.2-astra", "display_name": "GPT-6.2 Astra", "priority": 1,
          "context_window": 1_050_000,
          "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "max" }] },
        { "slug": "old-model", "visibility": "hide", "priority": 0 },
        { "slug": "gpt-6.2-sol", "priority": 2 },
        { "no_slug": true },
    ] });
    let fake = Fake::start(vec![answer(200, &page), answer(401, &json!({}))]).await;
    let provider = codex(&fake.url, &access);
    let models = provider.list_models().await.unwrap();
    let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(ids, ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra"]);
    assert_eq!(models[0].context_window, Some(1_050_000));
    assert_eq!(models[0].reasoning_efforts, ["low", "max"]);
    assert_eq!(models[2].reasoning_efforts, ["none", "low"]);
    fake.seen(0, |seen| {
        assert!(seen.path.starts_with("/models?client_version="));
        assert_eq!(seen.headers["chatgpt-account-id"], "acct-1");
    });
    // A refusal is an error, never a list from memory.
    assert_eq!(provider.list_models().await.unwrap_err(), LlmError::Auth);
}
