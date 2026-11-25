//! The import of the old Jian against real Postgres servers: a dump of the old desktop app's
//! database (made with the real migrations and the old `SecretBox` format, all synthetic) and an
//! old gateway's database read live.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use jian_import::{Domain, ImportOptions, ImportReport, Importer, Scope, Source};
use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::secrets::LocalKeyring;
use jian_store::{Author, Database, ImportStatus, TenantCtx, TenantId, Viewer, Who, Window};
use jian_testkit::{TestDb, TwoTenants};
use sqlx::Connection as _;

const SCRATCH: &str = env!("CARGO_TARGET_TMPDIR");
const DUMP: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/old-desktop.sql"
);
/// 32 bytes of 0x07: the synthetic key the fixtures were sealed with, as `old-schema.mjs` does.
const OLD_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const PROFILE: &str = "11111111-1111-4111-8111-111111111111";
const OPENAI: &str = "sk-test-synthetic-0001";
const TELEGRAM: &str = "123456:synthetic-bot-token";
const GROQ_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROQ: &str = "gsk-test-synthetic-0002";

/// What each domain writes from the fixture: the secrets are the OpenAI key, the Groq key and the
/// Telegram token; the providers are a Groq account (a ChatGPT sign-in is left behind).
fn rows(which: Domain) -> u32 {
    match which {
        Domain::Secrets => 3,
        // Two sessions with a person (the one between two agents is left); five messages.
        Domain::Threads => 2,
        Domain::Messages => 5,
        _ => 1,
    }
}

fn keys(key: &str) -> LocalKeyring {
    LocalKeyring::for_reading_legacy(&serde_json::json!({ "local": key }).to_string()).unwrap()
}

fn options(dir: &Path, email: Option<&str>, keys: Option<LocalKeyring>) -> ImportOptions {
    ImportOptions {
        owner_email: email.map(str::to_owned),
        keys,
        scratch_dir: dir.join("scratch"),
    }
}

/// A fresh tenant with no members, as a new install has.
async fn fresh(db: &Database) -> TenantCtx {
    let id = TenantId::parse(&format!("import{}", std::process::id())).unwrap();
    db.create_tenant(&id).await.unwrap();
    db.tenant(id).await.unwrap()
}

fn domain(report: &ImportReport, which: Domain) -> &jian_store::ImportResult {
    &report
        .domains
        .iter()
        .find(|done| done.domain == which)
        .unwrap()
        .result
}

async fn old_server(dir: &Path) -> EmbeddedPostgres {
    let server = EmbeddedPostgres::start(&EmbeddedConfig {
        data_dir: dir.join("old"),
        port: 0,
    })
    .await
    .unwrap();
    server.run_sql_file(Path::new(DUMP)).await.unwrap();
    server
}

async fn counts(server: &EmbeddedPostgres) -> String {
    let mut connection = sqlx::PgConnection::connect(server.url().expose())
        .await
        .unwrap();
    let text: String = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM remote_machines)::text || (SELECT count(*) FROM devices)::text \
         || (SELECT count(*) FROM gateway_secrets)::text || (SELECT count(*) FROM secrets)::text \
         || (SELECT md5(string_agg(envelope::text, ',' ORDER BY name)) FROM gateway_secrets) \
         || (SELECT md5(string_agg(token_hash, ',' ORDER BY id)) FROM remote_machines)",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    connection.close().await.unwrap();
    text
}

