//! Migrations against a real Postgres, with fixture migrations written to a scratch folder.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::path::Path;

use jian_store::{Database, Migrations, StoreError, TenantStatus};
use sqlx::migrate::Migrator;
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
    let ninth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0009_quotas.sql"
    ))
    .unwrap();
    let tenth = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0010_github_and_links.sql"
    ))
    .unwrap();
    let eleventh = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform/0011_machine_minutes.sql"
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
            ("0009_quotas.sql", &ninth),
            ("0010_github_and_links.sql", &tenth),
            ("0011_machine_minutes.sql", &eleventh),
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
            "SELECT version::text FROM _sqlx_migrations ORDER BY _sqlx_migrations.version"
        )
        .await,
        [
            "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16",
            "17", "18"
        ]
    );
    // After a restart the tenant is migrated again with nothing to do.
    let report = db.migrate().await.unwrap();
    assert_eq!(report.migrated, [id("local")]);
    exec(&db, &local, "SELECT 1").await;
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn the_threads_migration_upgrades_a_tenant_and_keeps_what_it_had() {
    // The four tenant migrations as shipped before the workspace of agents and threads.
    let shipped = |file: &str| {
        std::fs::read_to_string(format!(
            "{}/migrations/tenant/{file}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    };
    let files = [
        "0001_init.sql",
        "0002_secrets.sql",
        "0003_machines_devices.sql",
        "0004_providers.sql",
    ];
    let before: Vec<(&str, String)> = files.iter().map(|f| (*f, shipped(f))).collect();
    let before: Vec<(&str, &str)> = before.iter().map(|(f, s)| (*f, s.as_str())).collect();
    let server = Server::start().await;
    let db = database(&server, "before", &before).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    db.issue_machine(&alpha, "kept box").await.unwrap();
    assert_eq!(
        texts(
            &db,
            &alpha,
            "SELECT count(*)::text FROM information_schema.tables \
             WHERE table_schema = 'tenant_alpha' AND table_name = 'threads'"
        )
        .await,
        ["0"]
    );

    let db = db.with_migrations(Migrations::embedded());
    let report = db.migrate().await.unwrap();
    assert_eq!(report.migrated, [id("alpha")]);
    assert!(report.failed.is_empty());
    assert_eq!(
        texts(&db, &alpha, "SELECT name FROM machines").await,
        ["kept box"]
    );
    let tables = texts(
        &db,
        &alpha,
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = 'tenant_alpha' AND table_name IN \
         ('agents', 'agent_viewers', 'member_grants', 'threads', 'thread_participants', 'messages') \
         ORDER BY 1",
    )
    .await;
    assert_eq!(
        tables,
        [
            "agent_viewers",
            "agents",
            "member_grants",
            "messages",
            "thread_participants",
            "threads"
        ]
    );
    // The new tables work for a tenant that already had data.
    exec(
        &db,
        &alpha,
        "INSERT INTO agents (id, name, visibility, created_by) VALUES ('agt_1', 'A', 'workspace', 'acc')",
    )
    .await;
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn tool_approval_is_dropped_and_a_run_that_waited_on_one_ends_failed() {
    let server = Server::start().await;
    let real = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations/tenant");
    let mut shipped = std::fs::read_dir(&real)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    shipped.sort();
    // The release before: everything up to 0016 (0017 is under test, 0018 comes after it).
    assert!(shipped.pop().unwrap().starts_with("0018_"));
    let last = shipped.pop().unwrap();
    assert!(last.starts_with("0017_"), "{last}");
    let before = shipped
        .iter()
        .map(|name| {
            (
                name.clone(),
                std::fs::read_to_string(real.join(name)).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let files = before
        .iter()
        .map(|(name, sql)| (name.as_str(), sql.as_str()))
        .collect::<Vec<_>>();
    let db = database(&server, "v16", &files).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    exec(
        &db,
        &alpha,
        "INSERT INTO agents (id, name, visibility, created_by) \
         VALUES ('agt_1', 'A', 'workspace', 'acc')",
    )
    .await;
    exec(
        &db,
        &alpha,
        "INSERT INTO threads (id, kind) VALUES ('thr_1', 'dm'), ('thr_2', 'dm')",
    )
    .await;
    // thr_1 waited on a tool approval, thr_2 waits on a subagent's report.
    exec(
        &db,
        &alpha,
        "INSERT INTO runs (id, thread_id, agent_id, trigger_seq, seen_seq, state, resume) VALUES \
         ('run_1', 'thr_1', 'agt_1', 1, 1, 'waiting_approval', '{\"callId\":\"c1\"}'), \
         ('run_2', 'thr_2', 'agt_1', 1, 1, 'waiting_approval', '{\"callId\":\"c2\"}')",
    )
    .await;
    exec(
        &db,
        &alpha,
        "INSERT INTO run_approvals (id, run_id, call_id, tool, input, expires_at) \
         VALUES ('apr_1', 'run_1', 'c1', 'shell', '{}', now() + interval '1 hour')",
    )
    .await;

    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        Migrator::new(real.as_path()).await.unwrap(),
    ));
    assert!(db.migrate().await.unwrap().failed.is_empty());
    assert_eq!(
        texts(
            &db,
            &alpha,
            "SELECT id || '/' || state || '/' || (resume IS NULL)::text FROM runs ORDER BY id"
        )
        .await,
        ["run_1/failed/true", "run_2/waiting/false"]
    );
    assert!(
        texts(
            &db,
            &alpha,
            "SELECT error FROM runs WHERE id = 'run_1' AND finished_at IS NOT NULL"
        )
        .await[0]
            .contains("tool approval")
    );
    assert_eq!(
        texts(
            &db,
            &alpha,
            "SELECT (to_regclass('run_approvals') IS NULL)::text"
        )
        .await,
        ["true"]
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn proactivity_defaults_to_suggest_and_an_hourly_limit_resets_except_off() {
    let server = Server::start().await;
    let real = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations/tenant");
    let mut shipped = std::fs::read_dir(&real)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    shipped.sort();
    // The release before: everything but the last migration.
    let last = shipped.pop().unwrap();
    assert!(last.starts_with("0018_"), "{last}");
    let before = shipped
        .iter()
        .map(|name| {
            (
                name.clone(),
                std::fs::read_to_string(real.join(name)).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let files = before
        .iter()
        .map(|(name, sql)| (name.as_str(), sql.as_str()))
        .collect::<Vec<_>>();
    let db = database(&server, "v17", &files).await;
    db.migrate().await.unwrap();
    let alpha = tenant(&db, "alpha").await;
    exec(
        &db,
        &alpha,
        "INSERT INTO agents (id, name, visibility, created_by) VALUES \
         ('agt_1', 'A', 'workspace', 'acc'), ('agt_2', 'B', 'workspace', 'acc'), \
         ('agt_3', 'C', 'workspace', 'acc')",
    )
    .await;
    exec(
        &db,
        &alpha,
        "INSERT INTO agent_config (agent_id, max_wakes_per_hour, max_proactive_runs_per_hour) \
         VALUES ('agt_1', 12, 0), ('agt_2', 0, 5), ('agt_3', NULL, NULL)",
    )
    .await;

    let db = db.with_migrations(Migrations::new(
        platform_migrator().await,
        Migrator::new(real.as_path()).await.unwrap(),
    ));
    assert!(db.migrate().await.unwrap().failed.is_empty());
    // Every agent is in `suggest`; a number of the hour is the default now, a 0 stays 0.
    assert_eq!(
        texts(
            &db,
            &alpha,
            "SELECT agent_id || '/' || proactivity || '/' || COALESCE(max_wakes_per_day::text, '-') \
             || '/' || COALESCE(max_proactive_runs_per_day::text, '-') \
             FROM agent_config ORDER BY agent_id"
        )
        .await,
        ["agt_1/suggest/-/0", "agt_2/suggest/0/-", "agt_3/suggest/-/-"]
    );
    db.close().await.unwrap();
    server.stop().await;
}
