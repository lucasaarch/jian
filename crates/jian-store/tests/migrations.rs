//! Migrations against a real Postgres, with fixture migrations written to a scratch folder.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_store::{Database, Migrations, StoreError, TenantStatus};
use support::{Server, exec, id, migrator, platform_migrator, tenant, texts};

const ITEMS: (&str, &str) = ("0001_items.sql", "CREATE TABLE items (name text NOT NULL);");
const COLOUR: (&str, &str) = (
    "0002_colour.sql",
    "ALTER TABLE items ADD COLUMN colour text DEFAULT 'none';",
);

/// A database whose tenants migrate with `files`, under the real platform migrations.
async fn database(server: &Server, name: &str, files: &[(&str, &str)]) -> Database {
    server.connect().await.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), name, files).await,
    ))
}

#[tokio::test]
async fn a_new_migration_is_applied_and_the_data_is_still_there() {
    let server = Server::start().await;
    let db = database(&server, "v1", &[ITEMS]).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    exec(&db, &alpha, "INSERT INTO items VALUES ('pen')").await;

    // The next release ships one more migration.
    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "v2", &[ITEMS, COLOUR]).await,
    ));
    let report = db.migrate().await.unwrap();
    assert_eq!(report.migrated, [id("alpha")]);
    assert!(report.failed.is_empty());
    assert_eq!(
        texts(&db, &alpha, "SELECT name || '/' || colour FROM items").await,
        ["pen/none"]
    );
    // Starting again with nothing new changes nothing.
    assert!(db.migrate().await.unwrap().failed.is_empty());
    assert_eq!(texts(&db, &alpha, "SELECT name FROM items").await, ["pen"]);

    // A tenant made now gets every migration, in order.
    let beta = tenant(&db, "beta").await;
    assert_eq!(
        texts(
            &db,
            &beta,
            "SELECT version::text FROM _sqlx_migrations ORDER BY version"
        )
        .await,
        ["1", "2"]
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_migration_changed_after_it_was_applied_is_refused_and_says_which() {
    let server = Server::start().await;
    let db = database(&server, "v1", &[ITEMS]).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    exec(&db, &alpha, "INSERT INTO items VALUES ('pen')").await;

    let edited = (
        "0001_items.sql",
        "CREATE TABLE items (name text, extra int);",
    );
    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "edited", &[edited]).await,
    ));
    let report = db.migrate().await.unwrap();
    assert!(report.migrated.is_empty());
    let [(tenant_id, error)] = &report.failed[..] else {
        panic!("expected one failure, got {:?}", report.failed);
    };
    assert_eq!(tenant_id, &id("alpha"));
    let message = error.to_string();
    assert!(
        message.contains("alpha")
            && message.contains("migration 1")
            && message.contains("modified"),
        "{message}"
    );
    assert_eq!(texts(&db, &alpha, "SELECT name FROM items").await, ["pen"]);

    // One that was applied and is gone from the build is refused too.
    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "gone", &[]).await,
    ));
    let report = db.migrate().await.unwrap();
    assert!(
        report.failed[0].1.to_string().contains("missing"),
        "{:?}",
        report.failed
    );

    // The platform's are held to the same rule, and that one stops the start.
    // The later migrations stay as shipped, so only the first one is changed.
    let second = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0002_tenant_keys.sql"
    ))
    .unwrap();
    let third = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0003_api_tokens.sql"
    ))
    .unwrap();
    let fourth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0004_slot_leases.sql"
    ))
    .unwrap();
    let fifth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0005_jobs.sql"
    ))
    .unwrap();
    let sixth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0006_accounts.sql"
    ))
    .unwrap();
    let seventh = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0007_invite_delivery.sql"
    ))
    .unwrap();
    let eighth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0008_imports.sql"
    ))
    .unwrap();
    let altered = migrator(
        server.dir.path(),
        "platform-edited",
        &[
            (
                "0001_tenants.sql",
                "CREATE TABLE tenants (id text PRIMARY KEY);",
            ),
            ("0002_tenant_keys.sql", &second),
            ("0003_api_tokens.sql", &third),
            ("0004_slot_leases.sql", &fourth),
            ("0005_jobs.sql", &fifth),
            ("0006_accounts.sql", &sixth),
            ("0007_invite_delivery.sql", &seventh),
            ("0008_imports.sql", &eighth),
        ],
    )
    .await;
    let db = db.with_migrations(Migrations::new(
        altered,
        migrator(server.dir.path(), "v1-again", &[ITEMS]).await,
    ));
    let error = db.migrate().await.unwrap_err();
    assert!(matches!(error, StoreError::PlatformMigration(_)));
    assert!(error.to_string().contains("modified"), "{error}");
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn two_gateways_migrating_at_once_take_turns_without_an_error() {
    let server = Server::start().await;
    let slow = (
        "0002_slow.sql",
        "SELECT pg_sleep(1); CREATE TABLE slow (n int);",
    );
    let first = database(&server, "v1", &[ITEMS]).await;
    first.migrate().await.unwrap();
    tenant(&first, "alpha").await;

    let a = database(&server, "a", &[ITEMS, slow]).await;
    let b = database(&server, "b", &[ITEMS, slow]).await;
    let (from_a, from_b) = tokio::join!(a.migrate(), b.migrate());
    let (from_a, from_b) = (from_a.unwrap(), from_b.unwrap());
    assert!(from_a.failed.is_empty() && from_b.failed.is_empty());

    let alpha = first.tenant(id("alpha")).await.unwrap();
    assert_eq!(
        texts(
            &first,
            &alpha,
            "SELECT version::text FROM _sqlx_migrations ORDER BY version"
        )
        .await,
        ["1", "2"]
    );

    // The same goes for two gateways creating the same tenant on their first start.
    let beta = id("beta");
    let (from_a, from_b) = tokio::join!(a.create_tenant(&beta), b.create_tenant(&beta));
    let mut statuses = [from_a.unwrap(), from_b.unwrap()];
    statuses.sort_by_key(|status| *status == TenantStatus::AlreadyExisted);
    assert_eq!(
        statuses,
        [TenantStatus::Created, TenantStatus::AlreadyExisted]
    );
    for db in [a, b, first] {
        db.close().await.unwrap();
    }
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_whose_migration_fails_is_left_as_it_was_and_the_others_go_on() {
    let server = Server::start().await;
    // Fails for two tenants only, after creating a table, to show nothing is left half done.
    let breaks = (
        "0002_breaks.sql",
        "CREATE TABLE half (n int); \
         DO $$ BEGIN IF current_schema() IN ('tenant_beta', 'tenant_delta') \
         THEN RAISE EXCEPTION 'boom in %', current_schema(); END IF; END $$;",
    );
    let db = database(&server, "v1", &[ITEMS]).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    let beta = tenant(&db, "beta").await;
    let gamma = tenant(&db, "gamma").await;
    exec(&db, &beta, "INSERT INTO items VALUES ('beta data')").await;

    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "v2", &[ITEMS, breaks]).await,
    ));
    let report = db.migrate().await.unwrap();
    assert_eq!(report.migrated, [id("alpha"), id("gamma")]);
    let [(failed, error)] = &report.failed[..] else {
        panic!("expected one failure, got {:?}", report.failed);
    };
    assert_eq!(failed, &id("beta"));
    let message = error.to_string();
    assert!(
        message.contains("tenant beta")
            && message.contains("migration 2")
            && message.contains("boom"),
        "{message}"
    );

    let half = "SELECT tablename::text FROM pg_tables WHERE tablename = 'half' AND schemaname = current_schema()";
    assert_eq!(texts(&db, &alpha, half).await, ["half"]);
    assert_eq!(texts(&db, &gamma, half).await, ["half"]);
    // Beta is behind this build, so the store will not hand it out (see schema_versions.rs);
    // it is read through the build it is still at.
    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "v1", &[ITEMS]).await,
    ));
    assert!(texts(&db, &beta, half).await.is_empty());
    assert_eq!(
        texts(&db, &beta, "SELECT version::text FROM _sqlx_migrations").await,
        ["1"]
    );
    assert_eq!(
        texts(&db, &beta, "SELECT name FROM items").await,
        ["beta data"]
    );
    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "v2", &[ITEMS, breaks]).await,
    ));

    // A tenant that cannot be migrated when it is created is not created at all.
    let error = db.create_tenant(&id("delta")).await.unwrap_err();
    assert!(error.to_string().contains("tenant delta"), "{error}");
    assert!(!db.list_tenants().await.unwrap().contains(&id("delta")));
    let traces = "SELECT 'schema' FROM pg_namespace WHERE nspname = 'tenant_delta' \
                  UNION ALL SELECT 'role' FROM pg_roles WHERE rolname = 'tenant_delta'";
    assert!(texts(&db, &alpha, traces).await.is_empty());
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn the_embedded_migrations_apply_to_the_platform_and_to_each_tenant() {
    let server = Server::start().await;
    let db = server.connect().await;
    let report = db.migrate().await.unwrap();
    assert!(report.migrated.is_empty() && report.failed.is_empty());
    let local = tenant(&db, "local").await;
    assert_eq!(
        texts(
            &db,
            &local,
            "SELECT version::text FROM _sqlx_migrations ORDER BY version"
        )
        .await,
        ["1", "2", "3"]
    );
    // After a restart the tenant is migrated again with nothing to do.
    let report = db.migrate().await.unwrap();
    assert_eq!(report.migrated, [id("local")]);
    exec(&db, &local, "SELECT 1").await;
    db.close().await.unwrap();
    server.stop().await;
}