#[tokio::test]
async fn a_dump_of_the_old_desktop_database_comes_over_once() {
    let new = TestDb::start(SCRATCH).await;
    let ctx = fresh(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let opts = options(dir.path(), Some("owner@example.test"), Some(keys(OLD_KEY)));
    let source = Source::parse(DUMP).unwrap();

    let first = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::All)
        .await
        .unwrap();
    assert!(first.source.starts_with("dump:"));
    for which in Domain::ALL {
        assert_eq!(
            domain(&first, which).status,
            ImportStatus::Done,
            "{which:?}"
        );
        assert_eq!(domain(&first, which).imported, rows(which), "{which:?}");
    }
    // The secrets open under the new tenant's data key, with the values the old ones held.
    let vault = new.db.vault();
    let openai = vault.read(&ctx, "provider:openai").await.unwrap().unwrap();
    assert_eq!(openai.expose(), OPENAI);
    let telegram = vault
        .read(&ctx, &format!("profile:{PROFILE}:channel:telegram"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(telegram.expose(), TELEGRAM);
    // The Groq account came with its key, active; the ChatGPT sign-in did not come, and says why.
    let accounts = new.db.provider_accounts(&ctx).await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(
        (accounts[0].id.as_str(), accounts[0].label.as_str()),
        (GROQ_ID, "Groq work")
    );
    assert!(accounts[0].active && accounts[0].has_key);
    let groq = new.db.provider_key(&ctx, GROQ_ID).await.unwrap().unwrap();
    assert_eq!(groq.expose(), GROQ);
    let detail = domain(&first, Domain::Providers).detail.clone().unwrap();
    assert!(
        detail.contains("subscription not supported yet"),
        "{detail}"
    );
    let machines = new.db.list_machines(&ctx, None, 10).await.unwrap().items;
    assert_eq!(machines.len(), 1);
    assert_eq!(machines[0].name, "Studio Mac");
    assert_eq!(machines[0].capabilities, ["shell", "computer"]);
    let members = new.db.list_members(&ctx, None, 10).await.unwrap().items;
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].email, "owner@example.test");
    assert!(!members[0].has_password);
    // What has no table yet is listed, with its rows; what was imported is not.
    let left: Vec<&str> = first.not_imported.iter().map(|t| t.name.as_str()).collect();
    assert!(!left.contains(&"profiles") && !left.contains(&"sessions"));
    assert!(!left.contains(&"messages") && !left.contains(&"contacts"));
    assert!(!left.contains(&"remote_machines") && !left.contains(&"secrets"));
    assert!(!left.contains(&"providers"));
    let threads = domain(&first, Domain::Threads).detail.clone().unwrap();
    assert!(
        threads.contains("1 sessions between two agents"),
        "{threads}"
    );
    owners_chats_came_over(&new.db, &ctx, &members[0].account_id).await;
    // The scratch server is gone with its directory.
    assert!(!dir.path().join("scratch").exists());

    // Again: nothing is written twice.
    let again = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::All)
        .await
        .unwrap();
    for which in Domain::ALL {
        let result = domain(&again, which);
        assert_eq!(
            (result.imported, result.already_there),
            (0, rows(which)),
            "{which:?}"
        );
    }
    assert_eq!(
        new.db
            .list_machines(&ctx, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    // Finished domains are not read again at a start.
    let pending = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::Pending)
        .await
        .unwrap();
    assert!(pending.domains.is_empty());
    let markers = new.db.imports(&ctx).await.unwrap();
    assert_eq!(markers.len(), 8);
    assert!(markers.iter().all(|m| m.status == ImportStatus::Done));
    new.stop().await;
}

#[tokio::test]
async fn reading_a_live_old_database_changes_nothing_in_it() {
    let new = TestDb::start(SCRATCH).await;
    let ctx = fresh(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let old = old_server(dir.path()).await;
    let before = counts(&old).await;
    let source = Source::Postgres(old.url().clone());
    let opts = options(dir.path(), None, Some(keys(OLD_KEY)));

    let mut reader = source.open(&opts.scratch_dir).await.unwrap();
    assert!(reader.is_read_only().await.unwrap());
    reader.close().await;
    let report = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::All)
        .await
        .unwrap();
    // The source in the marker has no password.
    assert!(
        report.source.starts_with("postgres:127.0.0.1:")
            || report.source.starts_with("postgres:localhost:")
    );
    assert!(!report.source.contains('@'));
    assert_eq!(domain(&report, Domain::Machines).imported, 1);
    assert_eq!(domain(&report, Domain::Devices).imported, 1);
    assert_eq!(domain(&report, Domain::Secrets).imported, 3);
    assert_eq!(domain(&report, Domain::Providers).imported, 1);
    // No address was given: the owner is skipped, and a later run with one takes it.
    assert_eq!(domain(&report, Domain::Owner).status, ImportStatus::Skipped);
    for which in [Domain::Agents, Domain::Threads, Domain::Messages] {
        let result = domain(&report, which);
        assert_eq!(result.status, ImportStatus::Skipped, "{which:?}");
        assert!(result.detail.as_deref().unwrap().contains("owner"));
    }
    assert_eq!(counts(&old).await, before);
    new.stop().await;
    old.stop().await.unwrap();
}

