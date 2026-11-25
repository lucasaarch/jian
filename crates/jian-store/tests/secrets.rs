//! Secrets at rest against a real Postgres: round trips, what a copied envelope does, rotation,
//! concurrent refreshes, and what a dump of the whole database shows.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jian_store::secrets::{Dek, LocalKeyring, MasterKeys, RefreshError, Secret};
use jian_store::{Database, Migrations, StoreError};
use sqlx::PgPool;
use support::{Server, exec, id, migrator, platform_migrator, tenant};

const MARKER: &str = "sk-test-PLAINTEXT-MARKER";
const NAMES: [&str; 3] = ["alpha", "beta", "gamma"];

fn encoded(byte: u8) -> String {
    STANDARD.encode([byte; 32])
}

/// A keyring of synthetic keys: each id is filled with one byte value.
fn ring(keys: &[(&str, u8)], active: &str) -> Arc<LocalKeyring> {
    let list: std::collections::BTreeMap<_, _> = keys
        .iter()
        .map(|(name, byte)| (*name, encoded(*byte)))
        .collect();
    let json = serde_json::to_string(&list).unwrap();
    Arc::new(LocalKeyring::from_json(&json, Some(active)).unwrap())
}

async fn database(server: &Server, keys: Arc<LocalKeyring>) -> Database {
    let db = server.connect().await.with_master_keys(keys);
    db.migrate().await.unwrap();
    db
}

/// A connection as the database's own user, to look at the tables the way a dump would.
async fn raw(server: &Server) -> PgPool {
    PgPool::connect(server.url.expose()).await.unwrap()
}

async fn stored_envelopes(pool: &PgPool, tenant: &str) -> Vec<(String, Vec<u8>)> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT owner, envelope FROM tenant_{tenant}.secrets ORDER BY owner"
    )))
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn all_envelopes(pool: &PgPool) -> Vec<Vec<(String, Vec<u8>)>> {
    let mut all = Vec::new();
    for name in NAMES {
        all.push(stored_envelopes(pool, name).await);
    }
    all
}

