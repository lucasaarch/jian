//! What a tenant may use, against a real Postgres: runs at the same time (five asking at a limit
//! of two let two in, and a dead run's place is recovered), tokens in a month, and disk, each
//! held to its own tenant and never to the other's.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::ProviderKind;
use jian_store::{Quotas, StoreError, TokenCounts};
use jian_testkit::{TestDb, TwoTenants};

const T0: i64 = 1_799_136_000_000;
const MINUTE: i64 = 60_000;
const DAY: i64 = 24 * 60 * MINUTE;

fn runs(limit: u32) -> Quotas {
    Quotas {
        max_concurrent_runs: Some(limit),
        ..Quotas::default()
    }
}

#[tokio::test]
async fn five_runs_asking_at_a_limit_of_two_let_two_in_and_a_dead_ones_place_comes_back() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, a, b) = (&test.db, &tenants.a, &tenants.b);
    db.set_quotas(&a.ctx, &runs(2)).await.unwrap();

    // The real clock is the one the leases are dated by, so five really race.
    let results = futures_util::future::join_all(
        (0..5).map(|_| db.acquire_run_lease(&a.ctx, 10 * MINUTE, T0)),
    )
    .await;
    let (got, refused): (Vec<_>, Vec<_>) = results.into_iter().partition(Result::is_ok);
    assert_eq!((got.len(), refused.len()), (2, 3));
    assert!(
        refused
            .iter()
            .all(|r| matches!(r, Err(StoreError::QuotaExceeded(_))))
    );
    let leases: Vec<_> = got.into_iter().map(Result::unwrap).collect();
    assert_eq!(db.quota_usage(&a.ctx, T0).await.unwrap().concurrent_runs, 2);

    // Tenant B has no limit and none of A's runs count against it; A's full house is A's.
    for _ in 0..4 {
        db.acquire_run_lease(&b.ctx, 10 * MINUTE, T0).await.unwrap();
    }
    db.set_quotas(&b.ctx, &runs(1)).await.unwrap();
    assert!(db.acquire_run_lease(&b.ctx, MINUTE, T0).await.is_err());

    // A run that renews keeps its place; one that releases frees it.
    assert!(
        db.renew_run_lease(&a.ctx, &leases[0], 10 * MINUTE, T0 + 5 * MINUTE)
            .await
            .unwrap()
    );
    db.release_run_lease(&a.ctx, &leases[1]).await.unwrap();
    db.acquire_run_lease(&a.ctx, 10 * MINUTE, T0 + 6 * MINUTE)
        .await
        .unwrap();
    assert!(
        db.acquire_run_lease(&a.ctx, 10 * MINUTE, T0 + 6 * MINUTE)
            .await
            .is_err()
    );

    // The runs that stopped renewing are gone once their time has passed: the place is recovered,
    // and a lease that expired cannot be renewed by the run that thinks it still has it.
    let later = T0 + 20 * MINUTE;
    assert!(
        !db.renew_run_lease(&a.ctx, &leases[0], 10 * MINUTE, later)
            .await
            .unwrap()
    );
    db.acquire_run_lease(&a.ctx, 10 * MINUTE, later)
        .await
        .unwrap();
    db.acquire_run_lease(&a.ctx, 10 * MINUTE, later)
        .await
        .unwrap();
    assert!(
        db.acquire_run_lease(&a.ctx, 10 * MINUTE, later)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_token_limit_refuses_the_month_it_was_reached_in_and_only_for_its_tenant() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, a, b) = (&test.db, &tenants.a, &tenants.b);
    let now = wall_ms();
    let limit = Quotas {
        monthly_tokens: Some(1_000),
        ..Quotas::default()
    };
    db.set_quotas(&a.ctx, &limit).await.unwrap();
    db.set_quotas(&b.ctx, &limit).await.unwrap();

    db.check_token_quota(&a.ctx, now).await.unwrap();
    let counts = TokenCounts {
        input: 400,
        output: 300,
        cache_read: 200,
        cache_write: 100,
    };
    db.record_usage(&a.ctx, ProviderKind::Anthropic, "m", counts, None)
        .await
        .unwrap();
    // All four kinds count: 1000 reached, so the next call is refused.
    assert_eq!(db.tokens_this_month(&a.ctx, now).await.unwrap(), 1_000);
    assert!(matches!(
        db.check_token_quota(&a.ctx, now).await,
        Err(StoreError::QuotaExceeded(_))
    ));
    // B used nothing, so B may go on; and next month A may too.
    db.check_token_quota(&b.ctx, now).await.unwrap();
    assert_eq!(db.tokens_this_month(&b.ctx, now).await.unwrap(), 0);
    db.check_token_quota(&a.ctx, now + 40 * DAY).await.unwrap();
    // No limit at all means never refused.
    db.set_quotas(&a.ctx, &Quotas::default()).await.unwrap();
    db.check_token_quota(&a.ctx, now).await.unwrap();
}

#[tokio::test]
async fn disk_is_the_size_of_the_tenants_own_schema_and_its_limit_binds_only_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, a, b) = (&test.db, &tenants.a, &tenants.b);
    let (before_a, before_b) = (
        db.disk_bytes(&a.ctx).await.unwrap(),
        db.disk_bytes(&b.ctx).await.unwrap(),
    );
    assert!(before_a > 0 && before_b > 0);
    // Tokens written by A grow A's schema and not B's.
    for _ in 0..200 {
        db.record_usage(
            &a.ctx,
            ProviderKind::Groq,
            "m",
            TokenCounts::default(),
            None,
        )
        .await
        .unwrap();
    }
    assert!(db.disk_bytes(&a.ctx).await.unwrap() > before_a);
    assert_eq!(db.disk_bytes(&b.ctx).await.unwrap(), before_b);

    let tiny = Quotas {
        disk_bytes: Some(1),
        ..Quotas::default()
    };
    db.set_quotas(&a.ctx, &tiny).await.unwrap();
    assert!(matches!(
        db.check_disk_quota(&a.ctx).await,
        Err(StoreError::QuotaExceeded(_))
    ));
    db.check_disk_quota(&b.ctx).await.unwrap();
    assert_eq!(db.quotas(&a.ctx).await.unwrap(), tiny);
    assert_eq!(db.quotas(&b.ctx).await.unwrap(), Quotas::default());
}

fn wall_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}
