//! The job queue against a real Postgres: who may take a job, what an answer does to it, and what
//! happens to a job whose instance goes away. Two instances here are two pools on one database.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jian_store::{
    Database, Failure, HeldSlot, InstanceId, Job, JobState, NewJob, RetryPolicy, SlotOptions,
    StoreError, slot_of,
};
use serde_json::json;
use support::{Server, id, tenant};

const VISIBLE: Duration = Duration::from_secs(60);
const FAST: RetryPolicy = RetryPolicy {
    base: Duration::from_millis(150),
    cap: Duration::from_millis(150),
};

fn kinds() -> Vec<String> {
    vec!["test.echo".to_owned()]
}

fn echo() -> NewJob {
    NewJob::new("test.echo", json!({ "item": "i1" }))
}

async fn migrated(server: &Server) -> Database {
    let db = server.connect().await;
    db.migrate().await.unwrap();
    db
}

/// An instance that holds every slot, as a lone gateway does.
async fn instance(db: &Database) -> (InstanceId, Vec<HeldSlot>) {
    let me = InstanceId::generate().unwrap();
    let claim = db.claim_slots(&me, &SlotOptions::default()).await.unwrap();
    (me, claim.held)
}

/// Waits for `check` to produce something, with a deadline instead of a fixed sleep.
async fn eventually<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn claim_one(db: &Database, me: &InstanceId, held: &[HeldSlot]) -> Option<Job> {
    db.claim_jobs(me, held, &kinds(), 1, VISIBLE)
        .await
        .unwrap()
        .pop()
}

/// The next job, once its backoff or delay has passed.
async fn claim_when_ready(db: &Database, me: &InstanceId, held: &[HeldSlot]) -> Job {
    eventually("a job to be ready", || claim_one(db, me, held)).await
}

/// The next job once its deadline passed, reaping the dead instance's jobs while waiting.
async fn claim_after_reap(db: &Database, me: &InstanceId, held: &[HeldSlot]) -> Job {
    eventually("the deadline to pass", || async {
        db.reap_expired_jobs().await.unwrap();
        claim_one(db, me, held).await
    })
    .await
}

