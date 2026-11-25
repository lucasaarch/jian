//! Tokens, machines and devices against a real Postgres: which tenant a token opens, that revoking
//! and rotating cut access at once, that one tenant cannot touch another's, and that the old
//! gateway's hashes keep working after an import.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_store::{
    Authenticated, DeviceId, ImportOutcome, LegacyDevice, LegacyMachine, MachineId, MachineReport,
    StoreError, Subject, TokenHash, TokenKind, generate_token,
};
use support::{Server, tenant};

async fn migrated(server: &Server) -> jian_store::Database {
    let db = server.connect().await;
    db.migrate().await.unwrap();
    db
}

async fn who(db: &jian_store::Database, token: &str) -> Option<Authenticated> {
    db.authenticate(token).await.unwrap()
}

#[test]
fn a_token_is_hashed_as_the_node_gateway_does_and_a_foreign_hash_must_be_hex() {
    // SHA-256 of "abc", the standard test vector.
    assert_eq!(
        TokenHash::of("abc").as_str(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let upper = TokenHash::of("abc").as_str().to_uppercase();
    assert_eq!(TokenHash::parse(&upper).unwrap(), TokenHash::of("abc"));
    for bad in ["", "abc", &"g".repeat(64), &"a".repeat(65)] {
        assert!(matches!(
            TokenHash::parse(bad),
            Err(StoreError::InvalidTokenHash)
        ));
    }
    let token = generate_token(TokenKind::Machine).unwrap();
    assert!(token.expose().starts_with("jrm_"));
    assert!(token.expose().len() >= 40);
    assert_ne!(
        token.expose(),
        generate_token(TokenKind::Machine).unwrap().expose()
    );
    assert_eq!(format!("{token:?}"), "Secret(<redacted>)");
}

#[tokio::test]
async fn a_token_opens_its_own_tenant_and_nothing_else() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let (machine_a, token_a) = db.issue_machine(&a, "laptop").await.unwrap();
    let (machine_b, token_b) = db.issue_machine(&b, "laptop").await.unwrap();

    let found = who(&db, token_a.expose()).await.unwrap();
    assert_eq!(found.tenant.as_str(), "alpha");
    assert_eq!(
        found.subject,
        Subject::Machine(MachineId::new(machine_a.id.clone()))
    );
    assert_eq!(
        who(&db, token_b.expose()).await.unwrap().tenant.as_str(),
        "beta"
    );

    // Alpha's context cannot read, rotate or revoke beta's machine, by its id.
    let beta_id = MachineId::new(machine_b.id.clone());
    assert!(db.machine(&a, &beta_id).await.unwrap().is_none());
    assert!(
        db.rotate_machine_token(&a, &beta_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(db.revoke_machine(&a, &beta_id).await.unwrap().is_none());
    assert!(who(&db, token_b.expose()).await.is_some());
    assert_eq!(
        db.list_machines(&a, None, 10).await.unwrap().items,
        [machine_a]
    );
    assert_eq!(
        db.list_machines(&b, None, 10).await.unwrap().items,
        [machine_b]
    );

    // Unknown, empty and enormous tokens are nobody.
    assert!(who(&db, "jrm_not-a-token").await.is_none());
    assert!(who(&db, "").await.is_none());
    assert!(who(&db, &"x".repeat(10_000)).await.is_none());
    server.stop().await;
}

#[tokio::test]
async fn revoking_and_rotating_cut_the_old_token_at_once() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let ctx = tenant(&db, "alpha").await;
    let (machine, first) = db.issue_machine(&ctx, "laptop").await.unwrap();
    let id = MachineId::new(machine.id.clone());
    let active = who(&db, first.expose()).await.unwrap().token;
    assert!(db.token_is_active(&active).await.unwrap());

    let (_, second) = db.rotate_machine_token(&ctx, &id).await.unwrap().unwrap();
    assert!(
        who(&db, first.expose()).await.is_none(),
        "the old token is dead"
    );
    assert!(!db.token_is_active(&active).await.unwrap());
    assert!(who(&db, second.expose()).await.is_some());

    let revoked = db.revoke_machine(&ctx, &id).await.unwrap().unwrap();
    assert!(revoked.revoked);
    assert!(who(&db, second.expose()).await.is_none());
    // Revoking again is not an error, and the machine stays in the list as revoked.
    assert!(db.revoke_machine(&ctx, &id).await.unwrap().is_some());
    assert!(db.list_machines(&ctx, None, 10).await.unwrap().items[0].revoked);
    // A hello does not bring a revoked machine back.
    let report = MachineReport::default();
    assert!(
        db.record_machine_hello(&ctx, &id, &report)
            .await
            .unwrap()
            .is_none()
    );

    // Rotating pairs it again.
    let (again, third) = db.rotate_machine_token(&ctx, &id).await.unwrap().unwrap();
    assert!(!again.revoked);
    assert!(who(&db, third.expose()).await.is_some());
    server.stop().await;
}

#[tokio::test]
async fn a_hello_is_stored_and_clipped_and_pages_follow_a_cursor() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let ctx = tenant(&db, "alpha").await;
    let mut ids = Vec::new();
    for name in ["one", "two", "three"] {
        ids.push(db.issue_machine(&ctx, name).await.unwrap().0);
    }
    let report = MachineReport {
        os: "linux".into(),
        arch: "x86_64".into(),
        hostname: "h".repeat(1000),
        system: "Ubuntu".into(),
        worker_version: "1.2.3".into(),
        capabilities: vec!["shell".into(); 100],
    };
    let seen = db
        .record_machine_hello(&ctx, &MachineId::new(ids[0].id.clone()), &report)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(seen.os.as_deref(), Some("linux"));
    assert_eq!(seen.hostname.unwrap().chars().count(), 200);
    assert_eq!(seen.capabilities.len(), 32);
    assert!(seen.last_seen_at.unwrap().ends_with('Z'));

    let first = db.list_machines(&ctx, None, 2).await.unwrap();
    assert_eq!(first.items.len(), 2);
    let rest = db.list_machines(&ctx, first.next, 2).await.unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.items[0].name, "three");
    assert_eq!(rest.next, None);

    assert!(matches!(
        db.issue_machine(&ctx, "  ").await,
        Err(StoreError::InvalidName(_))
    ));
    server.stop().await;
}

