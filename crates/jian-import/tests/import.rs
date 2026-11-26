//! The import of the old Jian against real Postgres servers: a dump of the old desktop app's
//! database (made with the real migrations and the old `SecretBox` format, all synthetic) and an
//! old gateway's database read live.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use jian_import::{Domain, ImportOptions, ImportReport, Importer, Scope, Source};
use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::secrets::LocalKeyring;
use jian_store::{
    ArtifactActor, ArtifactAuthor, ArtifactFilter, ArtifactVisibility, Author, Database,
    ImportStatus, TenantCtx, TenantId, Viewer, Who, Window,
};
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
const CODEX_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CODEX: &str =
    r#"{"access_token":"cx-access-synthetic-0003","refresh_token":"cx-refresh-synthetic-0004"}"#;
const CLAUDE_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLAUDE: &str = "sk-ant-oat01-synthetic-0005";

/// What each domain writes from the fixture: the secrets are the OpenAI key, the Groq key and the
/// Telegram token (the ChatGPT and Claude tokens come with their accounts); the providers are a
/// Groq account, a ChatGPT sign-in and a Claude subscription.
fn rows(which: Domain) -> u32 {
    match which {
        // Two memories and the link between them (the ended one and the bad key are left out).
        // Three schedules (the one every minute is left out).
        Domain::Secrets | Domain::Providers | Domain::Memories | Domain::Schedules => 3,
        // Five messages; and a folder and four markdown artifacts (the whiteboard and the
        // picture are left out).
        Domain::Messages | Domain::Artifacts => 5,
        // Two sessions with a person (the one between two agents is left); two skills, the ones
        // with a name the core accepts ("Bad Name" is left out).
        Domain::Threads | Domain::Skills => 2,
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
            "{which:?}: {:?}",
            domain(&first, which).detail
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
    // The Groq account came with its key, active; so did the two subscriptions, each with the
    // token the old one held, sealed again under this tenant's key.
    let accounts = new.db.provider_accounts(&ctx).await.unwrap();
    let seen: Vec<(&str, &str, &str, bool)> = accounts
        .iter()
        .map(|a| {
            (
                a.id.as_str(),
                a.label.as_str(),
                a.mode.as_str(),
                a.active && a.has_key,
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            (GROQ_ID, "Groq work", "api", true),
            (CODEX_ID, "ChatGPT", "subscription", true),
            (CLAUDE_ID, "Claude Max", "subscription", true),
        ]
    );
    for (id, token) in [(GROQ_ID, GROQ), (CODEX_ID, CODEX), (CLAUDE_ID, CLAUDE)] {
        let key = new.db.provider_key(&ctx, id).await.unwrap().unwrap();
        assert_eq!(key.expose(), token);
    }
    assert!(domain(&first, Domain::Providers).detail.is_none());
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
    memories_and_projects_came_over(&new.db, &ctx, &first, &members[0].account_id).await;
    skills_came_over(&new.db, &ctx, &first, &members[0].account_id).await;
    artifacts_came_over(&new.db, &ctx, &first, &members[0].account_id).await;
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
    // The project and its repository are still one each.
    let admin = Viewer {
        account: members[0].account_id.clone(),
        admin: true,
    };
    let projects = new.db.list_projects(&ctx, &admin, None, 10).await.unwrap();
    assert_eq!(projects.items.len(), 1);
    assert_eq!(projects.items[0].repositories.len(), 1);
    // Finished domains are not read again at a start.
    let pending = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::Pending)
        .await
        .unwrap();
    assert!(pending.domains.is_empty());
    let markers = new.db.imports(&ctx).await.unwrap();
    assert_eq!(markers.len(), 13);
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
    assert_eq!(domain(&report, Domain::Providers).imported, 3);
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
    assert!(!markers.contains("synthetic-0003") && !markers.contains(CLAUDE));
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
            Domain::Messages,
            Domain::Memories,
            Domain::Projects,
            Domain::Schedules,
            Domain::Skills,
            Domain::Artifacts
        ]
    );
    // No owner address was given, so the chats wait for one and say so.
    for which in [
        Domain::Agents,
        Domain::Threads,
        Domain::Messages,
        Domain::Memories,
        Domain::Projects,
        Domain::Schedules,
        Domain::Skills,
        Domain::Artifacts,
    ] {
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
            other => panic!("{other:?}"),
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

/// `{broken`, sealed as the old gateway sealed the secret of `provider:` + [`CODEX_ID`] under
/// [`OLD_KEY`]: it opens, and is not the tokens' JSON.
const BROKEN_CODEX: &str = r#"{"iv":"CQkJCQkJCQkJCQkJ","tag":"T4umcnOKlwRJIm1iAF+W5A==","keyId":"local","version":1,"ciphertext":"XOf2+9WVrw=="}"#;

#[tokio::test]
async fn a_chatgpt_sign_in_that_does_not_parse_is_skipped_and_leaves_nothing() {
    let new = TestDb::start(SCRATCH).await;
    let ctx = fresh(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let old = old_server(dir.path()).await;
    let mut connection = sqlx::PgConnection::connect(old.url().expose())
        .await
        .unwrap();
    sqlx::query("UPDATE gateway_secrets SET envelope = $1::text::jsonb WHERE name = $2")
        .bind(BROKEN_CODEX)
        .bind(format!("provider:{CODEX_ID}"))
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let source = Source::Postgres(old.url().clone());
    let opts = options(dir.path(), None, Some(keys(OLD_KEY)));

    let report = Importer::new(&new.db, &ctx, &opts)
        .run(&source, Scope::All)
        .await
        .unwrap();

    // The other two accounts come; this one is a row with a reason and nothing else.
    let providers = domain(&report, Domain::Providers);
    assert_eq!((providers.imported, providers.failed), (2, 1));
    let detail = providers.detail.clone().unwrap();
    assert!(
        detail.contains(CODEX_ID) && detail.contains("not readable"),
        "{detail}"
    );
    assert!(!detail.contains("broken"), "{detail}");
    let ids: Vec<String> = new
        .db
        .provider_accounts(&ctx)
        .await
        .unwrap()
        .into_iter()
        .map(|account| account.id)
        .collect();
    assert_eq!(ids, [GROQ_ID, CLAUDE_ID]);
    let owner = format!("provider:{CODEX_ID}");
    assert!(new.db.vault().read(&ctx, &owner).await.unwrap().is_none());
    new.stop().await;
    old.stop().await.unwrap();
}

async fn memories_and_projects_came_over(
    db: &Database,
    ctx: &TenantCtx,
    report: &ImportReport,
    owner: &jian_store::AccountId,
) {
    let viewer = Viewer {
        account: owner.clone(),
        admin: true,
    };
    let agent = db.list_agents(ctx, &viewer, None, 10).await.unwrap().items[0]
        .id
        .clone();
    let page = db
        .list_memories(
            ctx,
            &agent,
            &jian_store::MemoryQuery {
                scope: jian_store::RecallScope::Everything,
                search: None,
                after: None,
                limit: 10,
            },
            1_900_000_000_000,
        )
        .await
        .unwrap();
    let keys: Vec<&str> = page.items.iter().map(|m| m.key.as_str()).collect();
    assert_eq!(keys, ["likes-tea", "trip"]);
    assert_eq!(page.items[0].origin.kind.as_str(), "imported");
    assert_eq!(page.items[0].content, "Prefers green tea.");
    assert!(page.items[1].expires_at.is_some());
    let links = db
        .memory_links(ctx, &agent, "likes-tea", 1_900_000_000_000)
        .await
        .unwrap();
    assert_eq!(links, ["trip"]);
    // Why two were left out is in the marker; the link between memories and projects is listed
    // as not imported, since the core has no place for it.
    let detail = domain(report, Domain::Memories).detail.clone().unwrap();
    assert!(detail.contains("2 left out"), "{detail}");
    assert!(detail.contains("had ended") && detail.contains("key the core does not accept"));
    let left: Vec<&str> = report
        .not_imported
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert!(left.contains(&"memory_projects") && !left.contains(&"memories"));
    // The old repository is an attachment now, and the project is the workspace's, as it was.
    let projects = db
        .list_projects(ctx, &viewer, None, 10)
        .await
        .unwrap()
        .items;
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].name, "Synthetic site");
    let urls: Vec<&str> = projects[0]
        .repositories
        .iter()
        .map(|r| r.url.as_str())
        .collect();
    assert_eq!(urls, ["https://example.test/synthetic/site"]);
    assert_eq!(projects[0].visibility, jian_core::Visibility::Workspace);
    assert_eq!(&projects[0].created_by, owner);

    // Schedules: the daily one is worked out from now and keeps its chat; the one far ahead stays
    // on; the one that already ran comes over off; the one every minute is left out, and says why.
    let schedules = db
        .list_schedules(ctx, &agent, None, 10)
        .await
        .unwrap()
        .items;
    let names: Vec<&str> = schedules.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Already done", "Morning note", "Far ahead"]);
    assert!(schedules[1].enabled && schedules[1].next_run_at.is_some());
    assert_eq!(schedules[1].time_zone, "America/Sao_Paulo");
    assert!(schedules[1].thread_id.is_some() && &schedules[1].created_by == owner);
    assert!(schedules[2].enabled && schedules[2].next_run_at.is_some());
    assert!(!schedules[0].enabled && schedules[0].next_run_at.is_none());
    assert!(schedules[0].last_run_at.is_some());
    let detail = domain(report, Domain::Schedules).detail.clone().unwrap();
    assert!(
        detail.contains("1 left out") && detail.contains("too frequent"),
        "{detail}"
    );
}

