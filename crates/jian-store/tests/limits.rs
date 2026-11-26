//! What one tenant may take from the shared database: a statement's time and its connections.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::{Duration, Instant};

use jian_store::{StoreError, TenantLimits};
use support::{Server, tenant};

/// 57014: the error Postgres gives for a statement it cancelled, a timeout among the reasons.
const QUERY_CANCELED: &str = "57014";

fn limits(max_connections: usize) -> TenantLimits {
    TenantLimits {
        statement_timeout: Duration::from_millis(300),
        idle_in_transaction_timeout: Duration::from_secs(60),
        max_connections,
        wait: Duration::from_millis(300),
    }
}

#[tokio::test]
async fn a_statement_over_the_timeout_is_cut_by_postgres_and_the_next_one_runs() {
    let server = Server::start().await;
    let db = server.connect().await.with_tenant_limits(limits(4));
    db.migrate().await.unwrap();
    let a = tenant(&db, "alpha").await;

    let started = Instant::now();
    let mut tx = db.begin(&a).await.unwrap();
    let error = sqlx::query("SELECT pg_sleep(30)")
        .execute(&mut *tx)
        .await
        .unwrap_err();
    let sqlx::Error::Database(error) = error else {
        panic!("not a database error: {error}");
    };
    assert_eq!(error.code().as_deref(), Some(QUERY_CANCELED));
    assert!(started.elapsed() < Duration::from_secs(10));
    drop(tx);

    // The setting ended with that transaction; a fresh one is cut at its own time, not before.
    let mut tx = db.begin(&a).await.unwrap();
    sqlx::query("SELECT pg_sleep(0.1)")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_at_its_connection_limit_is_refused_while_another_still_gets_one() {
    let server = Server::start().await;
    let db = server.connect().await.with_tenant_limits(limits(2));
    db.migrate().await.unwrap();
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;

    let first = db.begin(&a).await.unwrap();
    let second = db.begin(&a).await.unwrap();
    let started = Instant::now();
    let refused = db.begin(&a).await.unwrap_err();
    assert!(matches!(refused, StoreError::TenantBusy(_)), "{refused:?}");
    // It waited for one of its own to free up, and no longer.
    assert!(started.elapsed() >= Duration::from_millis(250));

    // The other tenant is not affected by it.
    let mut other = db.begin(&b).await.unwrap();
    sqlx::query("SELECT 1").execute(&mut *other).await.unwrap();
    other.commit().await.unwrap();

    // When one of A's connections is given back, A gets one again.
    first.commit().await.unwrap();
    db.begin(&a).await.unwrap().commit().await.unwrap();
    drop(second);
    server.stop().await;
}
