//! Tenant A against tenant B in the store: the same operation from both sides, on the other's
//! data, never reads or changes it. The role is the wall here, so the first test goes under the
//! store's API and asks Postgres directly. Fixture: `jian-testkit`.
//!
//! Already covered elsewhere and not repeated: an envelope copied to another tenant does not
//! decrypt (`secrets.rs`), a tenant's dump holds no other schema (`tenants.rs`), one key in two
//! tenants is two jobs and another instance's late answer is refused (`jobs.rs`).

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use jian_store::secrets::Secret;
use jian_store::{
    Database, InstanceId, Job, MachineReport, NewJob, SlotOptions, StoreError, Subject, TokenHash,
    TokenKind,
};
use jian_testkit::{JOB_KIND, SECRET_OWNER, SHARED_KEY, Side, TestDb, TwoTenants, sql_error_code};

/// 42501: the error Postgres gives for a missing privilege.
const DENIED: &str = "42501";
/// 42P01: a schema the role has no `USAGE` on is skipped in the search path, so a bare table name
/// in it is "not found" rather than "denied". Either way the data is out of reach.
const OUT_OF_REACH: [&str; 2] = [DENIED, "42P01"];

async fn start() -> (TestDb, TwoTenants) {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    (test, tenants)
}

async fn who(db: &Database, token: &str) -> Option<(String, Subject)> {
    db.authenticate(token)
        .await
        .unwrap()
        .map(|found| (found.tenant.to_string(), found.subject))
}

#[tokio::test]
async fn a_tenants_role_is_denied_every_table_of_another_tenant_and_of_the_platform() {
    let (test, tenants) = start().await;
    let db = &test.db;
    for (actor, victim) in tenants.crossings() {
        let schema = victim.schema();
        for table in ["machines", "devices", "secrets"] {
            for sql in [
                format!("SELECT * FROM {schema}.{table}"),
                format!("DELETE FROM {schema}.{table}"),
                format!("UPDATE {schema}.{table} SET created_at = now()"),
            ] {
                let code = sql_error_code(db, &actor.ctx, None, &sql).await;
                assert_eq!(code.as_deref(), Some(DENIED), "{} -> {sql}", actor.id);
            }
            // Pointing the search path at the victim does not help a bare table name.
            let pointed = format!("SET LOCAL search_path TO {schema}");
            let code = sql_error_code(
                db,
                &actor.ctx,
                Some(&pointed),
                &format!("SELECT * FROM {table}"),
            )
            .await;
            assert!(
                code.as_deref()
                    .is_some_and(|code| OUT_OF_REACH.contains(&code)),
                "{} -> bare {table} through the victim's search path: {code:?}",
                actor.id
            );
        }
        let code = sql_error_code(
            db,
            &actor.ctx,
            None,
            &format!("CREATE TABLE {schema}.planted (n int)"),
        )
        .await;
        assert_eq!(
            code.as_deref(),
            Some(DENIED),
            "{} planted a table",
            actor.id
        );

        // The platform holds every tenant's token hashes, jobs and wrapped data key.
        for table in ["api_tokens", "jobs", "tenant_keys", "tenants"] {
            let code = sql_error_code(
                db,
                &actor.ctx,
                None,
                &format!("SELECT * FROM platform.{table}"),
            )
            .await;
            assert_eq!(
                code.as_deref(),
                Some(DENIED),
                "{} -> platform.{table}",
                actor.id
            );
        }
    }
    // Nothing above changed anything: both tenants still read their own.
    for side in [&tenants.a, &tenants.b] {
        assert_eq!(
            db.machine(&side.ctx, &side.machine_id()).await.unwrap(),
            Some(side.machine.clone())
        );
        let secret = db.vault().read(&side.ctx, SECRET_OWNER).await.unwrap();
        assert_eq!(secret.unwrap().expose(), side.secret_text);
    }
    test.stop().await;
}

/// What the machine and device look like, to compare before and after an attack.
async fn snapshot(
    db: &Database,
    side: &Side,
) -> (Option<jian_store::Machine>, Option<jian_store::Device>) {
    (
        db.machine(&side.ctx, &side.machine_id()).await.unwrap(),
        db.device(&side.ctx, &side.device_id()).await.unwrap(),
    )
}

