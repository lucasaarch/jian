//! The import markers against a real Postgres: that the table arrives on an upgrade without
//! touching what was there, that a marker is a tenant's own, and that a run which never said how
//! it ended is still on record.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_store::{ImportResult, ImportStatus, Migrations};
use support::{Server, id, migrator, tenant};

const PLATFORM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/platform");
const TENANT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/tenant");

fn done(imported: u32) -> ImportResult {
    ImportResult {
        status: ImportStatus::Done,
        imported,
        already_there: 1,
        failed: 0,
        detail: None,
    }
}

#[tokio::test]
async fn the_markers_table_arrives_on_an_upgrade_and_the_tenants_stay() {
    let server = Server::start().await;
    // The release before this one: the platform migrations up to 0007.
    let mut before = Vec::new();
    for entry in std::fs::read_dir(PLATFORM).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.as_str() < "0008" {
            let text = std::fs::read_to_string(format!("{PLATFORM}/{name}")).unwrap();
            before.push((name, text));
        }
    }
    before.sort();
    let files: Vec<(&str, &str)> = before
        .iter()
        .map(|(name, text)| (name.as_str(), text.as_str()))
        .collect();
    let old = server.connect().await.with_migrations(Migrations::new(
        migrator(server.dir.path(), "platform-before", &files).await,
        sqlx::migrate::Migrator::new(std::path::Path::new(TENANT))
            .await
            .unwrap(),
    ));
    old.migrate().await.unwrap();
    let alpha = tenant(&old, "alpha").await;
    assert!(
        old.imports(&alpha).await.is_err(),
        "the table is not there yet"
    );

    let new = server.connect().await;
    new.migrate().await.unwrap();
    let alpha = new.tenant(id("alpha")).await.unwrap();
    assert_eq!(new.list_tenants().await.unwrap(), [id("alpha")]);
    assert!(new.imports(&alpha).await.unwrap().is_empty());
    old.close().await.unwrap();
    new.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_marker_is_the_tenants_own_and_a_run_that_never_ended_stays_running() {
    let server = Server::start().await;
    let db = server.connect().await;
    db.migrate().await.unwrap();
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;

    db.start_import(&a, "secrets", "postgres:db.example.test:5432/jian")
        .await
        .unwrap();
    // The process died here: nothing says how it ended.
    let markers = db.imports(&a).await.unwrap();
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].status, ImportStatus::Running);
    assert!(markers[0].finished_at.is_none());

    // B sees none of it, and finishing "its" secrets changes nothing of A's.
    assert!(db.imports(&b).await.unwrap().is_empty());
    assert!(!db.finish_import(&b, "secrets", &done(5)).await.unwrap());
    assert_eq!(db.imports(&a).await.unwrap(), markers);

    // The next run starts again from zero counts and ends.
    db.start_import(&a, "secrets", "postgres:db.example.test:5432/jian")
        .await
        .unwrap();
    assert!(db.finish_import(&a, "secrets", &done(3)).await.unwrap());
    let marker = &db.imports(&a).await.unwrap()[0];
    assert_eq!(
        (marker.status, marker.imported, marker.already_there),
        (ImportStatus::Done, 3, 1)
    );
    assert!(marker.finished_at.is_some());

    // A tenant that goes takes its markers with it.
    db.start_import(&b, "owner", "dump:abc").await.unwrap();
    db.delete_tenant(&id("beta")).await.unwrap();
    db.create_tenant(&id("beta")).await.unwrap();
    let b = db.tenant(id("beta")).await.unwrap();
    assert!(db.imports(&b).await.unwrap().is_empty());
    db.close().await.unwrap();
    server.stop().await;
}
