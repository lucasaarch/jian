//! `/v1/providers`: an admin's alone, and one workspace's accounts and keys are out of reach of
//! another's. No test calls a model.

use jian_protocol::providers::{ModelCatalog, ProviderAccountSummary, ProvidersPage};
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_get, http_post};

const KEY_A: &str = "sk-workspace-a-PLAINTEXT-0001";

async fn create(gateway: &Gateway, token: &str, body: &Value) -> (u16, String) {
    http_post(gateway.addr, "/v1/providers", Some(token), body).await
}

async fn listed(gateway: &Gateway, token: &str) -> Vec<ProviderAccountSummary> {
    let (status, body) = http_get(gateway.addr, "/v1/providers", Some(token)).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<ProvidersPage>(&body).unwrap().items
}

#[tokio::test]
async fn provider_accounts_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);

    // Admin only: a member and a caller with no token get nothing, not even the list.
    for token in [Some(a.member_session.as_str()), None] {
        let (status, _) = http_get(gateway.addr, "/v1/providers", token).await;
        assert!(matches!(status, 401 | 403), "{status}");
        let body = json!({ "provider": "openai", "apiKey": KEY_A });
        let (status, _) = http_post(gateway.addr, "/v1/providers", token, &body).await;
        assert!(matches!(status, 401 | 403), "{status}");
    }
    assert!(listed(&gateway, &a.admin_session).await.is_empty());

    // A makes an account: inactive, with a key the answer never shows.
    let body = json!({
        "provider": "openai-compatible",
        "label": "fake",
        "baseUrl": "http://127.0.0.1:9/v1",
        "apiKey": KEY_A,
    });
    let (status, text) = create(&gateway, &a.admin_session, &body).await;
    assert_eq!(status, 201, "{text}");
    assert!(!text.contains(KEY_A));
    let made: ProviderAccountSummary = serde_json::from_str(&text).unwrap();
    assert!(made.has_key && !made.active && made.mode == "api");

    // Refused with a reason, before anything is stored.
    for bad in [
        json!({ "provider": "nobody" }),
        json!({ "provider": "openai-compatible" }),
        json!({ "provider": "openai", "mode": "subscription" }),
        json!({ "provider": "openai", "label": "  " }),
    ] {
        let (status, text) = create(&gateway, &a.admin_session, &bad).await;
        assert_eq!(status, 400, "{bad}: {text}");
    }
    assert_eq!(listed(&gateway, &a.admin_session).await.len(), 1);

    // B sees nothing of it, and cannot activate or revoke it: 404, as for an id that never was.
    assert!(listed(&gateway, &b.admin_session).await.is_empty());
    let activate = format!("/v1/providers/{}/activate", made.id);
    let revoke = format!("/v1/providers/{}/revoke", made.id);
    let (status, text) =
        http_post(gateway.addr, &activate, Some(&b.admin_session), &json!({})).await;
    assert_eq!(status, 404, "{text}");
    let (status, other) = http_post(
        gateway.addr,
        "/v1/providers/prv_nothing/revoke",
        Some(&b.admin_session),
        &json!({}),
    )
    .await;
    assert_eq!(status, 404);
    let (status, text) = http_post(gateway.addr, &revoke, Some(&b.admin_session), &json!({})).await;
    assert_eq!(status, 404);
    assert_eq!(text, other);
    let theirs = listed(&gateway, &a.admin_session).await;
    assert_eq!(theirs.len(), 1);
    assert!(theirs[0].has_key && !theirs[0].active);

    // The owner activates and revokes their own.
    let (status, text) =
        http_post(gateway.addr, &activate, Some(&a.admin_session), &json!({})).await;
    assert_eq!(status, 200, "{text}");
    assert!(
        serde_json::from_str::<ProviderAccountSummary>(&text)
            .unwrap()
            .active
    );
    let (status, _) = http_post(gateway.addr, &revoke, Some(&a.admin_session), &json!({})).await;
    assert_eq!(status, 204);
    assert!(listed(&gateway, &a.admin_session).await.is_empty());

    // The catalog holds nothing of a tenant, and a signed-in member may read it.
    let (status, text) = http_get(
        gateway.addr,
        "/v1/providers/models",
        Some(&b.member_session),
    )
    .await;
    assert_eq!(status, 200, "{text}");
    let catalog: ModelCatalog = serde_json::from_str(&text).unwrap();
    assert!(
        catalog
            .providers
            .iter()
            .any(|p| p.provider == "anthropic" && !p.models.is_empty())
    );
    let (status, _) = http_get(gateway.addr, "/v1/providers/models", None).await;
    assert_eq!(status, 401);
    gateway.stop().await;
}