#[tokio::test]
async fn a_run_that_stopped_or_lacked_a_key_is_finished_by_the_next() {
    let new = TestDb::start(SCRATCH).await;
    let ctx = fresh(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let source = Source::parse(DUMP).unwrap();
    // A crash: the machines' marker says running and never finished.
    new.db
        .start_import(&ctx, "machines", "dump:crashed")
        .await
        .unwrap();

    // The wrong key: the secrets fail one by one and say so without their values.
    let wrong = options(
        dir.path(),
        None,
        Some(keys("CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=")),
    );
    let first = Importer::new(&new.db, &ctx, &wrong)
        .run(&source, Scope::Pending)
        .await
        .unwrap();
    let secrets = domain(&first, Domain::Secrets);
    assert_eq!(
        (secrets.status, secrets.failed, secrets.imported),
        (ImportStatus::Failed, 3, 0)
    );
    let markers = format!("{:?}", new.db.imports(&ctx).await.unwrap());
    assert!(!markers.contains(OPENAI) && !markers.contains(TELEGRAM));
    assert_eq!(domain(&first, Domain::Machines).imported, 1);

    // The right key: only what is not done runs, and the failed secrets come over.
    let right = options(dir.path(), None, Some(keys(OLD_KEY)));
    let second = Importer::new(&new.db, &ctx, &right)
        .run(&source, Scope::Pending)
        .await
        .unwrap();
    let ran: Vec<Domain> = second.domains.iter().map(|d| d.domain).collect();
    assert_eq!(
        ran,
        [
            Domain::Owner,
            Domain::Secrets,
            Domain::Providers,
            Domain::Agents,
            Domain::Threads,
            Domain::Messages
        ]
    );
    // No owner address was given, so the chats wait for one and say so.
    for which in [Domain::Agents, Domain::Threads, Domain::Messages] {
        assert_eq!(domain(&second, which).status, ImportStatus::Skipped);
    }
    assert_eq!(domain(&second, Domain::Secrets).imported, 3);
    assert_eq!(
        new.db
            .list_machines(&ctx, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    new.stop().await;
}

#[tokio::test]
async fn another_tenant_is_never_touched_and_an_existing_owner_is_kept() {
    let new = TestDb::start(SCRATCH).await;
    let two = TwoTenants::seed(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let opts = options(dir.path(), Some("owner@example.test"), Some(keys(OLD_KEY)));
    let source = Source::parse(DUMP).unwrap();
    let b_machines = new
        .db
        .list_machines(&two.b.ctx, None, 10)
        .await
        .unwrap()
        .items
        .len();
    let b_members = new
        .db
        .list_members(&two.b.ctx, None, 10)
        .await
        .unwrap()
        .items
        .len();
    let b_secret = new
        .db
        .vault()
        .read(&two.b.ctx, "provider:openai")
        .await
        .unwrap();

    let report = Importer::new(&new.db, &two.a.ctx, &opts)
        .run(&source, Scope::All)
        .await
        .unwrap();
    // A already has members: the owner is not added, and it says so.
    let owner = domain(&report, Domain::Owner);
    assert_eq!(owner.imported, 0);
    assert!(
        owner
            .detail
            .as_deref()
            .unwrap()
            .contains("already has members")
    );
    assert_eq!(domain(&report, Domain::Machines).imported, 1);
    // Their address is not a member of A, so there is no one to make the agents and chats.
    assert_eq!(
        domain(&report, Domain::Agents).status,
        ImportStatus::Skipped
    );
    assert_eq!(new.db.imports(&two.b.ctx).await.unwrap().len(), 0);
    let admin_b = Viewer {
        account: two.b.admin.account_id.clone(),
        admin: true,
    };
    let nothing = new
        .db
        .list_agents(&two.b.ctx, &admin_b, None, 10)
        .await
        .unwrap();
    assert!(nothing.items.is_empty());
    let nothing = new
        .db
        .list_threads(&two.b.ctx, &admin_b, None, None, 10)
        .await
        .unwrap();
    assert!(nothing.items.is_empty());
    assert_eq!(
        new.db
            .list_machines(&two.b.ctx, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        b_machines
    );
    assert_eq!(
        new.db
            .list_members(&two.b.ctx, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        b_members
    );
    assert_eq!(
        new.db
            .vault()
            .read(&two.b.ctx, "provider:openai")
            .await
            .unwrap()
            .map(|s| s.expose().to_owned()),
        b_secret.map(|s| s.expose().to_owned())
    );
    new.stop().await;
}

#[test]
fn a_pglite_directory_and_a_missing_file_are_refused_with_the_way_out() {
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    std::fs::write(dir.path().join("PG_VERSION"), "18\n").unwrap();
    let error = Source::parse(dir.path().to_str().unwrap())
        .unwrap_err()
        .to_string();
    assert!(error.contains("PGlite"), "{error}");
    let missing: PathBuf = dir.path().join("nope.sql");
    assert!(Source::parse(missing.to_str().unwrap()).is_err());
}

/// What the fixture's profile, sessions and messages became, in order.
async fn owners_chats_came_over(db: &Database, ctx: &TenantCtx, owner: &jian_store::AccountId) {
    let viewer = Viewer {
        account: owner.clone(),
        admin: true,
    };
    let agents = db.list_agents(ctx, &viewer, None, 10).await.unwrap().items;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].name, "Synthetic");
    assert_eq!(&agents[0].created_by, owner);
    assert_eq!(agents[0].visibility.as_str(), "workspace");

    // Newest first: the WhatsApp group (a channel thread of the agent, with Ana outside), then
    // the first chat (a direct chat of the owner).
    let threads = db
        .list_threads(ctx, &viewer, None, None, 10)
        .await
        .unwrap()
        .items;
    let kinds: Vec<&str> = threads.iter().map(|t| t.kind.as_str()).collect();
    assert_eq!(kinds, ["channel", "dm"]);
    let channel = &threads[0];
    let origin = channel.origin.as_ref().unwrap();
    assert_eq!(
        (origin.channel.as_str(), origin.external_id.as_str()),
        ("whatsapp", "120363000000000001@g.us")
    );
    let dm = &threads[1];
    assert_eq!(dm.title.as_deref(), Some("First chat"));
    assert!(
        dm.participants
            .iter()
            .any(|p| p.who == Who::Member(owner.clone()))
    );

    // The old order is kept as `seq`, whatever the clocks said; authors and times are kept.
    let page = db
        .list_messages(ctx, &viewer, &dm.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    let said: Vec<(i64, &str)> = page
        .items
        .iter()
        .map(|m| match &m.parts[0] {
            jian_core::MessagePart::Text(text) => (m.seq, text.as_str()),
            other @ jian_core::MessagePart::Legacy { .. } => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        said,
        [
            (1, "hello"),
            (2, "hi, how can I help?"),
            (3, "third, with an old clock")
        ]
    );
    assert!(matches!(page.items[0].author, Author::Member(_)));
    assert!(matches!(page.items[1].author, Author::Agent(_)));
    assert!(page.items[0].created_at.starts_with("2026-11-25T18:00:01"));

    // A channel message keeps its author, and what the core has no part for is kept whole.
    let page = db
        .list_messages(ctx, &viewer, &channel.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(&page.items[0].author, Author::External { label, .. } if label == "Ana"));
    assert_eq!(page.items[1].parts.len(), 2);
    let jian_core::MessagePart::Legacy { kind, json } = &page.items[1].parts[1] else {
        panic!("expected the extras");
    };
    assert_eq!(kind, "message-extras");
    assert!(
        json.contains("wamid-1") && json.contains("reactions"),
        "{json}"
    );
}
