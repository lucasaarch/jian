//! Parallel migration, the version of each schema, and the refusal to serve one that does not
//! match the build.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_store::{Database, MigrateOptions, Migrations, SchemaState, StoreError};
use support::{Server, exec, id, migrator, platform_migrator, tenant, texts};

const ITEMS: (&str, &str) = ("0001_items.sql", "CREATE TABLE items (name text NOT NULL);");

/// Fails for a tenant that has a table `blocker`, so a test chooses who fails by data, and the
/// same file can succeed later (a migration that was applied must not change).
const GUARDED: (&str, &str) = (
    "0002_guarded.sql",
    "CREATE TABLE guarded (n int); \
     DO $$ BEGIN IF to_regclass('blocker') IS NOT NULL THEN RAISE EXCEPTION 'blocked'; END IF; \
     END $$;",
);

const SLOW: (&str, &str) = (
    "0002_slow.sql",
    "SELECT pg_sleep(0.3); CREATE TABLE slow (n int);",
);

/// The build that ships `files` as the tenant migrations.
async fn build(server: &Server, name: &str, files: &[(&str, &str)]) -> Migrations {
    Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), name, files).await,
    )
}

async fn database(server: &Server, name: &str, files: &[(&str, &str)]) -> Database {
    server
        .connect()
        .await
        .with_migrations(build(server, name, files).await)
}

fn options(concurrency: usize) -> MigrateOptions {
    MigrateOptions { concurrency }
}

const VERSIONS: &str = "SELECT version::text FROM _sqlx_migrations ORDER BY version";
const INSTALLED: &str = "SELECT installed_on::text FROM _sqlx_migrations WHERE version = 2";

