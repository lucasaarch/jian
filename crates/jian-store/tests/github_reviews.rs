//! Review requests against a real Postgres: a head commit is claimed once, a new commit is a new
//! claim, a claim given back can be made again, and tenant B reaches nothing of tenant A's.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{
    AgentId, ConnectorAccount, ConnectorScope, Database, NewAgent, NewConnectorAccount, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};
use serde_json::json;

fn admin(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

async fn agent(db: &Database, side: &Side) -> AgentId {
    db.create_agent(
        &side.ctx,
        &admin(side),
        &NewAgent {
            name: "reviewer".to_owned(),
            description: String::new(),
            instructions: String::new(),
            avatar: None,
            visibility: Visibility::Workspace,
            viewers: Vec::new(),
        },
    )
    .await
    .unwrap()
    .id
}

async fn installation(db: &Database, side: &Side) -> ConnectorAccount {
    db.create_connector_account(
        &side.ctx,
        &admin(side),
        &NewConnectorAccount {
            plugin: "github".to_owned(),
            kind: "installation".to_owned(),
            name: "acme".to_owned(),
            scope: ConnectorScope::Shared,
            config: json!({}),
        },
        None,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_head_commit_is_claimed_once_and_only_inside_its_workspace() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let (side, other) = (&tenants.a, &tenants.b);
    let (agent, account) = (agent(db, side).await, installation(db, side).await);
    let claim = |repo: &'static str, number: u64, sha: &'static str| {
        db.claim_github_review(&side.ctx, &account.id, &agent, repo, number, sha)
    };

    // Once per commit, whatever the repository's capitals.
    assert!(claim("acme/web", 7, "a1b2c3d").await.unwrap());
    assert!(!claim("acme/web", 7, "a1b2c3d").await.unwrap());
    assert!(!claim("ACME/Web", 7, "a1b2c3d").await.unwrap());

    // A push, another pull request and another repository are others.
    assert!(claim("acme/web", 7, "b2c3d4e").await.unwrap());
    assert!(claim("acme/web", 8, "a1b2c3d").await.unwrap());
    assert!(claim("acme/api", 7, "a1b2c3d").await.unwrap());

    // A claim given back is made again; the one beside it is untouched.
    db.release_github_review(&side.ctx, &account.id, "acme/web", 7, "a1b2c3d")
        .await
        .unwrap();
    assert!(claim("acme/web", 7, "a1b2c3d").await.unwrap());
    assert!(!claim("acme/web", 7, "b2c3d4e").await.unwrap());

    // The other workspace has neither the installation nor the agent: nothing is claimed, and
    // what it releases is not ours.
    db.claim_github_review(&other.ctx, &account.id, &agent, "acme/web", 70, "a1b2c3d")
        .await
        .unwrap_err();
    db.release_github_review(&other.ctx, &account.id, "acme/web", 7, "b2c3d4e")
        .await
        .unwrap();
    assert!(!claim("acme/web", 7, "b2c3d4e").await.unwrap());
    test.stop().await;
}