#[tokio::test]
async fn the_owner_token_is_set_once_and_replaced_not_added() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let first = "o".repeat(40);
    let second = "p".repeat(40);

    db.set_owner_token(&a, &first).await.unwrap();
    db.set_owner_token(&a, &first).await.unwrap();
    let found = who(&db, &first).await.unwrap();
    assert_eq!(
        (found.tenant.as_str(), found.subject),
        ("alpha", Subject::Owner)
    );

    db.set_owner_token(&a, &second).await.unwrap();
    assert!(
        who(&db, &first).await.is_none(),
        "the old owner token is revoked"
    );
    assert!(who(&db, &second).await.is_some());
    // Changing back to the first value revives it and kills the second.
    db.set_owner_token(&a, &first).await.unwrap();
    assert!(who(&db, &first).await.is_some() && who(&db, &second).await.is_none());

    assert!(matches!(
        db.set_owner_token(&a, "short").await,
        Err(StoreError::OwnerTokenTooShort(_))
    ));
    // Another tenant cannot claim a token that is already someone's.
    assert!(matches!(
        db.set_owner_token(&b, &first).await,
        Err(StoreError::TokenInUse)
    ));
    assert_eq!(who(&db, &first).await.unwrap().tenant.as_str(), "alpha");
    server.stop().await;
}