#[tokio::test]
async fn a_failed_tenant_stays_behind_and_the_next_run_applies_only_what_is_missing() {
    let server = Server::start().await;
    let db = database(&server, "v1", &[ITEMS]).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    let beta = tenant(&db, "beta").await;
    let gamma = tenant(&db, "gamma").await;
    let delta = tenant(&db, "delta").await;
    exec(&db, &beta, "CREATE TABLE blocker (n int)").await;

    let db = db.with_migrations(build(&server, "v2", &[ITEMS, GUARDED]).await);
    let report = db.migrate_with(&options(2)).await.unwrap();

    assert_eq!(report.migrated, [id("alpha"), id("delta"), id("gamma")]);
    let [(failed, _)] = &report.failed[..] else {
        panic!("expected one failure, got {:?}", report.failed);
    };
    assert_eq!(failed, &id("beta"));
    let behind: Vec<_> = report.behind().collect();
    assert_eq!(behind.len(), 1);
    assert_eq!(
        (
            behind[0].tenant.clone(),
            behind[0].found,
            behind[0].expected
        ),
        (id("beta"), 1, 2)
    );
    assert_eq!(report.ahead().count(), 0);
    assert_eq!(report.versions.len(), 4);
    // The same answer without migrating anything.
    assert_eq!(db.schema_versions().await.unwrap(), report.versions);

    // The good ones are served; the bad one is refused and says why.
    for ok in ["alpha", "gamma", "delta"] {
        db.tenant(id(ok)).await.unwrap();
    }
    let error = db.tenant(id("beta")).await.unwrap_err();
    assert!(matches!(error, StoreError::SchemaBehind { .. }), "{error}");
    let message = error.to_string();
    assert!(
        message.contains("tenant beta")
            && message.contains("version 1")
            && message.contains("needs 2"),
        "{message}"
    );
    // A context made earlier does not get around it.
    assert!(matches!(
        db.begin(&beta).await.unwrap_err(),
        StoreError::SchemaBehind { .. }
    ));
    let installed = texts(&db, &alpha, INSTALLED).await;

    // The data that blocked it is cleared (through the build it is still at), and the next run
    // finishes beta without touching the others.
    let db = db.with_migrations(build(&server, "v1", &[ITEMS]).await);
    exec(&db, &beta, "DROP TABLE blocker").await;
    let db = db.with_migrations(build(&server, "v2", &[ITEMS, GUARDED]).await);
    let report = db.migrate().await.unwrap();
    assert!(report.failed.is_empty());
    assert!(
        report
            .versions
            .iter()
            .all(|v| v.state() == SchemaState::Current)
    );
    assert_eq!(texts(&db, &beta, VERSIONS).await, ["1", "2"]);
    assert_eq!(texts(&db, &alpha, INSTALLED).await, installed);
    assert_eq!(texts(&db, &gamma, VERSIONS).await, ["1", "2"]);
    assert_eq!(texts(&db, &delta, VERSIONS).await, ["1", "2"]);
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_schema_ahead_of_the_build_or_behind_it_is_refused_and_a_current_one_is_not() {
    let server = Server::start().await;
    let newer = database(&server, "v2", &[ITEMS, SLOW]).await;
    newer.migrate().await.unwrap();
    let alpha = tenant(&newer, "alpha").await;
    newer.begin(&alpha).await.unwrap();

    // An older binary meets what a newer one migrated.
    let older = server
        .connect()
        .await
        .with_migrations(build(&server, "v1", &[ITEMS]).await);
    let error = older.tenant(id("alpha")).await.unwrap_err();
    assert!(matches!(error, StoreError::SchemaAhead { .. }), "{error}");
    let message = error.to_string();
    assert!(
        message.contains("tenant alpha")
            && message.contains("version 2")
            && message.contains("knows"),
        "{message}"
    );
    let versions = older.schema_versions().await.unwrap();
    assert_eq!(versions[0].state(), SchemaState::Ahead);
    // Migrating with it does not change the tenant, and it stays refused.
    older.migrate().await.unwrap();
    assert_eq!(texts(&newer, &alpha, VERSIONS).await, ["1", "2"]);
    assert!(matches!(
        older.tenant(id("alpha")).await.unwrap_err(),
        StoreError::SchemaAhead { .. }
    ));

    // A build that ships a migration the tenant lacks sees it behind until it migrates.
    let newest = server
        .connect()
        .await
        .with_migrations(build(&server, "v3", &[ITEMS, SLOW, MORE]).await);
    assert!(matches!(
        newest.tenant(id("alpha")).await.unwrap_err(),
        StoreError::SchemaBehind { .. }
    ));
    newest.migrate().await.unwrap();
    newest.tenant(id("alpha")).await.unwrap();
    for db in [newer, older, newest] {
        db.close().await.unwrap();
    }
    server.stop().await;
}

const MORE: (&str, &str) = ("0003_more.sql", "CREATE TABLE more (n int);");

#[tokio::test]
async fn many_tenants_migrate_in_parallel_and_two_gateways_take_turns() {
    let server = Server::start().await;
    let first = database(&server, "v1", &[ITEMS]).await;
    first.migrate().await.unwrap();
    let names: Vec<String> = (0..8).map(|n| format!("t{n}")).collect();
    for name in &names {
        tenant(&first, name).await;
    }

    let a = database(&server, "a", &[ITEMS, SLOW]).await;
    let b = database(&server, "b", &[ITEMS, SLOW]).await;
    let (four, three) = (options(4), options(3));
    let (from_a, from_b) = tokio::join!(a.migrate_with(&four), b.migrate_with(&three));
    let (from_a, from_b) = (from_a.unwrap(), from_b.unwrap());
    assert!(from_a.failed.is_empty() && from_b.failed.is_empty());
    assert_eq!(from_a.migrated.len(), 8);
    assert_eq!(from_b.migrated.len(), 8);
    assert!(
        from_a
            .versions
            .iter()
            .all(|v| v.found == 2 && v.expected == 2)
    );

    // Each schema got every migration exactly once, whatever the interleaving.
    for name in &names {
        let ctx = a.tenant(id(name)).await.unwrap();
        assert_eq!(texts(&a, &ctx, VERSIONS).await, ["1", "2"], "{name}");
    }
    // A concurrency of zero or far above the pool still runs.
    assert!(a.migrate_with(&options(0)).await.unwrap().failed.is_empty());
    assert!(
        a.migrate_with(&options(1000))
            .await
            .unwrap()
            .failed
            .is_empty()
    );
    for db in [a, b, first] {
        db.close().await.unwrap();
    }
    server.stop().await;
}
