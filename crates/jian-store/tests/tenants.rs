//! Tenants against a real Postgres: what one cannot reach, how they are made, deleted and saved.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_store::{StoreError, TenantId, TenantStatus, tenant_dump_args};
use support::{Server, exec, failure, id, tenant, texts};

/// 42501: the error Postgres gives for a missing privilege.
const DENIED: &str = "42501";

/// 42P01: a schema the role has no `USAGE` on is skipped in the search path, so a bare table name
/// in it is "not found" rather than "denied". Either way the data is out of reach.
const OUT_OF_REACH: [&str; 2] = [DENIED, "42P01"];

async fn migrated(server: &Server) -> jian_store::Database {
    let db = server.connect().await;
    db.migrate().await.unwrap();
    db
}

#[tokio::test]
async fn a_tenant_sees_none_of_another_tenants_data_whatever_its_search_path() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    exec(&db, &a, "CREATE TABLE notes (body text)").await;
    exec(&db, &a, "INSERT INTO notes VALUES ('secret of alpha')").await;
    exec(&db, &a, "CREATE TABLE only_in_alpha (n int)").await;
    exec(&db, &b, "CREATE TABLE notes (body text)").await;
    exec(&db, &b, "INSERT INTO notes VALUES ('beta')").await;

    // The same name resolves to each tenant's own table.
    assert_eq!(texts(&db, &b, "SELECT body FROM notes").await, ["beta"]);
    assert_eq!(
        texts(&db, &a, "SELECT body FROM notes").await,
        ["secret of alpha"]
    );

    // A search path that points at the other tenant gets no further than the schema.
    let pointed = Some("SET LOCAL search_path TO tenant_alpha");
    let code = failure(&db, &b, pointed, "SELECT body FROM notes").await;
    assert!(
        code.as_deref()
            .is_some_and(|code| OUT_OF_REACH.contains(&code)),
        "{code:?}"
    );
    let code = failure(&db, &b, pointed, "SELECT n FROM only_in_alpha").await;
    assert!(
        code.as_deref()
            .is_some_and(|code| OUT_OF_REACH.contains(&code)),
        "{code:?}"
    );
    // And so does naming the schema.
    for sql in [
        "SELECT body FROM tenant_alpha.notes",
        "INSERT INTO tenant_alpha.notes VALUES ('planted')",
        "CREATE TABLE tenant_alpha.planted (n int)",
    ] {
        assert_eq!(
            failure(&db, &b, None, sql).await.as_deref(),
            Some(DENIED),
            "{sql}"
        );
    }
    assert_eq!(
        texts(&db, &a, "SELECT body FROM notes").await,
        ["secret of alpha"]
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_cannot_read_or_write_the_platform_or_leave_anything_in_shared_places() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;

    for sql in [
        "SELECT id FROM platform.tenants",
        "INSERT INTO platform.tenants (id) VALUES ('intruder')",
        "DELETE FROM platform.tenants",
        "CREATE TABLE platform.planted (n int)",
        // PUBLIC's rights are gone: no shared schema and no temporary tables to leave data in.
        "CREATE TABLE public.shared (n int)",
        "CREATE TEMPORARY TABLE leftover (n int)",
    ] {
        assert_eq!(
            failure(&db, &a, None, sql).await.as_deref(),
            Some(DENIED),
            "{sql}"
        );
    }
    let pointed = Some("SET LOCAL search_path TO platform");
    let code = failure(&db, &a, pointed, "SELECT id FROM tenants").await;
    assert!(
        code.as_deref()
            .is_some_and(|code| OUT_OF_REACH.contains(&code)),
        "{code:?}"
    );
    // Nothing got in.
    assert_eq!(db.list_tenants().await.unwrap(), [id("alpha")]);
    db.close().await.unwrap();
    server.stop().await;
}

