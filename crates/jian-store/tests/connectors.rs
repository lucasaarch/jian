//! Connector accounts against a real Postgres: which agents reach one, who sees and who changes
//! it, where its secret lives, that tenant B reaches nothing of tenant A's, and that the import of
//! the old MCP servers can repeat.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, ConnectorAccount, ConnectorAccountId, ConnectorAccountPatch, ConnectorScope, Database,
    ImportOutcome, LegacyConnector, NewAgent, NewConnectorAccount, StoreError, Viewer,
    connector_secret_owner,
};
use jian_testkit::{Side, TestDb, TwoTenants};
use serde_json::json;

const TOKEN: &str = "ghp_synthetic_token_for_tests";

fn viewer(side: &Side, who: &str) -> Viewer {
    let (member, admin) = match who {
        "admin" => (&side.admin, true),
        "member" => (&side.member, false),
        _ => (&side.peer, false),
    };
    Viewer {
        account: member.account_id.clone(),
        admin,
    }
}

async fn agent(db: &Database, side: &Side, visibility: Visibility) -> AgentId {
    db.create_agent(
        &side.ctx,
        &viewer(side, "admin"),
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
    db: &Database,
    side: &Side,
    by: &str,
    name: &str,
    scope: ConnectorScope,
) -> ConnectorAccount {
    db.create_connector_account(
        &side.ctx,
        &viewer(side, by),
        &NewConnectorAccount {
            plugin: "echo".to_owned(),
            kind: "token".to_owned(),
            name: name.to_owned(),
            scope,
            config: json!({}),
        },
        Some(&Secret::new(TOKEN)),
    )
    .await
    .unwrap()
}

async fn reached(db: &Database, side: &Side, agent: &AgentId) -> Vec<String> {
    db.agent_connector_accounts(&side.ctx, agent)
        .await
        .unwrap()
        .into_iter()
        .map(|a| a.name)
        .collect()
}

#[tokio::test]
async fn an_agent_reaches_the_shared_accounts_and_those_that_list_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (a, b) = (
        agent(&test.db, &side, Visibility::Workspace).await,
        agent(&test.db, &side, Visibility::Workspace).await,
    );
    account(&test.db, &side, "admin", "everyone", ConnectorScope::Shared).await;
    let only_a = account(
        &test.db,
        &side,
        "admin",
        "only-a",
        ConnectorScope::Agents(vec![a.clone()]),
    )
    .await;

    assert_eq!(reached(&test.db, &side, &a).await, ["everyone", "only-a"]);
    assert_eq!(reached(&test.db, &side, &b).await, ["everyone"]);

    // A scope change is what the next run reads.
    test.db
        .update_connector_account(
            &side.ctx,
            &viewer(&side, "admin"),
            &only_a.id,
            &ConnectorAccountPatch {
                scope: Some(ConnectorScope::Agents(vec![b.clone()])),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reached(&test.db, &side, &a).await, ["everyone"]);
    assert_eq!(reached(&test.db, &side, &b).await, ["everyone", "only-a"]);

    // Back to shared: the list is gone with it.
    let shared = test
        .db
        .update_connector_account(
            &side.ctx,
            &viewer(&side, "admin"),
            &only_a.id,
            &ConnectorAccountPatch {
                scope: Some(ConnectorScope::Shared),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shared.scope, ConnectorScope::Shared);
    assert_eq!(reached(&test.db, &side, &a).await, ["everyone", "only-a"]);
    test.stop().await;
}

#[tokio::test]
async fn a_member_sees_shared_accounts_theirs_and_those_of_agents_they_see() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let open = agent(&test.db, &side, Visibility::Workspace).await;
    let hidden = agent(&test.db, &side, Visibility::Private).await;
    let (member, peer) = (viewer(&side, "member"), viewer(&side, "peer"));

    account(&test.db, &side, "admin", "shared", ConnectorScope::Shared).await;
    account(
        &test.db,
        &side,
        "admin",
        "of-open",
        ConnectorScope::Agents(vec![open.clone()]),
    )
    .await;
    let of_hidden = account(
        &test.db,
        &side,
        "admin",
        "of-hidden",
        ConnectorScope::Agents(vec![hidden.clone()]),
    )
    .await;
    account(&test.db, &side, "peer", "peers", ConnectorScope::Shared).await;

    let names = |page: jian_store::Page<ConnectorAccount>| {
        page.items.into_iter().map(|a| a.name).collect::<Vec<_>>()
    };
    let seen = test
        .db
        .list_connector_accounts(&side.ctx, &member, None, 50)
        .await
        .unwrap();
    assert_eq!(names(seen), ["shared", "of-open", "peers"]);
    // The admin sees every account, a private agent's included.
    let all = test
        .db
        .list_connector_accounts(&side.ctx, &viewer(&side, "admin"), None, 50)
        .await
        .unwrap();
    assert_eq!(all.items.len(), 4);
    // Not visible reads as not there, one by one too.
    assert!(
        test.db
            .connector_account(&side.ctx, &member, &of_hidden.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        test.db
            .connector_account(&side.ctx, &peer, &of_hidden.id)
            .await
            .unwrap()
            .is_none()
    );
    test.stop().await;
}

#[tokio::test]
async fn only_the_creator_or_an_admin_changes_an_account() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let mine = account(&test.db, &side, "member", "mine", ConnectorScope::Shared).await;
    let rename = |name: &str| ConnectorAccountPatch {
        name: Some(name.to_owned()),
        ..Default::default()
    };

    // A peer sees the shared account but did not make it.
    let denied = test
        .db
        .update_connector_account(&side.ctx, &viewer(&side, "peer"), &mine.id, &rename("x"))
        .await;
    assert!(matches!(denied, Err(StoreError::Denied(_))), "{denied:?}");
    let denied = test
        .db
        .delete_connector_account(&side.ctx, &viewer(&side, "peer"), &mine.id)
        .await;
    assert!(matches!(denied, Err(StoreError::Denied(_))), "{denied:?}");

    let renamed = test
        .db
        .update_connector_account(
            &side.ctx,
            &viewer(&side, "member"),
            &mine.id,
            &rename("new"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.name, "new");
    let by_admin = test
        .db
        .update_connector_account(
            &side.ctx,
            &viewer(&side, "admin"),
            &mine.id,
            &rename("admin"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_admin.name, "admin");

    // A scope may list only agents the actor sees.
    let hidden = agent(&test.db, &side, Visibility::Private).await;
    let refused = test
        .db
        .update_connector_account(
            &side.ctx,
            &viewer(&side, "member"),
            &mine.id,
            &ConnectorAccountPatch {
                scope: Some(ConnectorScope::Agents(vec![hidden])),
                ..Default::default()
            },
        )
        .await;
    assert!(matches!(refused, Err(StoreError::InvalidWorkspace(_))));
    test.stop().await;
}

#[tokio::test]
async fn the_secret_lives_in_the_vault_and_goes_with_the_account() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let made = account(&test.db, &side, "admin", "docs", ConnectorScope::Shared).await;

    // Not in the row the API reads, nor in anything the account carries.
    assert!(!format!("{made:?}").contains(TOKEN));
    let secret = test
        .db
        .connector_account_secret(&side.ctx, &made.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(secret.expose(), TOKEN);
    assert!(
        test.db
            .vault()
            .read(&side.ctx, &connector_secret_owner(&made.id))
            .await
            .unwrap()
            .is_some()
    );

    assert!(
        test.db
            .delete_connector_account(&side.ctx, &viewer(&side, "admin"), &made.id)
            .await
            .unwrap()
    );
    assert!(
        test.db
            .connector_account_secret(&side.ctx, &made.id)
            .await
            .unwrap()
            .is_none()
    );
    test.stop().await;
}

#[tokio::test]
async fn tenant_b_reaches_nothing_of_tenant_a() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (a, b) = (sides.a, sides.b);
    let theirs = account(&test.db, &a, "admin", "theirs", ConnectorScope::Shared).await;
    let b_agent = agent(&test.db, &b, Visibility::Workspace).await;

    // B's agent reaches none of A's shared accounts, and B's admin sees, changes, deletes nothing.
    assert!(reached(&test.db, &b, &b_agent).await.is_empty());
    let admin_b = viewer(&b, "admin");
    let list = test
        .db
        .list_connector_accounts(&b.ctx, &admin_b, None, 50)
        .await
        .unwrap();
    assert!(list.items.is_empty());
    assert!(
        test.db
            .connector_account(&b.ctx, &admin_b, &theirs.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !test
            .db
            .delete_connector_account(&b.ctx, &admin_b, &theirs.id)
            .await
            .unwrap()
    );
    assert!(
        test.db
            .connector_account_secret(&b.ctx, &theirs.id)
            .await
            .unwrap()
            .is_none()
    );
    // A's account is still whole.
    assert!(
        test.db
            .connector_account_secret(&a.ctx, &theirs.id)
            .await
            .unwrap()
            .is_some()
    );
    test.stop().await;
}

#[tokio::test]
async fn importing_the_old_mcp_servers_twice_writes_one_shared_account_and_one_secret() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let owner = side.admin.account_id.clone();
    let legacy = LegacyConnector {
        name: "docs".to_owned(),
        server: json!({"url": "https://docs.example.test/mcp"}),
        created_at: "2025-01-02T03:04:05Z".to_owned(),
        updated_at: "2025-01-02T03:04:05Z".to_owned(),
    };

    // The `secrets` import left the token under the old owner name; the account has none yet.
    test.db
        .vault()
        .put(&side.ctx, "mcp:docs", &Secret::new(TOKEN))
        .await
        .unwrap();
    let first = test
        .db
        .import_connector(&side.ctx, &owner, &legacy)
        .await
        .unwrap();
    let second = test
        .db
        .import_connector(&side.ctx, &owner, &legacy)
        .await
        .unwrap();
    assert_eq!(
        (first, second),
        (ImportOutcome::Imported, ImportOutcome::AlreadyThere)
    );

    let page = test
        .db
        .list_connector_accounts(&side.ctx, &viewer(&side, "admin"), None, 50)
        .await
        .unwrap();
    let imported: Vec<&ConnectorAccount> =
        page.items.iter().filter(|a| a.plugin == "mcp").collect();
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0].scope, ConnectorScope::Shared);
    assert_eq!(imported[0].name, "docs");
    assert_eq!(imported[0].created_by, owner);
    let id: &ConnectorAccountId = &imported[0].id;
    assert_eq!(
        test.db
            .connector_account_secret(&side.ctx, id)
            .await
            .unwrap()
            .unwrap()
            .expose(),
        TOKEN
    );
    test.stop().await;
}