async fn stored_keys(pool: &PgPool) -> Vec<(String, String, Vec<u8>)> {
    sqlx::query_as(
        "SELECT tenant_id, master_key_id, wrapped_dek FROM platform.tenant_keys ORDER BY tenant_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn read_text(db: &Database, ctx: &jian_store::TenantCtx, owner: &str) -> String {
    db.vault()
        .read(ctx, owner)
        .await
        .unwrap()
        .unwrap()
        .expose()
        .to_owned()
}

#[tokio::test]
async fn a_secret_round_trips_is_replaced_and_discarded() {
    let server = Server::start().await;
    let db = database(&server, ring(&[("k1", 1)], "k1")).await;
    let alpha = tenant(&db, "alpha").await;
    let vault = db.vault();

    assert!(
        vault
            .read(&alpha, "provider:openai")
            .await
            .unwrap()
            .is_none()
    );
    let secret = Secret::new(MARKER);
    vault.put(&alpha, "provider:openai", &secret).await.unwrap();
    assert_eq!(read_text(&db, &alpha, "provider:openai").await, MARKER);
    assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");

    // The same text stored twice is two different envelopes: the nonce is new every time.
    let pool = raw(&server).await;
    let first = stored_envelopes(&pool, "alpha").await;
    vault.put(&alpha, "provider:openai", &secret).await.unwrap();
    let second = stored_envelopes(&pool, "alpha").await;
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].1, second[0].1);
    vault
        .put(&alpha, "provider:openai", &Secret::new("replaced"))
        .await
        .unwrap();
    assert_eq!(read_text(&db, &alpha, "provider:openai").await, "replaced");

    assert!(vault.discard(&alpha, "provider:openai").await.unwrap());
    assert!(!vault.discard(&alpha, "provider:openai").await.unwrap());
    assert!(
        vault
            .read(&alpha, "provider:openai")
            .await
            .unwrap()
            .is_none()
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_envelope_copied_to_another_row_or_tenant_does_not_decrypt() {
    let server = Server::start().await;
    let db = database(&server, ring(&[("k1", 1)], "k1")).await;
    let alpha = tenant(&db, "alpha").await;
    let beta = tenant(&db, "beta").await;
    let vault = db.vault();
    vault
        .put(&alpha, "provider:a", &Secret::new(MARKER))
        .await
        .unwrap();
    vault
        .put(&beta, "provider:a", &Secret::new("beta"))
        .await
        .unwrap();

    // Same tenant, other owner: the data key is the same, so only the owner bound into the tag
    // stops it.
    exec(
        &db,
        &alpha,
        "INSERT INTO secrets (owner, envelope) SELECT 'provider:b', envelope FROM secrets \
         WHERE owner = 'provider:a'",
    )
    .await;
    let error = vault.read(&alpha, "provider:b").await.unwrap_err();
    assert!(matches!(error, StoreError::Decrypt { .. }), "{error}");

    // Other tenant, as an operator with full database access would copy it.
    let pool = raw(&server).await;
    sqlx::query(
        "UPDATE tenant_beta.secrets SET envelope = \
         (SELECT envelope FROM tenant_alpha.secrets WHERE owner = 'provider:a')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let error = vault.read(&beta, "provider:a").await.unwrap_err();
    assert!(matches!(error, StoreError::Decrypt { .. }), "{error}");
    assert_eq!(read_text(&db, &alpha, "provider:a").await, MARKER);

    // A wrapped data key moved to another tenant's row does not unwrap either.
    sqlx::query(
        "UPDATE platform.tenant_keys SET wrapped_dek = \
         (SELECT wrapped_dek FROM platform.tenant_keys WHERE tenant_id = 'alpha') \
         WHERE tenant_id = 'beta'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let cold = server
        .connect()
        .await
        .with_master_keys(ring(&[("k1", 1)], "k1"));
    let error = cold.vault().read(&beta, "provider:a").await.unwrap_err();
    assert!(matches!(error, StoreError::Decrypt { .. }), "{error}");
    cold.close().await.unwrap();
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn rotating_the_master_key_rewraps_the_data_keys_and_leaves_the_secrets_alone() {
    let server = Server::start().await;
    let db = database(&server, ring(&[("k1", 1)], "k1")).await;
    let mut contexts = Vec::new();
    for name in NAMES {
        let ctx = tenant(&db, name).await;
        let secret = Secret::new(format!("{MARKER}-{name}"));
        db.vault()
            .put(&ctx, "provider:openai", &secret)
            .await
            .unwrap();
        contexts.push(ctx);
    }
    let pool = raw(&server).await;
    let envelopes_before = all_envelopes(&pool).await;
    assert!(stored_keys(&pool).await.iter().all(|key| key.1 == "k1"));
    db.close().await.unwrap();

    // The new key is made active; the old one stays in the keyring until the rotation ends.
    let db = server
        .connect()
        .await
        .with_master_keys(ring(&[("k1", 1), ("k2", 2)], "k2"));
    let report = db.rotate_master_keys().await.unwrap();
    assert_eq!((report.rewrapped, report.already_current), (3, 0));
    let rotated = stored_keys(&pool).await;
    assert!(rotated.iter().all(|key| key.1 == "k2"));
    for (ctx, name) in contexts.iter().zip(NAMES) {
        assert_eq!(
            read_text(&db, ctx, "provider:openai").await,
            format!("{MARKER}-{name}")
        );
    }
    // The envelopes are byte for byte what they were.
    assert_eq!(envelopes_before, all_envelopes(&pool).await);

    // Running it again is a no-op: nothing is rewrapped and the stored keys do not change.
    let again = db.rotate_master_keys().await.unwrap();
    assert_eq!((again.rewrapped, again.already_current), (0, 3));
    assert_eq!(rotated, stored_keys(&pool).await);
    db.close().await.unwrap();

    // With the old key gone from the keyring, a cold start still reads everything.
    let db = server
        .connect()
        .await
        .with_master_keys(ring(&[("k2", 2)], "k2"));
    for (ctx, name) in contexts.iter().zip(NAMES) {
        assert_eq!(
            read_text(&db, ctx, "provider:openai").await,
            format!("{MARKER}-{name}")
        );
    }
    db.close().await.unwrap();

    // A keyring that lacks the key a data key needs says which one.
    let db = server
        .connect()
        .await
        .with_master_keys(ring(&[("k3", 3)], "k3"));
    let error = db
        .vault()
        .read(&contexts[0], "provider:openai")
        .await
        .unwrap_err();
    assert!(
        matches!(error, StoreError::UnknownMasterKey(ref id) if id == "k2"),
        "{error}"
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn two_refreshes_of_one_secret_take_turns() {
    let server = Server::start().await;
    let db = database(&server, ring(&[("k1", 1)], "k1")).await;
    let alpha = tenant(&db, "alpha").await;
    let vault = db.vault();
    vault
        .put(&alpha, "mcp:calendar", &Secret::new("t"))
        .await
        .unwrap();

    let append = |suffix: &'static str| {
        let alpha = alpha.clone();
        let db = &db;
        async move {
            db.vault()
                .refresh(&alpha, "mcp:calendar", |current| async move {
                    // A token request takes time; without the row lock both would read "t".
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let next = format!("{}{suffix}", current.expose());
                    Ok::<_, std::convert::Infallible>(Secret::new(next))
                })
                .await
        }
    };
    let (first, second) = tokio::join!(append("+a"), append("+b"));
    assert!(first.unwrap() && second.unwrap());
    let result = read_text(&db, &alpha, "mcp:calendar").await;
    assert!(
        result == "t+a+b" || result == "t+b+a",
        "one refresh overwrote the other: {result}"
    );

    // A failing transform leaves the secret as it was; a missing secret is not an error.
    let failed = vault
        .refresh(&alpha, "mcp:calendar", |_| async {
            Err::<Secret, _>("denied")
        })
        .await;
    assert!(matches!(failed, Err(RefreshError::Transform("denied"))));
    assert_eq!(read_text(&db, &alpha, "mcp:calendar").await, result);
    let missing = vault
        .refresh(&alpha, "mcp:none", |current| async {
            Ok::<_, String>(current)
        })
        .await
        .unwrap();
    assert!(!missing);
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_dump_of_every_table_shows_no_secret_and_no_data_key() {
    let server = Server::start().await;
    let keys = ring(&[("k1", 1)], "k1");
    let db = database(&server, Arc::clone(&keys)).await;
    for name in ["alpha", "beta"] {
        let ctx = tenant(&db, name).await;
        for owner in ["provider:openai", "channel:telegram"] {
            db.vault()
                .put(&ctx, owner, &Secret::new(MARKER))
                .await
                .unwrap();
        }
    }
    let pool = raw(&server).await;

    // Every table of `platform` and of every tenant schema, each row as Postgres prints it.
    let tables: Vec<(String, String)> = sqlx::query_as(
        "SELECT table_schema::text, table_name::text FROM information_schema.tables \
         WHERE table_type = 'BASE TABLE' \
         AND (table_schema = 'platform' OR table_schema LIKE 'tenant\\_%')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut dump = String::new();
    for (schema, table) in &tables {
        let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT t::text FROM \"{schema}\".\"{table}\" t"
        )))
        .fetch_all(&pool)
        .await
        .unwrap();
        dump.push_str(&rows.join("\n"));
        dump.push('\n');
    }
    // The dump is not vacuous: the rows are in it, as ciphertext.
    assert!(tables.iter().any(|(_, table)| table == "tenant_keys"));
    assert!(dump.contains("provider:openai") && dump.contains("channel:telegram"));

    let hex = |bytes: &[u8]| {
        bytes.iter().fold(String::new(), |mut text, byte| {
            write!(text, "{byte:02x}").unwrap();
            text
        })
    };
    let mut forbidden = vec![
        MARKER.to_owned(),
        hex(MARKER.as_bytes()),
        STANDARD.encode(MARKER),
        hex(&[1u8; 32]),
        encoded(1),
    ];
    for (tenant_id, key_id, wrapped) in stored_keys(&pool).await {
        let context = format!("jian:dek:{tenant_id}");
        let dek = keys
            .unwrap(&key_id, &wrapped, context.as_bytes())
            .await
            .unwrap();
        forbidden.push(hex(dek.expose()));
        forbidden.push(STANDARD.encode(dek.expose()));
    }
    for needle in forbidden {
        assert!(!dump.contains(&needle), "the dump shows {needle}");
    }
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_from_before_secrets_gets_its_key_with_its_first_secret_and_loses_it_when_deleted()
{
    let server = Server::start().await;
    // The release before this one: the tenant has migration 1 only, and the gateway has no keys.
    // The file as shipped: a migration with another checksum would be refused as edited.
    let first = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/tenant/0001_init.sql"
    ))
    .unwrap();
    let old = server.connect().await.with_migrations(Migrations::new(
        platform_migrator().await,
        migrator(server.dir.path(), "v1", &[("0001_init.sql", &first)]).await,
    ));
    old.migrate().await.unwrap();
    tenant(&old, "alpha").await;
    let pool = raw(&server).await;
    assert!(stored_keys(&pool).await.is_empty());
    old.close().await.unwrap();

    // The new build without master keys migrates the tenant but cannot store a secret.
    let keyless = server.connect().await;
    keyless.migrate().await.unwrap();
    let ctx = keyless.tenant(id("alpha")).await.unwrap();
    let error = keyless
        .vault()
        .put(&ctx, "provider:openai", &Secret::new(MARKER))
        .await;
    assert!(matches!(error, Err(StoreError::NoMasterKeys)));
    keyless.close().await.unwrap();

    // With master keys it does, and the tenant gets its data key then.
    let db = database(&server, ring(&[("k1", 1)], "k1")).await;
    let alpha = db.tenant(id("alpha")).await.unwrap();
    let secret = Secret::new(MARKER);
    db.vault()
        .put(&alpha, "provider:openai", &secret)
        .await
        .unwrap();
    assert_eq!(stored_keys(&pool).await.len(), 1);
    assert_eq!(read_text(&db, &alpha, "provider:openai").await, MARKER);

    // A tenant made now has its key from the start, and loses it when it is deleted.
    let beta = tenant(&db, "beta").await;
    assert_eq!(stored_keys(&pool).await.len(), 2);
    db.vault()
        .put(&beta, "provider:openai", &secret)
        .await
        .unwrap();
    db.delete_tenant(&id("beta")).await.unwrap();
    let left: Vec<_> = stored_keys(&pool)
        .await
        .into_iter()
        .map(|key| key.0)
        .collect();
    assert_eq!(left, ["alpha"]);
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn the_master_key_comes_from_either_format_or_a_file_and_a_bad_one_says_why() {
    // The server's list, with the active id.
    let json = format!(r#"{{"old":"{}","new":"{}"}}"#, encoded(7), encoded(8));
    let keyring = LocalKeyring::from_json(&json, Some("new")).unwrap();
    assert_eq!(keyring.active_key_id(), "new");
    assert_eq!(keyring.key_ids(), ["new", "old"]);
    // Several keys and no active id is ambiguous; one key needs no id.
    for active in [None, Some("missing")] {
        let error = LocalKeyring::from_json(&json, active).unwrap_err();
        assert!(matches!(error, StoreError::InvalidMasterKey(_)), "{error}");
    }
    let one = format!(r#"{{"only":"{}"}}"#, encoded(7));
    let only = LocalKeyring::from_json(&one, None).unwrap();
    assert_eq!(only.active_key_id(), "only");

    // The desktop's single key.
    let desktop = LocalKeyring::from_single(&encoded(9)).unwrap();
    assert_eq!(desktop.active_key_id(), "local");

    // Wrong length, not base64, not JSON: an error that names the problem, never the key.
    let short = STANDARD.encode([5u8; 16]);
    let error = LocalKeyring::from_single(&short).unwrap_err();
    assert!(error.to_string().contains("16 bytes, not 32"), "{error}");
    assert!(!error.to_string().contains(&short));
    assert!(LocalKeyring::from_single("not base64 !!").is_err());
    assert!(LocalKeyring::from_json("[1, 2]", Some("a")).is_err());

    // A generated file: made once, private, and the same key on the next start.
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path().join("nested").join("master.key");
    let (first, created) = LocalKeyring::load_or_create(&path).unwrap();
    assert!(created);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let (second, created) = LocalKeyring::load_or_create(&path).unwrap();
    assert!(!created);
    let dek = Dek::generate().unwrap();
    let wrapped = first.wrap(&dek, b"ctx").await.unwrap();
    assert_eq!(wrapped.key_id, "local");
    let back = second
        .unwrap(&wrapped.key_id, &wrapped.bytes, b"ctx")
        .await
        .unwrap();
    assert_eq!(back.expose(), dek.expose());
    // The context is bound in: another tenant's context does not unwrap it.
    assert!(
        second
            .unwrap(&wrapped.key_id, &wrapped.bytes, b"other")
            .await
            .is_err()
    );

    // A damaged file is refused, not replaced: replacing it would lose the secrets.
    std::fs::write(&path, "garbage").unwrap();
    let error = LocalKeyring::load_or_create(&path).unwrap_err();
    assert!(matches!(error, StoreError::InvalidMasterKey(_)), "{error}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "garbage");
}

#[test]
fn an_envelope_of_the_node_jian_decrypts_with_its_old_key_and_profile() {
    // Made with node:crypto, key bytes 1..=32, AAD `jian:secret:profile-7:provider:openai`.
    const ENVELOPE: &str = r#"{"version":1,"keyId":"k1","iv":"AAECAwQFBgcICQoL","ciphertext":"Alss462uFSZDbvUAJ8Ha22jb6NA=","tag":"ivB39QBE/0llTAbx8WqZXQ=="}"#;
    let key = STANDARD.encode((1..=32).collect::<Vec<u8>>());
    let json = format!(r#"{{"k1":"{key}"}}"#);
    let keyring = LocalKeyring::from_json(&json, Some("k1")).unwrap();
    let secret = keyring
        .decrypt_legacy("profile-7", "provider:openai", ENVELOPE)
        .unwrap();
    assert_eq!(secret.expose(), "sk-test-LEGACY-VALUE");
    // Another profile or owner is another AAD.
    for (profile, owner) in [
        ("profile-8", "provider:openai"),
        ("profile-7", "provider:x"),
    ] {
        assert!(keyring.decrypt_legacy(profile, owner, ENVELOPE).is_err());
    }
    // A keyring without the key the envelope names.
    let other = ring(&[("z", 1)], "z");
    assert!(matches!(
        other.decrypt_legacy("profile-7", "provider:openai", ENVELOPE),
        Err(StoreError::UnknownMasterKey(_))
    ));
}