/// The limit the crate docs state, kept here so they stay true: the wall is the role, and the
/// pool's user is behind it. The store's own SQL never says this; a user's text must never run.
#[tokio::test]
async fn the_role_can_be_left_by_sql_that_says_so_which_is_why_only_the_stores_sql_runs() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    tenant(&db, "beta").await;
    exec(&db, &a, "CREATE TABLE notes (body text)").await;

    let mut tx = db.begin(&a).await.unwrap();
    sqlx::query("RESET ROLE").execute(&mut *tx).await.unwrap();
    let readable = sqlx::query("SELECT id FROM platform.tenants")
        .fetch_all(&mut *tx)
        .await;
    assert!(readable.is_ok());
    // `SET ROLE` is checked against the pool's user, not the current role, so it reaches any role.
    sqlx::query("SET ROLE tenant_beta")
        .execute(&mut *tx)
        .await
        .unwrap();
    drop(tx);

    // The next transaction on the pooled connection starts from the pool user again, then
    // `begin` sets the role: nothing of the escape carries over.
    assert_eq!(
        failure(&db, &a, None, "SELECT id FROM platform.tenants")
            .await
            .as_deref(),
        Some(DENIED)
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn creating_a_tenant_twice_changes_nothing_and_deleting_it_removes_schema_and_role() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = id("alpha");
    assert_eq!(
        db.create_tenant(&alpha).await.unwrap(),
        TenantStatus::Created
    );
    let ctx = db.tenant(alpha.clone()).await.unwrap();
    exec(&db, &ctx, "CREATE TABLE notes (body text)").await;
    exec(&db, &ctx, "INSERT INTO notes VALUES ('kept')").await;

    assert_eq!(
        db.create_tenant(&alpha).await.unwrap(),
        TenantStatus::AlreadyExisted
    );
    assert_eq!(texts(&db, &ctx, "SELECT body FROM notes").await, ["kept"]);
    assert_eq!(
        db.list_tenants().await.unwrap(),
        std::slice::from_ref(&alpha)
    );
    // The migration table is in the tenant's schema, with every migration the build ships.
    assert_eq!(
        texts(
            &db,
            &ctx,
            "SELECT version::text FROM _sqlx_migrations ORDER BY _sqlx_migrations.version"
        )
        .await,
        [
            "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16",
            "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28"
        ]
    );

    // The catalog is readable by every role, so a second tenant can tell what exists.
    let beta = tenant(&db, "beta").await;
    let exists = "SELECT 'schema' FROM pg_namespace WHERE nspname = 'tenant_alpha' \
                  UNION ALL SELECT 'role' FROM pg_roles WHERE rolname = 'tenant_alpha'";
    assert_eq!(texts(&db, &beta, exists).await, ["schema", "role"]);

    db.delete_tenant(&alpha).await.unwrap();
    assert!(texts(&db, &beta, exists).await.is_empty());
    assert_eq!(db.list_tenants().await.unwrap(), [id("beta")]);
    assert!(matches!(
        db.tenant(alpha.clone()).await,
        Err(StoreError::TenantNotFound(_))
    ));
    // Deleting what is not there is not an error, and the other tenant is untouched.
    db.delete_tenant(&alpha).await.unwrap();
    assert_eq!(texts(&db, &beta, "SELECT 'up'").await, ["up"]);
    db.close().await.unwrap();
    server.stop().await;
}

#[test]
fn only_lowercase_letters_and_digits_make_a_tenant_id() {
    for good in ["a", "local", "0", "abc123", &"a".repeat(48)] {
        assert!(TenantId::parse(good).is_ok(), "{good}");
    }
    for bad in [
        "",
        "Upper",
        "with space",
        "dash-ed",
        "under_score",
        "a\";DROP SCHEMA platform;--",
        "é",
        "new\nline",
        &"a".repeat(49),
    ] {
        assert!(
            matches!(TenantId::parse(bad), Err(StoreError::InvalidTenantId(_))),
            "{bad:?}"
        );
    }
    assert_eq!(TenantId::self_hosted().schema_name(), "tenant_local");
}

#[tokio::test]
async fn a_tenant_that_was_never_created_gets_no_context() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    assert!(matches!(
        db.tenant(id("ghost")).await,
        Err(StoreError::TenantNotFound(_))
    ));
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_dump_holds_that_tenants_schema_and_no_other() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    exec(&db, &a, "CREATE TABLE notes_of_alpha (body text)").await;
    exec(&db, &b, "CREATE TABLE notes_of_beta (body text)").await;

    let bin = std::fs::read_dir(server.dir.path().join("postgres"))
        .unwrap()
        .map(|entry| entry.unwrap().path().join("bin"))
        .find(|bin| {
            bin.join(format!("pg_dump{}", std::env::consts::EXE_SUFFIX))
                .exists()
        })
        .expect("the embedded server ships pg_dump");
    let tool = |name: &str| bin.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let dump = server.dir.path().join("alpha.dump");
    let status = std::process::Command::new(tool("pg_dump"))
        .args(tenant_dump_args(&id("alpha")))
        .arg(format!("--dbname={}", server.url.expose()))
        .arg(format!("--file={}", dump.display()))
        .status()
        .unwrap();
    assert!(status.success());
    let listing = std::process::Command::new(tool("pg_restore"))
        .arg("--list")
        .arg(&dump)
        .output()
        .unwrap();
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(listing.contains("notes_of_alpha"), "{listing}");
    assert!(!listing.contains("notes_of_beta"), "{listing}");
    assert!(!listing.contains("tenants"), "the platform is not in it");
    db.close().await.unwrap();
    server.stop().await;
}