#[tokio::test]
async fn the_store_finds_and_changes_nothing_of_another_tenant_by_its_ids() {
    let (test, tenants) = start().await;
    let db = &test.db;
    let report = MachineReport {
        os: "linux".into(),
        arch: "x86_64".into(),
        hostname: "intruder".into(),
        system: "x".into(),
        worker_version: "9".into(),
        capabilities: vec!["shell".into()],
    };
    for (actor, victim) in tenants.crossings() {
        let before = snapshot(db, victim).await;
        let (machine, device) = (victim.machine_id(), victim.device_id());

        assert!(db.machine(&actor.ctx, &machine).await.unwrap().is_none());
        assert!(db.device(&actor.ctx, &device).await.unwrap().is_none());
        assert!(
            db.rotate_machine_token(&actor.ctx, &machine)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.revoke_machine(&actor.ctx, &machine)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.rotate_device_token(&actor.ctx, &device)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.revoke_device(&actor.ctx, &device)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.record_machine_hello(&actor.ctx, &machine, &report)
                .await
                .unwrap()
                .is_none()
        );
        db.touch_machine(&actor.ctx, &machine).await.unwrap();
        db.touch_device(&actor.ctx, &device).await.unwrap();

        // A listing is the actor's own, whatever the page size.
        let page = db.list_machines(&actor.ctx, None, 100).await.unwrap();
        assert_eq!(page.items, std::slice::from_ref(&actor.machine));

        // The victim's rows are as they were: not rotated, revoked, touched or reported over,
        // and its tokens still open it.
        assert_eq!(
            snapshot(db, victim).await,
            before,
            "{} changed {}",
            actor.id,
            victim.id
        );
        for (token, kind) in [
            (&victim.machine_token, TokenKind::Machine),
            (&victim.device_token, TokenKind::Device),
            (&victim.owner_token, TokenKind::Owner),
        ] {
            let (tenant, subject) = who(db, token).await.unwrap();
            assert_eq!((tenant, subject.kind()), (victim.id.to_string(), kind));
        }
    }
    test.stop().await;
}

#[tokio::test]
async fn a_token_opens_only_its_tenant_and_a_revoked_one_opens_nothing_in_the_other() {
    let (test, tenants) = start().await;
    let db = &test.db;
    for side in [&tenants.a, &tenants.b] {
        let (tenant, owner) = who(db, &side.owner_token).await.unwrap();
        assert_eq!((tenant.as_str(), owner), (side.id.as_str(), Subject::Owner));
        let (tenant, machine) = who(db, &side.machine_token).await.unwrap();
        assert_eq!(tenant, side.id.as_str());
        assert_eq!(machine, Subject::Machine(side.machine_id()));
        let (tenant, device) = who(db, &side.device_token).await.unwrap();
        assert_eq!(tenant, side.id.as_str());
        assert_eq!(device, Subject::Device(side.device_id()));
    }

    for (actor, victim) in tenants.crossings() {
        // Claiming the other tenant's owner token for oneself is refused, and neither tenant's
        // token changes for it.
        let error = db
            .set_owner_token(&actor.ctx, &victim.owner_token)
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::TokenInUse), "{error}");
        assert_eq!(
            who(db, &victim.owner_token).await.unwrap().0,
            victim.id.as_str()
        );
        assert_eq!(
            who(db, &actor.owner_token).await.unwrap().0,
            actor.id.as_str()
        );
    }

    // A's machine is revoked: its token is nobody's, B's is untouched.
    let active = TokenHash::of(&tenants.a.machine_token);
    assert!(db.token_is_active(&active).await.unwrap());
    db.revoke_machine(&tenants.a.ctx, &tenants.a.machine_id())
        .await
        .unwrap()
        .unwrap();
    assert!(who(db, &tenants.a.machine_token).await.is_none());
    assert!(!db.token_is_active(&active).await.unwrap());
    assert!(who(db, &tenants.b.machine_token).await.is_some());
    assert!(
        !db.machine(&tenants.b.ctx, &tenants.b.machine_id())
            .await
            .unwrap()
            .unwrap()
            .revoked
    );
    test.stop().await;
}

