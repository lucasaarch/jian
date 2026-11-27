//! Connector accounts through the gateway: who sees one, who changes one, that a hidden account
//! is a 404, that the other tenant reaches none, and that no body carries the secret.

use std::time::Duration;

use jian_core::Visibility;
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, ConnectorAccount, ConnectorScope, NewAgent, NewConnectorAccount, Viewer,
};
use jian_testkit::Side;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

const TOKEN: &str = "ghp_synthetic_token_for_tests";

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    // A request counts against the address's attempts, and the clock is the test's.
    gateway.clock.advance(Duration::from_secs(1));
    let text = body.map(|b| b.to_string());
    let (status, answer) =
        http_request(gateway.addr, method, path, Some(token), text.as_deref()).await;
    (status, serde_json::from_str(&answer).unwrap_or(Value::Null))
}

fn admin(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

fn member(side: &Side) -> Viewer {
    Viewer {
        account: side.member.account_id.clone(),
        admin: false,
    }
}

async fn agent(gateway: &Gateway, side: &Side, visibility: Visibility) -> AgentId {
    gateway
        .db
        .create_agent(
            &side.ctx,
            &admin(side),
            &NewAgent {
                name: "bot".to_owned(),
                description: String::new(),
                instructions: String::new(),
                avatar: None,
                visibility,
                viewers: Vec::new(),
            },
        )
        .await
        .unwrap()
        .id
}

async fn account(
    gateway: &Gateway,
    side: &Side,
    by: &Viewer,
    name: &str,
    scope: ConnectorScope,
) -> ConnectorAccount {
    gateway
        .db
        .create_connector_account(
            &side.ctx,
            by,
            &NewConnectorAccount {
                plugin: "echo".to_owned(),
                kind: "token".to_owned(),
                name: name.to_owned(),
                scope,
                config: json!({ "workspace": "acme" }),
            },
            Some(&Secret::new(TOKEN)),
        )
        .await
        .unwrap()
}

fn names(list: &Value) -> Vec<String> {
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn connector_accounts_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let theirs = account(
            &gateway,
            victim,
            &admin(victim),
            "theirs",
            ConnectorScope::Shared,
        )
        .await;
        let id = theirs.id.to_string();
        let token = actor.admin_session.as_str();

        let list = call(&gateway, "GET", "/v1/connector-accounts", token, None)
            .await
            .1;
        // (The actor made one called "theirs" itself when it was the victim: go by id.)
        assert!(!list.to_string().contains(&id), "{list}");
        // Naming theirs is the same 404 as naming one that never existed.
        let rename = Some(json!({ "name": "mine" }));
        for (method, body) in [("GET", None), ("PATCH", rename), ("DELETE", None)] {
            let path = format!("/v1/connector-accounts/{id}");
            let got = call(&gateway, method, &path, token, body.clone()).await;
            assert_eq!(got.0, 404, "{method}: {}", got.1);
            let never = "/v1/connector-accounts/cna_never";
            assert_eq!(got, call(&gateway, method, never, token, body).await);
        }
        // And it is still there for its own tenant, under its own name.
        let seen = call(
            &gateway,
            "GET",
            &format!("/v1/connector-accounts/{id}"),
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!(seen.0, 200);
        assert_eq!(seen.1["name"], "theirs");
    }
}

#[tokio::test]
async fn a_member_sees_what_they_may_and_only_the_creator_or_an_admin_changes_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let shared = account(
        &gateway,
        side,
        &admin(side),
        "shared",
        ConnectorScope::Shared,
    )
    .await;
    let open = agent(&gateway, side, Visibility::Workspace).await;
    let private = agent(&gateway, side, Visibility::Private).await;
    account(
        &gateway,
        side,
        &admin(side),
        "open",
        ConnectorScope::Agents(vec![open.clone()]),
    )
    .await;
    let hidden = account(
        &gateway,
        side,
        &admin(side),
        "hidden",
        ConnectorScope::Agents(vec![private]),
    )
    .await;
    let own = account(&gateway, side, &member(side), "own", ConnectorScope::Shared).await;

    // The admin sees everything; the member everything but the account of a private agent.
    let all = call(
        &gateway,
        "GET",
        "/v1/connector-accounts",
        &side.admin_session,
        None,
    )
    .await
    .1;
    assert_eq!(names(&all), ["shared", "open", "hidden", "own"]);
    let list = call(
        &gateway,
        "GET",
        "/v1/connector-accounts",
        &side.member_session,
        None,
    )
    .await
    .1;
    assert_eq!(names(&list), ["shared", "open", "own"]);
    let hidden_path = format!("/v1/connector-accounts/{}", hidden.id);
    for method in ["GET", "DELETE"] {
        let got = call(&gateway, method, &hidden_path, &side.member_session, None).await;
        assert_eq!(got.0, 404, "{method}");
    }

    // A member cannot change an account someone else made (403); its maker and an admin can.
    let path = format!("/v1/connector-accounts/{}", shared.id);
    let only_open = json!({ "scope": { "type": "agents", "agents": [open.to_string()] } });
    let got = call(
        &gateway,
        "PATCH",
        &path,
        &side.member_session,
        Some(only_open.clone()),
    )
    .await;
    assert_eq!(got.0, 403, "{}", got.1);
    assert_eq!(
        call(&gateway, "DELETE", &path, &side.peer_session, None)
            .await
            .0,
        403
    );
    let got = call(
        &gateway,
        "PATCH",
        &path,
        &side.admin_session,
        Some(only_open),
    )
    .await;
    assert_eq!(got.0, 200, "{}", got.1);
    assert_eq!(
        got.1["scope"],
        json!({ "type": "agents", "agents": [open.to_string()] })
    );
    assert_eq!(got.1["canManage"], true);

    let own_path = format!("/v1/connector-accounts/{}", own.id);
    let got = call(
        &gateway,
        "PATCH",
        &own_path,
        &side.member_session,
        Some(json!({ "name": "renamed" })),
    )
    .await;
    assert_eq!((got.0, got.1["name"].clone()), (200, json!("renamed")));
    assert_eq!(
        call(&gateway, "DELETE", &own_path, &side.member_session, None)
            .await
            .0,
        204
    );
    assert_eq!(
        call(&gateway, "GET", &own_path, &side.member_session, None)
            .await
            .0,
        404
    );
    // A scope that reaches no agent at all is refused: that is not what `shared` or a list means.
    let got = call(
        &gateway,
        "PATCH",
        &path,
        &side.admin_session,
        Some(json!({ "scope": { "type": "agents", "agents": [] } })),
    )
    .await;
    assert_eq!(got.0, 400, "{}", got.1);
}

#[tokio::test]
async fn no_connector_account_body_carries_the_secret_or_the_settings() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let made = account(
        &gateway,
        side,
        &admin(side),
        "token",
        ConnectorScope::Shared,
    )
    .await;
    let path = format!("/v1/connector-accounts/{}", made.id);
    let mut seen = Vec::new();
    for (method, p, body) in [
        ("GET", "/v1/connector-accounts".to_owned(), None),
        ("GET", path.clone(), None),
        ("PATCH", path.clone(), Some(json!({ "name": "again" }))),
    ] {
        let (status, body) = call(&gateway, method, &p, &side.admin_session, body).await;
        assert_eq!(status, 200);
        seen.push(body.to_string());
    }
    for body in seen {
        assert!(
            !body.contains(TOKEN) && !body.contains("acme") && !body.contains("config"),
            "{body}"
        );
    }
}