#[tokio::test]
async fn the_same_key_is_one_job_and_a_bad_kind_or_key_is_refused() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let beta = tenant(&db, "beta").await;

    let first = db
        .enqueue_job(&alpha, echo().idempotent("m1"))
        .await
        .unwrap();
    let again = db
        .enqueue_job(&alpha, echo().idempotent("m1"))
        .await
        .unwrap();
    assert!(first.created && !again.created);
    assert_eq!(first.job.id, again.job.id);
    assert_eq!(first.job.slot, slot_of(&id("alpha")));
    assert_eq!(first.job.state, JobState::Queued);
    // The key belongs to a tenant and a kind: the same text elsewhere is another job.
    let other_tenant = db
        .enqueue_job(&beta, echo().idempotent("m1"))
        .await
        .unwrap();
    let other_kind = db
        .enqueue_job(
            &alpha,
            NewJob::new("test.other", json!({})).idempotent("m1"),
        )
        .await
        .unwrap();
    assert!(other_tenant.created && other_kind.created);
    // Without a key, every call is a job.
    assert!(db.enqueue_job(&alpha, echo()).await.unwrap().created);
    assert!(db.enqueue_job(&alpha, echo()).await.unwrap().created);

    for bad in [
        NewJob::new("", json!({})),
        NewJob::new("Has Space", json!({})),
        NewJob::new(".starts-with-dot", json!({})),
        echo().idempotent(""),
        NewJob::new("test.echo", json!({ "blob": "x".repeat(70_000) })),
    ] {
        let error = db.enqueue_job(&alpha, bad).await.unwrap_err();
        assert!(matches!(error, StoreError::InvalidJob(_)), "{error}");
    }
    // A job of a tenant that is deleted goes with it.
    db.delete_tenant(&id("beta")).await.unwrap();
    assert!(db.job(&other_tenant.job.id).await.unwrap().is_none());
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_instance_takes_only_ready_jobs_of_its_slots_and_kinds() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let (me, held) = instance(&db).await;

    db.enqueue_job(&alpha, echo().delayed(Duration::from_secs(3600)))
        .await
        .unwrap();
    db.enqueue_job(&alpha, NewJob::new("test.unknown", json!({})))
        .await
        .unwrap();
    assert!(
        claim_one(&db, &me, &held).await.is_none(),
        "not ready or no handler"
    );

    let made = db.enqueue_job(&alpha, echo()).await.unwrap().job;
    // A slot the instance does not hold is not its to take.
    let others: Vec<HeldSlot> = held
        .iter()
        .copied()
        .filter(|held| held.slot != made.slot)
        .collect();
    assert!(claim_one(&db, &me, &others).await.is_none());
    assert!(claim_one(&db, &me, &[]).await.is_none());

    let claimed = claim_one(&db, &me, &held).await.unwrap();
    assert_eq!(claimed.id, made.id);
    assert_eq!(claimed.state, JobState::Running);
    assert_eq!(claimed.attempts, 1);
    // The slot's epoch comes with the job: it is the fencing token of the slot.
    let epoch = held
        .iter()
        .find(|held| held.slot == made.slot)
        .unwrap()
        .epoch;
    assert_eq!(claimed.lease_epoch, Some(epoch));
    assert!(
        claim_one(&db, &me, &held).await.is_none(),
        "a running job is not taken again"
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn many_claimers_on_two_instances_never_get_the_same_job() {
    const JOBS: usize = 200;
    let server = Server::start().await;
    let first = Arc::new(migrated(&server).await);
    let second = Arc::new(server.connect().await);
    let alpha = tenant(&first, "alpha").await;
    let (me, held) = instance(&first).await;
    for number in 0..JOBS {
        first
            .enqueue_job(&alpha, NewJob::new("test.echo", json!({ "n": number })))
            .await
            .unwrap();
    }

    let mut claimers = Vec::new();
    for worker in 0..8 {
        // Both pools claim as the same instance would not: two instances, each with its own id.
        let (db, me, held) = if worker % 2 == 0 {
            (first.clone(), me.clone(), held.clone())
        } else {
            (
                second.clone(),
                InstanceId::generate().unwrap(),
                held.clone(),
            )
        };
        claimers.push(tokio::spawn(async move {
            let mut mine = Vec::new();
            loop {
                let batch = db
                    .claim_jobs(&me, &held, &kinds(), 7, VISIBLE)
                    .await
                    .unwrap();
                if batch.is_empty() {
                    return mine;
                }
                mine.extend(batch.into_iter().map(|job| job.id));
            }
        }));
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    for claimer in claimers {
        for job in claimer.await.unwrap() {
            total += 1;
            assert!(seen.insert(job), "a job was given to two claimers");
        }
    }
    assert_eq!((total, seen.len()), (JOBS, JOBS), "no job lost");
    drop(first);
    drop(second);
    server.stop().await;
}

#[tokio::test]
async fn a_failure_retries_with_backoff_then_dies_and_a_permanent_one_dies_at_once() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let (me, held) = instance(&db).await;
    let made = db
        .enqueue_job(&alpha, echo().max_attempts(3))
        .await
        .unwrap()
        .job;

    let long = "boom ".repeat(500);
    let attempt = claim_one(&db, &me, &held).await.unwrap();
    let state = db
        .fail_job(&me, &attempt, Failure::Retry, &long, &FAST)
        .await
        .unwrap();
    assert_eq!(state, Some(JobState::Queued));
    let waiting = db.job(&made.id).await.unwrap().unwrap();
    assert_eq!(
        waiting.last_error.as_deref().map(str::len),
        Some(1000),
        "cut"
    );
    assert!(
        claim_one(&db, &me, &held).await.is_none(),
        "it waits out its backoff"
    );

    // Two failures, then the third attempt is the last: it dies.
    for expected in [2, 3] {
        let attempt = claim_when_ready(&db, &me, &held).await;
        assert_eq!(attempt.attempts, expected);
        let state = db
            .fail_job(&me, &attempt, Failure::Retry, "again", &FAST)
            .await
            .unwrap();
        let wanted = if expected == 3 {
            JobState::Dead
        } else {
            JobState::Queued
        };
        assert_eq!(state, Some(wanted));
    }
    let dead = db.job(&made.id).await.unwrap().unwrap();
    assert_eq!((dead.state, dead.attempts), (JobState::Dead, 3));
    assert!(claim_one(&db, &me, &held).await.is_none());

    let permanent = db.enqueue_job(&alpha, echo()).await.unwrap().job;
    let attempt = claim_one(&db, &me, &held).await.unwrap();
    assert_eq!(attempt.id, permanent.id);
    let state = db
        .fail_job(&me, &attempt, Failure::Permanent, "bad payload", &FAST)
        .await
        .unwrap();
    assert_eq!(state, Some(JobState::Dead));

    // A job that succeeds on the third attempt is done and the cleanup removes it, not the dead.
    let third = db.enqueue_job(&alpha, echo()).await.unwrap().job;
    for _ in 0..2 {
        let attempt = claim_when_ready(&db, &me, &held).await;
        db.fail_job(&me, &attempt, Failure::Retry, "no", &FAST)
            .await
            .unwrap();
    }
    let attempt = claim_when_ready(&db, &me, &held).await;
    assert_eq!(
        (attempt.id.clone(), attempt.attempts),
        (third.id.clone(), 3)
    );
    assert!(db.complete_job(&me, &attempt).await.unwrap());
    assert_eq!(db.purge_done_jobs(Duration::ZERO).await.unwrap(), 1);
    assert!(db.job(&third.id).await.unwrap().is_none());
    assert!(
        db.job(&dead.id).await.unwrap().is_some(),
        "dead jobs stay for inspection"
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_job_of_a_dead_instance_is_taken_after_its_deadline_and_the_late_answer_is_refused() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let (first, held) = instance(&db).await;
    let made = db.enqueue_job(&alpha, echo()).await.unwrap().job;

    // The first instance claims with a short deadline and then "dies": it answers nothing.
    let stuck = db
        .claim_jobs(&first, &held, &kinds(), 1, Duration::from_millis(300))
        .await
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        db.reap_expired_jobs().await.unwrap(),
        0,
        "not before the deadline"
    );

    // The slot lease rebalancing is the slot tests' business: here the second instance simply
    // serves what the first did.
    let second = InstanceId::generate().unwrap();
    let taken = claim_after_reap(&db, &second, &held).await;
    assert_eq!((taken.id.clone(), taken.attempts), (made.id.clone(), 2));

    // The first one wakes up and answers: refused, whichever way it answers.
    assert!(!db.complete_job(&first, &stuck).await.unwrap());
    assert!(
        db.fail_job(&first, &stuck, Failure::Permanent, "late", &FAST)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!db.extend_job(&first, &stuck, VISIBLE).await.unwrap());
    let running = db.job(&made.id).await.unwrap().unwrap();
    assert_eq!(running.state, JobState::Running);
    assert!(db.complete_job(&second, &taken).await.unwrap());
    assert_eq!(
        db.job(&made.id).await.unwrap().unwrap().state,
        JobState::Done
    );
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_instance_that_claims_its_own_expired_job_again_is_fenced_by_the_attempt() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let (me, held) = instance(&db).await;
    db.enqueue_job(&alpha, echo()).await.unwrap();
    let old = db
        .claim_jobs(&me, &held, &kinds(), 1, Duration::from_millis(200))
        .await
        .unwrap()
        .pop()
        .unwrap();
    let new = claim_after_reap(&db, &me, &held).await;
    // Same instance, same job, but not the same attempt: the first attempt's answer is refused.
    assert!(!db.complete_job(&me, &old).await.unwrap());
    assert!(db.extend_job(&me, &new, VISIBLE).await.unwrap());
    assert!(db.complete_job(&me, &new).await.unwrap());
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_expired_last_attempt_is_dead_and_a_drain_gives_the_attempt_back() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let (me, held) = instance(&db).await;

    // A job whose only attempt is lost with its instance is not run a second time.
    let single = db
        .enqueue_job(&alpha, echo().max_attempts(1))
        .await
        .unwrap()
        .job;
    db.claim_jobs(&me, &held, &kinds(), 1, Duration::from_millis(100))
        .await
        .unwrap();
    eventually("the job to be reaped", || async {
        (db.reap_expired_jobs().await.unwrap() == 1).then_some(())
    })
    .await;
    assert_eq!(
        db.job(&single.id).await.unwrap().unwrap().state,
        JobState::Dead
    );

    // A drain hands back what is running, at once and for free.
    let handed = db
        .enqueue_job(&alpha, echo().max_attempts(1))
        .await
        .unwrap()
        .job;
    let running = claim_one(&db, &me, &held).await.unwrap();
    assert_eq!(db.requeue_instance_jobs(&me).await.unwrap(), 1);
    let back = db.job(&handed.id).await.unwrap().unwrap();
    assert_eq!((back.state, back.attempts), (JobState::Queued, 0));
    assert!(
        !db.complete_job(&me, &running).await.unwrap(),
        "the drained attempt is fenced off"
    );
    let again = claim_one(&db, &me, &held).await.unwrap();
    assert_eq!(again.id, handed.id);
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_enqueue_wakes_a_listener_with_the_slot() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let alpha = tenant(&db, "alpha").await;
    let mut wakeups = db.job_wakeups().await.unwrap();
    db.enqueue_job(&alpha, echo()).await.unwrap();
    let slot = tokio::time::timeout(Duration::from_secs(10), wakeups.next())
        .await
        .expect("a wake-up")
        .unwrap();
    assert_eq!(slot, Some(slot_of(&id("alpha"))));
    drop(wakeups);
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_tenant_with_a_long_backlog_does_not_keep_another_tenants_job_waiting() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let busy = tenant(&db, "busy").await;
    let quiet = tenant(&db, "quiet").await;
    // The busy tenant's jobs are all older than the quiet tenant's one.
    for _ in 0..30 {
        db.enqueue_job(&busy, echo()).await.unwrap();
    }
    let late = db.enqueue_job(&quiet, echo()).await.unwrap().job;
    let (me, held) = instance(&db).await;

    // Oldest-first would hand over thirty of the busy tenant's before the quiet one's.
    let first = db
        .claim_jobs(&me, &held, &kinds(), 2, VISIBLE)
        .await
        .unwrap();
    assert!(
        first.iter().any(|job| job.id == late.id),
        "the quiet tenant's job waited behind the backlog"
    );
    // Nothing is lost or taken twice.
    let mut taken = first.len();
    while let Some(job) = claim_one(&db, &me, &held).await {
        assert_ne!(job.id, late.id, "a job was claimed twice");
        taken += 1;
    }
    assert_eq!(taken, 31);
    server.stop().await;
}
