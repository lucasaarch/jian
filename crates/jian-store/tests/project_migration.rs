//! The migration that turns a project from "a repository" into a folder: a repository a project
//! had becomes the first one attached, and every project stays visible to the workspace.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_core::Visibility;
use jian_store::{Migrations, Viewer};
use support::{Server, exec, id, migrator, platform_migrator, tenant};

const TENANT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations/tenant");

#[tokio::test]
async fn a_project_with_a_repository_url_gets_it_as_an_attachment() {
    let server = Server::start().await;
    // The release before this one: the tenant migrations up to 0008.
    let mut before = Vec::new();
    for entry in std::fs::read_dir(TENANT).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.as_str() < "0009" {
            let text = std::fs::read_to_string(format!("{TENANT}/{name}")).unwrap();
            before.push((name, text));
        }
    }
    before.sort();
    let files: Vec<(&str, &str)> = before
        .iter()
        .map(|(name, text)| (name.as_str(), text.as_str()))
        .collect();
    let old = server.connect().await.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "tenant-before", &files).await,
    ));
    old.migrate().await.unwrap();
    let alpha = tenant(&old, "alpha").await;
    exec(
        &old,
        &alpha,
        "INSERT INTO projects (id, name, repository_url, created_by) VALUES \
         ('prj_with', 'With', '  https://example.test/acme/site.git ', 'acc_old'), \
         ('prj_without', 'Without', NULL, 'acc_old'), \
         ('prj_blank', 'Blank', '   ', 'acc_old')",
    )
    .await;
    old.close().await.unwrap();

    let new = server.connect().await;
    new.migrate().await.unwrap();
    let alpha = new.tenant(id("alpha")).await.unwrap();
    // The attachment is there, trimmed, and only for the project that had one.
    let rows = support::texts(
        &new,
        &alpha,
        "SELECT project_id || ' ' || url FROM project_repositories ORDER BY project_id",
    )
    .await;
    assert_eq!(rows, ["prj_with https://example.test/acme/site.git"]);
    // Everyone saw these projects before, and still does: another member lists all three.
    let other = Viewer {
        account: jian_store::AccountId::new("acc_other"),
        admin: false,
    };
    let seen = new
        .list_projects(&alpha, &other, None, 10)
        .await
        .unwrap()
        .items;
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|p| p.visibility == Visibility::Workspace));
    let with = seen.iter().find(|p| p.name == "With").unwrap();
    assert_eq!(with.repositories.len(), 1);
    new.close().await.unwrap();
    server.stop().await;
}
