//! Provider accounts and token usage against a real Postgres: one active account per vendor and
//! mode, the key only in the vault, tenants apart, and an import that can run twice.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{AccountMode, ProviderKind};
use jian_store::secrets::Secret;
use jian_store::{
    Database, ImportOutcome, LegacyProvider, NewProviderAccount, StoreError, TenantCtx,
    TokenCounts, provider_secret_owner,
};
use jian_testkit::{TestDb, TwoTenants, sql_error_code};
use sqlx::PgPool;

const SCRATCH: &str = env!("CARGO_TARGET_TMPDIR");
const KEY: &str = "sk-test-PLAINTEXT-MARKER-0001";

fn new(
    provider: ProviderKind,
    mode: AccountMode,
    label: &str,
    key: Option<&str>,
) -> NewProviderAccount {
    NewProviderAccount {
        provider,
        mode,
        label: label.to_owned(),
        base_url: provider
            .needs_base_url()
            .then(|| "http://127.0.0.1:9/v1".to_owned()),
        key: key.map(Secret::new),
    }
}

async fn make(db: &Database, ctx: &TenantCtx, provider: ProviderKind, label: &str) -> String {
    db.create_provider_account(ctx, &new(provider, AccountMode::Api, label, Some(KEY)))
        .await
        .unwrap()
        .id
}

async fn active_labels(db: &Database, ctx: &TenantCtx) -> Vec<String> {
    db.provider_accounts(ctx)
        .await
        .unwrap()
        .into_iter()
        .filter(|account| account.active)
        .map(|account| account.label)
        .collect()
}

#[tokio::test]
async fn a_vendor_and_mode_have_one_active_account_at_most() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let first = make(db, ctx, ProviderKind::OpenAi, "first").await;
    let second = make(db, ctx, ProviderKind::OpenAi, "second").await;
    let other = make(db, ctx, ProviderKind::Anthropic, "claude").await;
    let subscription = db
        .create_provider_account(
            ctx,
            &new(
                ProviderKind::OpenAi,
                AccountMode::Subscription,
                "chatgpt",
                None,
            ),
        )
        .await
        .unwrap()
        .id;
    // Made inactive: nothing is chosen for the owner.
    assert!(active_labels(db, ctx).await.is_empty());

    for id in [&first, &other, &subscription] {
        db.activate_provider_account(ctx, id)
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(active_labels(db, ctx).await, ["first", "claude", "chatgpt"]);

    // The same vendor and mode: the second takes it from the first, the others stay.
    let switched = db
        .activate_provider_account(ctx, &second)
        .await
        .unwrap()
        .unwrap();
    assert!(switched.active);
    assert_eq!(
        active_labels(db, ctx).await,
        ["second", "claude", "chatgpt"]
    );
    let active = db
        .active_provider_account(ctx, ProviderKind::OpenAi, AccountMode::Api)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.id, second);

    // Whatever the store does, the index refuses a second one.
    let code = sql_error_code(
        db,
        ctx,
        None,
        &format!("UPDATE provider_accounts SET active = true WHERE id = '{first}'"),
    )
    .await;
    assert_eq!(code.as_deref(), Some("23505"));
    test.stop().await;
}

#[tokio::test]
async fn two_activations_at_once_leave_one_active_and_no_error() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let mut ids = Vec::new();
    for label in ["a", "b", "c", "d"] {
        ids.push(make(db, ctx, ProviderKind::Groq, label).await);
    }
    let results =
        futures_util::future::join_all(ids.iter().map(|id| db.activate_provider_account(ctx, id)))
            .await;
    for result in results {
        assert!(result.unwrap().is_some());
    }
    assert_eq!(active_labels(db, ctx).await.len(), 1);
    test.stop().await;
}