async fn skills_came_over(
    db: &Database,
    ctx: &TenantCtx,
    report: &ImportReport,
    owner: &jian_store::AccountId,
) {
    let viewer = Viewer {
        account: owner.clone(),
        admin: true,
    };
    let names: Vec<String> = db
        .list_skills(ctx)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    // Once each, however many runs: the second run of the test found them already there.
    assert_eq!(names, ["brief-writer", "night-owl"]);
    let brief = db.skill(ctx, "brief-writer").await.unwrap().unwrap();
    assert_eq!(brief.text.license.as_deref(), Some("MIT"));
    assert_eq!(&brief.created_by, owner);
    assert_eq!(brief.created_at, "2026-11-20T10:00:00.000Z");
    // What was switched off in the old setting stays off for the agent; the rest is on.
    let agent = db.list_agents(ctx, &viewer, None, 10).await.unwrap().items[0]
        .id
        .clone();
    let on: Vec<String> = db
        .agent_skills(ctx, &agent)
        .await
        .unwrap()
        .library
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(on, ["brief-writer"]);
    let detail = domain(report, Domain::Skills).detail.clone().unwrap();
    assert!(
        detail.contains("1 left out") && detail.contains("name the core does not accept"),
        "{detail}"
    );
}

async fn artifacts_came_over(
    db: &Database,
    ctx: &TenantCtx,
    report: &ImportReport,
    owner: &jian_store::AccountId,
) {
    let viewer = Viewer {
        account: owner.clone(),
        admin: true,
    };
    let actor = ArtifactActor::Member(&viewer);
    // A folder and a markdown artifact; the whiteboard and the picture are counted, not failed.
    let detail = domain(report, Domain::Artifacts).detail.clone().unwrap();
    assert!(
        detail.contains("2 left out") && detail.contains("a whiteboard or a picture"),
        "{detail}"
    );
    let all = db
        .list_artifacts(ctx, actor, &ArtifactFilter::default(), None, 10)
        .await
        .unwrap()
        .items;
    // Once, however many runs: the second run of the test found it already there.
    assert_eq!(all.len(), 4);
    let made = all.iter().find(|a| a.title == "Launch plan").unwrap();
    // A private artifact came over as `owner`, with the owner as its owner.
    assert_eq!(made.visibility, ArtifactVisibility::Owner);
    assert_eq!(made.owner.as_ref(), Some(owner));
    // Public ones came over `external`, keeping the address already handed out and, when the
    // old password's hash is one this core checks, the password; one it cannot check became
    // `owner`, never open without it.
    let by_title = |title: &str| all.iter().find(|a| a.title == title).unwrap();
    let open = by_title("Open page");
    assert_eq!(
        (open.visibility, open.has_password),
        (ArtifactVisibility::External, false)
    );
    let link = db
        .public_artifact_link(&"p".repeat(43))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(link.artifact, open.id);
    let locked = by_title("Locked page");
    assert_eq!(
        (locked.visibility, locked.has_password),
        (ArtifactVisibility::External, true)
    );
    let link = db
        .public_artifact_link(&"q".repeat(43))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(link.artifact, locked.id);
    let odd = by_title("Odd lock");
    assert_eq!(
        (odd.visibility, odd.has_password),
        (ArtifactVisibility::Owner, false)
    );
    assert!(
        db.public_artifact_link(&"r".repeat(43))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        (made.kind, made.title.as_str(), made.pinned),
        (jian_core::ArtifactKind::Markdown, "Launch plan", true)
    );
    assert_eq!(made.created_at, "2026-11-25T18:31:00.000Z");
    // Linked to the thread of its session, the project and the folder it was filed in.
    assert!(made.thread.is_some() && made.project.is_some() && made.folder.is_some());
    let agent = db.list_agents(ctx, &viewer, None, 10).await.unwrap().items[0]
        .id
        .clone();
    assert_eq!(made.created_by, ArtifactAuthor::Agent(agent.clone()));
    // The old numbers had a gap (1, 3); the versions count from 1 with none skipped, and a
    // version a person saved is the owner's.
    let versions = db
        .artifact_versions(ctx, actor, &made.id)
        .await
        .unwrap()
        .unwrap();
    let seen: Vec<(i32, ArtifactAuthor)> = versions
        .into_iter()
        .map(|v| (v.version, v.author))
        .collect();
    assert_eq!(
        seen,
        [
            (1, ArtifactAuthor::Agent(agent)),
            (2, ArtifactAuthor::Member(owner.clone()))
        ]
    );
    assert_eq!(made.version, 2);
    let latest = db
        .artifact_version(ctx, actor, &made.id, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest.content, "# Launch plan");
    let folders = db.list_artifact_folders(ctx).await.unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "Drafts");
}
