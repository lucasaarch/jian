//! A Telegram bot's token comes over with its channel, and only then: the account the hub
//! connects on its own when it has one, `needs_pairing` and waiting when it has none.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use jian_import::{ImportOptions, ImportReport, Importer, Scope, Source};
use jian_store::secrets::{LocalKeyring, Secret};
use jian_store::{ChannelAccount, ChannelStatus, Database, TenantCtx, TenantId};
use jian_testkit::TestDb;

const SCRATCH: &str = env!("CARGO_TARGET_TMPDIR");
const DUMP: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/old-desktop.sql"
);
/// 32 bytes of 0x07, the synthetic key the fixture was sealed with.
const OLD_KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const PROFILE: &str = "11111111-1111-4111-8111-111111111111";
/// The fixture's Telegram channel. Its sealed secret in the dump is named after no channel id,
/// so the test puts the token where the `secrets` domain would have left it.
const CHANNEL: &str = "64444444-4444-4444-8444-444444444444";
const TOKEN: &str = "123456:synthetic-bot-token-for-import";
const REPLACED: &str = "654321:synthetic-token-the-owner-swapped-in";

fn options(dir: &Path, keys: Option<LocalKeyring>) -> ImportOptions {
    ImportOptions {
        owner_email: Some("owner@example.test".to_owned()),
        keys,
        scratch_dir: dir.join("scratch"),
    }
}

fn old_keys() -> LocalKeyring {
    LocalKeyring::for_reading_legacy(&serde_json::json!({ "local": OLD_KEY }).to_string()).unwrap()
}

async fn fresh(db: &Database) -> TenantCtx {
    let id = TenantId::parse(&format!("token{}", jian_testkit::unique())).unwrap();
    db.create_tenant(&id).await.unwrap();
    db.tenant(id).await.unwrap()
}

async fn run(db: &Database, ctx: &TenantCtx, opts: &ImportOptions) -> ImportReport {
    let source = Source::parse(DUMP).unwrap();
    Importer::new(db, ctx, opts)
        .run(&source, Scope::All)
        .await
        .unwrap()
}

async fn account(db: &Database, ctx: &TenantCtx, provider: &str) -> ChannelAccount {
    let agent = db.agent_of_legacy(ctx, PROFILE).await.unwrap().unwrap();
    db.channel_accounts_of(ctx, &agent)
        .await
        .unwrap()
        .into_iter()
        .find(|account| account.provider == provider)
        .unwrap()
}

async fn token_of(db: &Database, ctx: &TenantCtx, account: &ChannelAccount) -> Option<String> {
    let bytes = db.channel_session(ctx, &account.id, "token").await.unwrap();
    bytes.map(|bytes| String::from_utf8(bytes).unwrap())
}

#[tokio::test]
async fn the_token_comes_with_its_account_and_a_later_run_leaves_what_the_owner_did() {
    let new = TestDb::start(SCRATCH).await;
    let ctx = fresh(&new.db).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();
    let opts = options(dir.path(), Some(old_keys()));
    new.db
        .vault()
        .put(
            &ctx,
            &format!("profile:{PROFILE}:channel:{CHANNEL}"),
            &Secret::new(TOKEN),
        )
        .await
        .unwrap();

    let first = run(&new.db, &ctx, &opts).await;
    let telegram = account(&new.db, &ctx, "telegram").await;
    assert_eq!(
        token_of(&new.db, &ctx, &telegram).await.as_deref(),
        Some(TOKEN)
    );
    // The same state an account made with a token is in: the hub's timer picks it up, and only
    // it (the WhatsApp account has no session to resume).
    assert_eq!(telegram.status, ChannelStatus::NeedsPairing);
    let to_connect = new.db.channel_accounts_to_connect(&ctx).await.unwrap();
    let ids: Vec<&str> = to_connect.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, [telegram.id.as_str()]);
    let whatsapp = account(&new.db, &ctx, "whatsapp").await;
    assert_eq!(token_of(&new.db, &ctx, &whatsapp).await, None);
    // What the person is shown never holds it.
    let shown = format!("{first:?} {:?}", new.db.imports(&ctx).await.unwrap());
    assert!(!shown.contains(TOKEN), "{shown}");

    // The owner swapped the token; running the import again does not bring the old one back.
    new.db
        .put_channel_session(&ctx, &telegram.id, "token", REPLACED.as_bytes())
        .await
        .unwrap();
    let second = run(&new.db, &ctx, &opts).await;
    assert_eq!(
        token_of(&new.db, &ctx, &telegram).await.as_deref(),
        Some(REPLACED)
    );
    // Nor after a log out wiped it.
    new.db
        .clear_channel_session(&ctx, &telegram.id)
        .await
        .unwrap();
    run(&new.db, &ctx, &opts).await;
    assert_eq!(token_of(&new.db, &ctx, &telegram).await, None);
    assert!(!format!("{second:?}").contains(TOKEN));
    new.stop().await;
}

#[tokio::test]
async fn without_the_master_key_or_the_token_the_account_waits_to_be_paired() {
    let new = TestDb::start(SCRATCH).await;
    let dir = tempfile::tempdir_in(SCRATCH).unwrap();

    // No master key: the secrets domain is skipped, so the vault holds no token.
    let no_key = fresh(&new.db).await;
    run(&new.db, &no_key, &options(dir.path(), None)).await;
    let waiting = account(&new.db, &no_key, "telegram").await;
    assert_eq!(waiting.status, ChannelStatus::NeedsPairing);
    assert_eq!(token_of(&new.db, &no_key, &waiting).await, None);
    assert!(
        new.db
            .channel_accounts_to_connect(&no_key)
            .await
            .unwrap()
            .is_empty()
    );

    // The key, but nothing in the old vault for this channel.
    let no_token = fresh(&new.db).await;
    run(&new.db, &no_token, &options(dir.path(), Some(old_keys()))).await;
    let waiting = account(&new.db, &no_token, "telegram").await;
    assert_eq!(token_of(&new.db, &no_token, &waiting).await, None);
    assert!(
        new.db
            .channel_accounts_to_connect(&no_token)
            .await
            .unwrap()
            .is_empty()
    );
    new.stop().await;
}