#[tokio::test]
async fn the_key_is_only_in_the_vault_and_goes_with_the_account() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let id = make(db, ctx, ProviderKind::Anthropic, "work").await;
    let keyless = db
        .create_provider_account(
            ctx,
            &new(ProviderKind::Ollama, AccountMode::Api, "local", None),
        )
        .await
        .unwrap();
    let listed = db.provider_accounts(ctx).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|account| account.has_key)
            .collect::<Vec<_>>(),
        [true, false]
    );
    assert!(!keyless.has_key);
    assert_eq!(
        db.provider_key(ctx, &id).await.unwrap().unwrap().expose(),
        KEY
    );

    // What a dump of the schema holds: the table says nothing, and the envelope is sealed.
    let pool = PgPool::connect(test.url.expose()).await.unwrap();
    let schema = sides.a.schema();
    let row: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT to_json(p)::text FROM {schema}.provider_accounts p WHERE id = '{id}'"
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!row.contains(KEY));
    let envelope: Vec<u8> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT envelope FROM {schema}.secrets WHERE owner = '{}'",
        provider_secret_owner(&id)
    )))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !envelope
            .windows(KEY.len())
            .any(|window| window == KEY.as_bytes())
    );

    // Revoked: gone from the list, never active, its key deleted, and it cannot come back.
    db.activate_provider_account(ctx, &id)
        .await
        .unwrap()
        .unwrap();
    assert!(db.revoke_provider_account(ctx, &id).await.unwrap());
    assert!(!db.revoke_provider_account(ctx, &id).await.unwrap());
    assert!(db.provider_account(ctx, &id).await.unwrap().is_none());
    assert!(
        db.activate_provider_account(ctx, &id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(db.provider_key(ctx, &id).await.unwrap().is_none());
    assert!(
        db.vault()
            .read(ctx, &provider_secret_owner(&id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.active_provider_account(ctx, ProviderKind::Anthropic, AccountMode::Api)
            .await
            .unwrap()
            .is_none()
    );
    pool.close().await;
    test.stop().await;
}

#[tokio::test]
async fn an_account_needs_a_label_and_the_address_its_vendor_lacks() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let mut no_address = new(ProviderKind::OpenAiCompatible, AccountMode::Api, "x", None);
    no_address.base_url = None;
    assert!(matches!(
        db.create_provider_account(ctx, &no_address).await,
        Err(StoreError::InvalidProvider(_))
    ));
    for label in ["", "   ", "line\nbreak", &"x".repeat(61)] {
        let bad = new(ProviderKind::Groq, AccountMode::Api, label, None);
        assert!(matches!(
            db.create_provider_account(ctx, &bad).await,
            Err(StoreError::InvalidName(_))
        ));
    }
    assert!(db.provider_accounts(ctx).await.unwrap().is_empty());
    test.stop().await;
}

#[tokio::test]
async fn one_tenant_never_reaches_the_accounts_keys_or_usage_of_another() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    for (actor, victim) in sides.crossings() {
        let theirs = make(db, &victim.ctx, ProviderKind::OpenAi, "theirs").await;
        db.activate_provider_account(&victim.ctx, &theirs)
            .await
            .unwrap();
        db.record_usage(
            &victim.ctx,
            ProviderKind::OpenAi,
            &victim.schema(),
            TokenCounts {
                input: 1000,
                ..TokenCounts::default()
            },
            None,
        )
        .await
        .unwrap();

        assert!(
            db.provider_account(&actor.ctx, &theirs)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.provider_key(&actor.ctx, &theirs)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.activate_provider_account(&actor.ctx, &theirs)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !db.revoke_provider_account(&actor.ctx, &theirs)
                .await
                .unwrap()
        );
        let seen = db.provider_accounts(&actor.ctx).await.unwrap();
        assert!(seen.iter().all(|account| account.id != theirs));
        let usage = db.usage_by_day(&actor.ctx, 7).await.unwrap();
        assert!(usage.iter().all(|row| row.model != victim.schema()));
        // The attempts changed nothing for the owner of the account.
        let kept = db
            .provider_account(&victim.ctx, &theirs)
            .await
            .unwrap()
            .unwrap();
        assert!(kept.active && kept.has_key);
        assert!(
            db.usage_by_day(&victim.ctx, 7)
                .await
                .unwrap()
                .iter()
                .any(|row| row.model == victim.schema())
        );
    }
    test.stop().await;
}

#[tokio::test]
async fn usage_is_summed_by_day_and_model_for_the_tenants_own_calls() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);
    let call = |input, output| TokenCounts {
        input,
        output,
        cache_read: 10,
        cache_write: 1,
    };
    db.record_usage(
        ctx,
        ProviderKind::Anthropic,
        "claude-sonnet-4-5",
        call(100, 20),
        Some("session:s1"),
    )
    .await
    .unwrap();
    db.record_usage(
        ctx,
        ProviderKind::Anthropic,
        "claude-sonnet-4-5",
        call(50, 5),
        None,
    )
    .await
    .unwrap();
    db.record_usage(ctx, ProviderKind::OpenAi, "gpt-5", call(7, 3), None)
        .await
        .unwrap();
    // A count past what the column holds is kept at the largest, not wrapped negative.
    db.record_usage(ctx, ProviderKind::OpenAi, "huge", call(u64::MAX, 0), None)
        .await
        .unwrap();
    db.record_usage(
        &sides.b.ctx,
        ProviderKind::OpenAi,
        "gpt-5",
        call(999, 999),
        None,
    )
    .await
    .unwrap();

    let usage = db.usage_by_day(ctx, 1).await.unwrap();
    let find = |model: &str| usage.iter().find(|row| row.model == model).unwrap();
    assert_eq!(usage.len(), 3);
    let claude = find("claude-sonnet-4-5");
    assert_eq!(
        (
            claude.provider.as_str(),
            claude.calls,
            claude.input,
            claude.output
        ),
        ("anthropic", 2, 150, 25)
    );
    assert_eq!((claude.cache_read, claude.cache_write), (20, 2));
    assert_eq!((find("gpt-5").calls, find("gpt-5").input), (1, 7));
    assert_eq!(find("huge").input, i64::MAX);
    assert_eq!(claude.day.len(), 10);
    test.stop().await;
}

