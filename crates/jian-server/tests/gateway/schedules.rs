//! Schedules through the gateway: that tenant B reaches none of tenant A's schedules or inbox,
//! that a due schedule is queued once and fires into its own agent's inbox once, and that a
//! one-shot is done after it.

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

fn id(value: &Value) -> String {
    value["id"].as_str().unwrap().to_owned()
}

fn now_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

/// `ms` as a UTC ISO 8601 time, by the days-to-civil rule, so the test needs no date crate.
fn iso(ms: i64) -> String {
    let (days, secs) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000) / 1000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

#[tokio::test]
async fn a_schedule_fires_into_its_agents_inbox_once_and_never_into_another_tenants() {
    let (gateway, tenants) = start(open_settings()).await;
    let mut made = Vec::new();
    for side in [&tenants.a, &tenants.b] {
        let (status, agent) = call(
            &gateway,
            "POST",
            "/v1/agents",
            &side.admin_session,
            Some(json!({ "name": "clock", "visibility": "workspace" })),
        )
        .await;
        assert!(matches!(status, 200 | 201), "{agent}");
        let agent = id(&agent);
        let base = format!("/v1/agents/{agent}");
        let (status, schedule) = call(
            &gateway,
            "POST",
            &format!("{base}/schedules"),
            &side.admin_session,
            Some(json!({
                "name": "wake up",
                "instruction": "say good morning",
                "at": iso(now_ms() + 10 * 60 * 1000),
            })),
        )
        .await;
        assert_eq!(status, 201, "{schedule}");
        made.push((agent, base, id(&schedule)));
    }

    // Tenant B reaches nothing of A's, and the answer is the one for an id that is not there.
    let (agent, base, schedule) = &made[0];
    let admin = tenants.b.admin_session.as_str();
    let cron = json!({ "name": "x", "instruction": "y", "cron": "0 9 * * *" });
    for (method, path, body) in [
        ("GET", format!("{base}/schedules"), None),
        ("POST", format!("{base}/schedules"), Some(cron)),
        ("GET", format!("{base}/schedules/{schedule}"), None),
        (
            "PATCH",
            format!("{base}/schedules/{schedule}"),
            Some(json!({ "enabled": false })),
        ),
        ("DELETE", format!("{base}/schedules/{schedule}"), None),
        ("GET", format!("{base}/inbox"), None),
    ] {
        let got = call(&gateway, method, &path, admin, body.clone()).await;
        assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
        let other = path.replace(agent.as_str(), "agt_never");
        assert_eq!(got, call(&gateway, method, &other, admin, body).await);
    }

    // Due in twenty minutes: both tenants' schedules are queued, once each however often it ticks.
    let later = now_ms() + 20 * 60 * 1000;
    assert_eq!(jian_server::tick(&gateway.db, later).await.unwrap(), 2);
    assert_eq!(jian_server::tick(&gateway.db, later).await.unwrap(), 0);

    // Firing writes one inbox row for the schedule's own agent and nothing for the other.
    let side = &tenants.a;
    let due = gateway
        .db
        .due_schedules(&side.ctx, later, 10)
        .await
        .unwrap();
    assert_eq!(due.len(), 1);
    for _ in 0..2 {
        gateway
            .db
            .fire_schedule(&side.ctx, &due[0].id, due[0].due_ms, later)
            .await
            .unwrap();
    }
    let inbox_path = format!("{base}/inbox");
    let (_, inbox) = call(&gateway, "GET", &inbox_path, &side.admin_session, None).await;
    let items = inbox["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{inbox}");
    assert_eq!(items[0]["payload"]["instruction"], "say good morning");
    let (_, theirs) = call(
        &gateway,
        "GET",
        &format!("{}/inbox", made[1].1),
        admin,
        None,
    )
    .await;
    assert!(theirs["items"].as_array().unwrap().is_empty());

    // The one-shot is done: off, with nothing to run next.
    let (_, after) = call(
        &gateway,
        "GET",
        &format!("{base}/schedules/{schedule}"),
        &side.admin_session,
        None,
    )
    .await;
    assert_eq!(after["enabled"], false, "{after}");
    assert_eq!(after["nextRunAt"], Value::Null);
    // Only tenant B's schedule is left to queue.
    assert_eq!(
        jian_server::tick(&gateway.db, later + 3_600_000)
            .await
            .unwrap(),
        0,
        "B's job was queued already"
    );
}
