//! The session of a chat account against a real Postgres: what is written is read back after a
//! restart, is sealed in the column, and belongs to one account of one tenant.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{
    AgentId, ChannelAccount, Database, DatabaseSource, NewAgent, TenantCtx, Viewer,
    channel_secret_owner,
};
use jian_testkit::{Side, TestDb, TwoTenants, master_keys};
use sqlx::PgPool;

const KEY: &str = "PRIVATE-IDENTITY-KEY-0123456789";

fn viewer(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

async fn agent(db: &Database, side: &Side, name: &str) -> AgentId {
    let new = NewAgent {
        name: name.to_owned(),
        description: String::new(),
        instructions: String::new(),
        avatar: None,
        visibility: Visibility::Workspace,
        viewers: Vec::new(),
    };
    db.create_agent(&side.ctx, &viewer(side), &new)
        .await
        .unwrap()
        .id
}

async fn account(db: &Database, side: &Side, name: &str) -> ChannelAccount {
    let bot = agent(db, side, name).await;
    db.create_channel_account(&side.ctx, &viewer(side), &bot, "whatsapp", None)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_session_survives_a_restart_and_is_sealed_in_the_column() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let acct = account(db, &sides.a, "pear").await;

    db.put_channel_session(ctx, &acct.id, "identity", KEY.as_bytes())
        .await
        .unwrap();
    db.put_channel_session(ctx, &acct.id, "prekey/1", b"one")
        .await
        .unwrap();
    db.put_channel_session(ctx, &acct.id, "prekey/2", b"two")
        .await
        .unwrap();
    // Writing again replaces.
    db.put_channel_session(ctx, &acct.id, "prekey/2", b"two!")
        .await
        .unwrap();

    // A restart is a new handle on the same database.
    let reopened = Database::open(DatabaseSource::External(test.url.clone()))
        .await
        .unwrap()
        .with_master_keys(master_keys());
    let read = reopened
        .channel_session(ctx, &acct.id, "identity")
        .await
        .unwrap();
    assert_eq!(read.as_deref(), Some(KEY.as_bytes()));
    assert_eq!(
        reopened
            .channel_session(ctx, &acct.id, "prekey/2")
            .await
            .unwrap()
            .as_deref(),
        Some(&b"two!"[..])
    );
    assert_eq!(
        db.channel_session_keys(ctx, &acct.id, "prekey/")
            .await
            .unwrap(),
        ["prekey/1", "prekey/2"]
    );
    // A `%` in a prefix is a `%`, not a wildcard.
    assert!(
        db.channel_session_keys(ctx, &acct.id, "%")
            .await
            .unwrap()
            .is_empty()
    );

    // The column holds an envelope, and the key's text is nowhere in it.
    let pool = PgPool::connect(test.url.expose()).await.unwrap();
    let schema = sides.a.schema();
    let envelope: Vec<u8> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT envelope FROM {schema}.channel_session WHERE key = 'identity'"
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !envelope
            .windows(KEY.len())
            .any(|window| window == KEY.as_bytes())
    );
    let dump: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT string_agg(to_json(s)::text, ' ') FROM {schema}.channel_session s"
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!dump.contains(KEY), "{dump}");
}

#[tokio::test]
async fn another_account_or_tenant_reads_none_of_it_and_a_moved_row_does_not_open() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let sides = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let (a, b): (&TenantCtx, &TenantCtx) = (&sides.a.ctx, &sides.b.ctx);
    let pear = account(db, &sides.a, "pear").await;
    let plum = account(db, &sides.a, "plum").await;
    let other = account(db, &sides.b, "pear").await;
    db.put_channel_session(a, &pear.id, "identity", KEY.as_bytes())
        .await
        .unwrap();

    // Another account of the same tenant.
    assert!(
        db.channel_session(a, &plum.id, "identity")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.channel_session_keys(a, &plum.id, "")
            .await
            .unwrap()
            .is_empty()
    );
    // The other tenant, asking for the very same account id: nothing, and nothing changes.
    assert!(
        db.channel_session(b, &pear.id, "identity")
            .await
            .unwrap()
            .is_none()
    );
    db.delete_channel_session(b, &pear.id, "identity")
        .await
        .unwrap();
    assert_eq!(db.clear_channel_session(b, &pear.id).await.unwrap(), 0);
    assert!(
        db.channel_session(a, &pear.id, "identity")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        db.channel_session(b, &other.id, "identity")
            .await
            .unwrap()
            .is_none()
    );

    // A row copied to another account (as if by hand in the database) is refused, not read.
    let pool = PgPool::connect(test.url.expose()).await.unwrap();
    let schema = sides.a.schema();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO {schema}.channel_session (account_id, key, envelope) \
         SELECT '{}', key, envelope FROM {schema}.channel_session WHERE account_id = '{}'",
        plum.id, pear.id
    )))
    .execute(&pool)
    .await
    .unwrap();
    assert!(
        db.channel_session(a, &plum.id, "identity").await.is_err(),
        "bound to {}",
        channel_secret_owner(&pear.id, "identity")
    );
}

#[tokio::test]
async fn logging_out_forgets_the_session_and_only_that_accounts() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let pear = account(db, &side, "pear").await;
    let plum = account(db, &side, "plum").await;
    for acct in [&pear, &plum] {
        db.put_channel_session(ctx, &acct.id, "identity", b"k")
            .await
            .unwrap();
        db.put_channel_session(ctx, &acct.id, "session/x", b"s")
            .await
            .unwrap();
    }
    assert_eq!(db.clear_channel_session(ctx, &pear.id).await.unwrap(), 2);
    assert!(
        db.channel_session_keys(ctx, &pear.id, "")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.channel_session_keys(ctx, &plum.id, "")
            .await
            .unwrap()
            .len(),
        2
    );
}