#[tokio::test]
async fn an_imported_machine_and_phone_keep_their_old_token() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let ctx = tenant(&db, "alpha").await;
    let machine_token = "legacy-machine-token";
    let device_token = "legacy-device-token";
    let machine = LegacyMachine {
        id: "6f1d1a52-0000-4000-8000-000000000001".into(),
        name: "Studio Mac\u{7}".into(),
        platform: "macos".into(),
        token_hash: TokenHash::of(machine_token).as_str().to_uppercase(),
        capabilities: vec!["shell".into()],
        system: Some("macOS 15.4".into()),
        version: Some("1.0.0".into()),
        created_at: "2026-01-02T03:04:05.000Z".into(),
        last_seen_at: Some("2026-02-03T04:05:06Z".into()),
    }
    .into_import()
    .unwrap();
    let device = LegacyDevice {
        id: "6f1d1a52-0000-4000-8000-000000000002".into(),
        name: "Phone".into(),
        platform: "ios".into(),
        token_hash: TokenHash::of(device_token).as_str().into(),
        created_at: "2026-01-02T03:04:05Z".into(),
        last_seen_at: None,
        revoked_at: Some("2026-03-01T00:00:00Z".into()),
    }
    .into_import()
    .unwrap();

    assert_eq!(
        db.import_machine(&ctx, &machine).await.unwrap(),
        ImportOutcome::Imported
    );
    assert_eq!(
        db.import_device(&ctx, &device).await.unwrap(),
        ImportOutcome::Imported
    );
    // Running the import again changes nothing.
    assert_eq!(
        db.import_machine(&ctx, &machine).await.unwrap(),
        ImportOutcome::AlreadyThere
    );

    let found = who(&db, machine_token).await.unwrap();
    assert_eq!(found.subject.kind(), TokenKind::Machine);
    let imported = db
        .machine(
            &ctx,
            &MachineId::new("6f1d1a52-0000-4000-8000-000000000001"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(imported.name, "Studio Mac");
    assert_eq!(imported.os.as_deref(), Some("macos"));
    assert_eq!(imported.created_at, "2026-01-02T03:04:05.000Z");
    // The phone was revoked in the old gateway and stays so.
    assert!(who(&db, device_token).await.is_none());
    let phone = db
        .device(&ctx, &DeviceId::new("6f1d1a52-0000-4000-8000-000000000002"))
        .await
        .unwrap()
        .unwrap();
    assert!(phone.revoked);

    let bad = LegacyMachine {
        token_hash: "not hex".into(),
        ..legacy_machine()
    };
    assert!(matches!(
        bad.into_import(),
        Err(StoreError::InvalidTokenHash)
    ));
    let no_id = LegacyMachine {
        id: " ".into(),
        ..legacy_machine()
    };
    assert!(matches!(
        no_id.into_import(),
        Err(StoreError::InvalidImport(_))
    ));
    server.stop().await;
}

fn legacy_machine() -> LegacyMachine {
    LegacyMachine {
        id: "m".into(),
        name: "n".into(),
        platform: "linux".into(),
        token_hash: TokenHash::of("x").as_str().into(),
        capabilities: Vec::new(),
        system: None,
        version: None,
        created_at: "2026-01-01T00:00:00Z".into(),
        last_seen_at: None,
    }
}

#[tokio::test]
async fn a_phone_token_is_issued_rotated_and_revoked_within_its_tenant() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let (phone, first) = db.issue_device(&a, "Pixel").await.unwrap();
    assert!(first.expose().starts_with("jd_"));
    let id = DeviceId::new(phone.id);
    assert_eq!(
        who(&db, first.expose()).await.unwrap().subject,
        Subject::Device(id.clone())
    );

    assert!(db.rotate_device_token(&b, &id).await.unwrap().is_none());
    assert!(db.revoke_device(&b, &id).await.unwrap().is_none());
    let (_, second) = db.rotate_device_token(&a, &id).await.unwrap().unwrap();
    assert!(who(&db, first.expose()).await.is_none());
    assert!(db.revoke_device(&a, &id).await.unwrap().unwrap().revoked);
    assert!(who(&db, second.expose()).await.is_none());
    server.stop().await;
}