#[tokio::test]
async fn a_secret_is_read_changed_and_removed_only_by_its_own_tenant() {
    let (test, tenants) = start().await;
    let vault = test.db.vault();
    for (actor, victim) in tenants.crossings() {
        // The same owner name on both sides: each gets its own value, never the other's.
        let read = vault.read(&actor.ctx, SECRET_OWNER).await.unwrap().unwrap();
        assert_eq!(read.expose(), actor.secret_text);
        assert_ne!(read.expose(), victim.secret_text);

        // A name only the victim has is nothing to the actor: not read, not discarded, not
        // refreshed (and the refresh never gets to look at a value).
        let private = format!("provider:only-{}", victim.id);
        vault
            .put(&victim.ctx, &private, &Secret::new("private"))
            .await
            .unwrap();
        assert!(vault.read(&actor.ctx, &private).await.unwrap().is_none());
        assert!(!vault.discard(&actor.ctx, &private).await.unwrap());
        let handed_over = AtomicBool::new(false);
        let refreshed = vault
            .refresh(&actor.ctx, &private, |_| async {
                handed_over.store(true, Ordering::SeqCst);
                Ok::<_, Infallible>(Secret::new("stolen"))
            })
            .await
            .unwrap();
        assert!(
            !handed_over.load(Ordering::SeqCst),
            "the actor was given the victim's secret"
        );
        assert!(!refreshed);
        assert_eq!(
            vault
                .read(&victim.ctx, &private)
                .await
                .unwrap()
                .unwrap()
                .expose(),
            "private"
        );

        // Overwriting or discarding under a shared name touches the actor's own row only.
        vault
            .put(&actor.ctx, SECRET_OWNER, &Secret::new("rotated"))
            .await
            .unwrap();
        assert_eq!(
            vault
                .read(&victim.ctx, SECRET_OWNER)
                .await
                .unwrap()
                .unwrap()
                .expose(),
            victim.secret_text
        );
        vault
            .put(
                &actor.ctx,
                SECRET_OWNER,
                &Secret::new(actor.secret_text.clone()),
            )
            .await
            .unwrap();
    }
    test.stop().await;
}

/// Every job both sides have queued, taken by one instance that holds every slot.
async fn claim_all(db: &Database) -> Vec<Job> {
    let me = InstanceId::generate().unwrap();
    let claim = db.claim_slots(&me, &SlotOptions::default()).await.unwrap();
    db.claim_jobs(
        &me,
        &claim.held,
        &[JOB_KIND.to_owned()],
        100,
        Duration::from_secs(60),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn jobs_carry_their_tenant_and_one_idempotency_key_is_two_jobs() {
    let (test, tenants) = start().await;
    let db = &test.db;
    assert_ne!(tenants.a.job.id, tenants.b.job.id);
    for (actor, victim) in tenants.crossings() {
        // The key is the victim's too; the actor's call finds its own job, not the victim's.
        let again = db
            .enqueue_job(
                &actor.ctx,
                NewJob::new(JOB_KIND, serde_json::json!({})).idempotent(SHARED_KEY),
            )
            .await
            .unwrap();
        assert!(!again.created);
        assert_eq!(again.job.id, actor.job.id);
        assert_ne!(again.job.id, victim.job.id);
        assert_eq!(again.job.tenant, actor.id);
    }
    let claimed = claim_all(db).await;
    assert_eq!(claimed.len(), 2);
    for job in &claimed {
        // What the runner builds the handler's context from is the row's tenant: it must be the
        // tenant whose payload it is.
        assert_eq!(job.payload["of"], job.tenant.as_str());
    }
    test.stop().await;
}

#[tokio::test]
async fn deleting_one_tenant_leaves_the_other_whole() {
    let (test, tenants) = start().await;
    let db = &test.db;
    let (kept, gone) = (&tenants.a, &tenants.b);
    db.delete_tenant(&gone.id).await.unwrap();

    assert!(who(db, &gone.owner_token).await.is_none());
    assert!(who(db, &gone.machine_token).await.is_none());
    assert!(db.job(&gone.job.id).await.unwrap().is_none());
    assert!(matches!(
        db.tenant(gone.id.clone()).await,
        Err(StoreError::TenantNotFound(_))
    ));

    assert_eq!(
        who(db, &kept.owner_token).await.unwrap().0,
        kept.id.as_str()
    );
    assert_eq!(snapshot(db, kept).await.0, Some(kept.machine.clone()));
    assert_eq!(db.job(&kept.job.id).await.unwrap().unwrap().id, kept.job.id);
    let secret = db
        .vault()
        .read(&kept.ctx, SECRET_OWNER)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(secret.expose(), kept.secret_text);
    test.stop().await;
}
