//! `GET /v1/usage` and the limits it reports, through the gateway: an admin sees only their own
//! workspace's numbers, a member is refused, and a workspace over its limit is refused with a 429
//! while the other one writes as before.

use jian_store::Quotas;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let text = body.map(|b| b.to_string());
    let (status, answer) =
        http_request(gateway.addr, method, path, Some(token), text.as_deref()).await;
    (status, serde_json::from_str(&answer).unwrap_or(Value::Null))
}

fn now_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

#[tokio::test]
async fn usage_is_each_workspaces_own_and_a_workspace_over_its_limit_is_refused() {
    let (gateway, tenants) = start(open_settings()).await;
    gateway
        .db
        .set_quotas(
            &tenants.a.ctx,
            &Quotas {
                max_concurrent_runs: Some(2),
                monthly_tokens: Some(5_000),
                disk_bytes: None,
            },
        )
        .await
        .unwrap();
    // Two of A's runs hold a place.
    for _ in 0..2 {
        gateway
            .db
            .acquire_run_lease(&tenants.a.ctx, 600_000, now_ms())
            .await
            .unwrap();
    }

    let (status, a) = call(&gateway, "GET", "/v1/usage", &tenants.a.admin_session, None).await;
    assert_eq!(status, 200, "{a}");
    assert_eq!(a["maxConcurrentRuns"], 2);
    assert_eq!(a["monthlyTokenLimit"], 5_000);
    assert_eq!(a["diskLimitBytes"], Value::Null);
    assert_eq!(a["concurrentRuns"], 2);
    assert!(a["diskBytes"].as_u64().unwrap() > 0);
    // B's numbers are B's: no limits, no runs, whatever A holds.
    let (_, b) = call(&gateway, "GET", "/v1/usage", &tenants.b.admin_session, None).await;
    assert_eq!(b["maxConcurrentRuns"], Value::Null);
    assert_eq!(b["concurrentRuns"], 0);
    // A member is not an admin.
    let (status, _) = call(
        &gateway,
        "GET",
        "/v1/usage",
        &tenants.a.member_session,
        None,
    )
    .await;
    assert_eq!(status, 403);

    // A is out of disk: its writes are refused with a 429, and B's go through.
    let full = Quotas {
        disk_bytes: Some(1),
        ..Quotas::default()
    };
    gateway.db.set_quotas(&tenants.a.ctx, &full).await.unwrap();
    for (side, expected) in [(&tenants.a, 429), (&tenants.b, 201)] {
        let (status, body) = call(
            &gateway,
            "POST",
            "/v1/projects",
            &side.admin_session,
            Some(json!({ "name": "site" })),
        )
        .await;
        assert_eq!(status, expected, "{body}");
        if expected == 429 {
            assert!(body.to_string().contains("quota_exceeded"), "{body}");
        }
    }
}