fn legacy(id: &str, kind: &str, auth_mode: Option<&str>, active: bool) -> LegacyProvider {
    LegacyProvider {
        id: id.to_owned(),
        name: format!("Old {kind}"),
        label: None,
        kind: kind.to_owned(),
        auth_mode: auth_mode.map(str::to_owned),
        credential: None,
        base_url: None,
        active,
        created_at: "2026-11-25 17:45:03.577+00".to_owned(),
    }
}

#[tokio::test]
async fn an_old_account_comes_over_once_and_never_takes_the_active_place_back() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, ctx) = (&test.db, &sides.a.ctx);

    let old = legacy("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "openai", None, true)
        .into_import()
        .unwrap();
    assert_eq!(old.mode(), AccountMode::Api);
    assert_eq!(
        db.import_provider(ctx, &old).await.unwrap(),
        ImportOutcome::Imported
    );
    assert_eq!(
        db.import_provider(ctx, &old).await.unwrap(),
        ImportOutcome::AlreadyThere
    );
    let account = db.provider_account(ctx, old.id()).await.unwrap().unwrap();
    assert_eq!(
        (account.provider, account.active, account.label.as_str()),
        (ProviderKind::OpenAi, true, "Old openai")
    );

    // The owner switches; a second account of the same vendor arrives still marked active.
    let newer = make(db, ctx, ProviderKind::Groq, "groq").await;
    db.activate_provider_account(ctx, &newer).await.unwrap();
    let rival = legacy("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "groq", None, true)
        .into_import()
        .unwrap();
    db.import_provider(ctx, &rival).await.unwrap();
    assert!(
        !db.provider_account(ctx, rival.id())
            .await
            .unwrap()
            .unwrap()
            .active
    );
    assert_eq!(active_labels(db, ctx).await, ["Old openai", "groq"]);

    // A ChatGPT sign-in and a Claude token are subscriptions; a vendor nobody knows is refused.
    let codex = legacy(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "openai",
        Some("codex"),
        true,
    );
    assert_eq!(
        codex.into_import().unwrap().mode(),
        AccountMode::Subscription
    );
    let mut claude = legacy(
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "anthropic",
        None,
        true,
    );
    claude.credential = Some("subscription".to_owned());
    assert_eq!(
        claude.into_import().unwrap().mode(),
        AccountMode::Subscription
    );
    assert!(legacy("e", "mistral", None, true).into_import().is_err());
    assert!(legacy(" ", "openai", None, true).into_import().is_err());
    test.stop().await;
}
