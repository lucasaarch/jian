//! The job runner against a real Postgres: instances sharing one queue, retries, a crash, a
//! heartbeat and a drain. Each "instance" is its own pool, slot keeper and runner, as a replica
//! would be.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use jian_server::{
    JobContext, JobError, JobHandler, JobOptions, JobRegistry, JobRequeue, JobRunner, SlotKeeper,
};
use jian_store::{
    Database, DatabaseSource, DatabaseUrl, JobId, JobState, NewJob, RetryPolicy, SlotOptions,
    TenantCtx, TenantId,
};
use serde_json::json;

/// A handler written as a closure, so each test says what its jobs do where it is read.
struct Handler<F>(F);

impl<F> JobHandler for Handler<F>
where
    F: Fn(JobContext) -> BoxFuture<'static, Result<(), JobError>> + Send + Sync,
{
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        (self.0)(context)
    }
}

fn handler<F>(run: F) -> Arc<dyn JobHandler>
where
    F: Fn(JobContext) -> BoxFuture<'static, Result<(), JobError>> + Send + Sync + 'static,
{
    Arc::new(Handler(run))
}

fn registry(handler: Arc<dyn JobHandler>) -> JobRegistry {
    JobRegistry::new().register("test.work", handler)
}

/// Short intervals, so a test waits for conditions and not for the production pace.
fn options() -> JobOptions {
    JobOptions {
        concurrency: 4,
        poll_every: Duration::from_millis(40),
        visibility: Duration::from_secs(30),
        retry: RetryPolicy {
            base: Duration::from_millis(30),
            cap: Duration::from_millis(30),
        },
        ..JobOptions::default()
    }
}

fn slot_options() -> SlotOptions {
    SlotOptions {
        lease: Duration::from_secs(3),
        renew_every: Duration::from_millis(150),
        release_batch: 1024,
    }
}

struct Env {
    url: DatabaseUrl,
    home: jian_testkit::TestDatabase,
}

impl Env {
    async fn start() -> Self {
        let home = jian_testkit::TestDatabase::create(env!("CARGO_TARGET_TMPDIR")).await;
        let env = Self {
            url: home.url.clone(),
            home,
        };
        env.db().await.migrate().await.unwrap();
        env
    }

    /// A pool of its own, as each replica has.
    async fn db(&self) -> Arc<Database> {
        Arc::new(
            Database::open(DatabaseSource::External(self.url.clone()))
                .await
                .unwrap()
                .with_master_keys(jian_testkit::master_keys()),
        )
    }

    async fn stop(self) {
        self.home.remove().await;
    }
}

/// Tenant roles belong to the server that all the tests' databases share, so the name gets a
/// random tail: `alpha` in two tests at once would collide.
async fn tenant(db: &Database, name: &str) -> TenantCtx {
    let id = TenantId::parse(&format!("{name}{}", jian_testkit::unique())).unwrap();
    db.create_tenant(&id).await.unwrap();
    db.tenant(id).await.unwrap()
}

async fn eventually<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn state_of(db: &Database, id: &JobId) -> (JobState, i32) {
    let job = db.job(id).await.unwrap().unwrap();
    (job.state, job.attempts)
}

async fn wait_for(db: &Database, id: &JobId, wanted: JobState) -> i32 {
    eventually("the job to reach its state", || async {
        let (state, attempts) = state_of(db, id).await;
        (state == wanted).then_some(attempts)
    })
    .await
}

/// A lone instance: its slots, its runner.
struct Instance {
    db: Arc<Database>,
    keeper: SlotKeeper,
}

impl Instance {
    async fn start(env: &Env) -> Self {
        let db = env.db().await;
        let keeper = SlotKeeper::start(db.clone(), slot_options()).await.unwrap();
        Self { db, keeper }
    }

    async fn runner(&self, registry: JobRegistry, options: JobOptions) -> JobRunner {
        JobRunner::start(
            self.db.clone(),
            self.keeper.instance().clone(),
            self.keeper.ownership(),
            registry,
            options,
        )
        .await
    }

    async fn stop(self) {
        let mut keeper = self.keeper;
        keeper.begin_drain().await;
        keeper
            .finish_drain(&JobRequeue::new(self.db.clone()))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn two_instances_run_every_job_once_and_each_runs_only_its_own_tenants() {
    const JOBS: usize = 200;
    let env = Env::start().await;
    let a = Instance::start(&env).await;
    let b = Instance::start(&env).await;
    let (own_a, own_b) = (a.keeper.ownership(), b.keeper.ownership());
    // The first instance starts with everything and hands half over a round at a time.
    eventually("the slots to be shared", || async {
        (own_a.count() > 0 && own_b.count() > 0 && own_a.count() + own_b.count() == 1024)
            .then_some(())
    })
    .await;

    // Tenants until each instance serves at least two, so both have work whatever the hash does.
    let mut tenants: Vec<TenantCtx> = Vec::new();
    let (mut with_a, mut with_b) = (0, 0);
    let mut number = 0;
    while with_a < 2 || with_b < 2 {
        let ctx = tenant(&a.db, &format!("t{number}")).await;
        number += 1;
        if own_a.owns(ctx.id()) {
            with_a += 1;
        } else if own_b.owns(ctx.id()) {
            with_b += 1;
        }
        tenants.push(ctx);
    }
    let mut ids = Vec::new();
    for n in 0..JOBS {
        let ctx = &tenants[n % tenants.len()];
        let made =
            a.db.enqueue_job(ctx, NewJob::new("test.work", json!({ "n": n })))
                .await
                .unwrap();
        ids.push(made.job.id);
    }

    // Who ran what, as the handler saw it.
    let ran: Arc<Mutex<Vec<(JobId, &'static str)>>> = Arc::default();
    let tagged = |who: &'static str| {
        let ran = ran.clone();
        registry(handler(move |context| {
            let ran = ran.clone();
            Box::pin(async move {
                ran.lock().unwrap().push((context.job.id.clone(), who));
                // Long enough for the two instances' jobs to overlap.
                tokio::time::sleep(Duration::from_millis(3)).await;
                Ok(())
            })
        }))
    };
    let runner_a = a.runner(tagged("a"), options()).await;
    let runner_b = b.runner(tagged("b"), options()).await;

    for id in &ids {
        wait_for(&a.db, id, JobState::Done).await;
    }
    let ran = ran.lock().unwrap().clone();
    assert_eq!(ran.len(), JOBS, "a job ran twice, or not at all");
    let unique: HashSet<_> = ran.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(unique.len(), JOBS);
    let tenant_of: HashMap<JobId, TenantId> = {
        let mut map = HashMap::new();
        for id in &ids {
            map.insert(id.clone(), a.db.job(id).await.unwrap().unwrap().tenant);
        }
        map
    };
    for (id, who) in &ran {
        let tenant = &tenant_of[id];
        let expected = if own_a.owns(tenant) { "a" } else { "b" };
        assert_eq!(
            *who, expected,
            "{tenant}'s job ran on an instance that does not serve it"
        );
    }
    assert!(ran.iter().any(|(_, who)| *who == "a") && ran.iter().any(|(_, who)| *who == "b"));

    let until = Instant::now() + Duration::from_secs(5);
    assert_eq!(runner_a.shutdown(until).await, 0);
    assert_eq!(runner_b.shutdown(until).await, 0);
    a.stop().await;
    b.stop().await;
    env.stop().await;
}

#[tokio::test]
async fn a_failing_handler_is_retried_then_dies_and_a_permanent_error_dies_at_once() {
    let env = Env::start().await;
    let instance = Instance::start(&env).await;
    let ctx = tenant(&instance.db, "alpha").await;

    // Fails twice, passes the third time; `kind` of the payload picks the behaviour.
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let runner = instance
        .runner(
            registry(handler(move |context| {
                counted.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    match context.job.payload["mode"].as_str() {
                        Some("flaky") if context.job.attempts < 3 => {
                            Err(JobError::retry("provider timed out"))
                        }
                        Some("flaky") => Ok(()),
                        Some("always") => Err(JobError::retry("still down")),
                        _ => Err(JobError::permanent("payload has no meaning")),
                    }
                })
            })),
            options(),
        )
        .await;
    let enqueue = |mode: &'static str, attempts: u8| {
        let db = instance.db.clone();
        let ctx = ctx.clone();
        async move {
            db.enqueue_job(
                &ctx,
                NewJob::new("test.work", json!({ "mode": mode })).max_attempts(attempts),
            )
            .await
            .unwrap()
            .job
            .id
        }
    };

    let flaky = enqueue("flaky", 5).await;
    assert_eq!(wait_for(&instance.db, &flaky, JobState::Done).await, 3);

    let always = enqueue("always", 2).await;
    assert_eq!(wait_for(&instance.db, &always, JobState::Dead).await, 2);
    let dead = instance.db.job(&always).await.unwrap().unwrap();
    assert_eq!(dead.last_error.as_deref(), Some("still down"));

    let permanent = enqueue("meaningless", 5).await;
    assert_eq!(wait_for(&instance.db, &permanent, JobState::Dead).await, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 3 + 2 + 1);

    runner
        .shutdown(Instant::now() + Duration::from_secs(5))
        .await;
    instance.stop().await;
    env.stop().await;
}

#[tokio::test]
async fn a_job_of_a_runner_that_died_runs_again_and_a_slow_handler_is_kept_by_its_heartbeat() {
    let env = Env::start().await;
    let instance = Instance::start(&env).await;
    let ctx = tenant(&instance.db, "alpha").await;
    let short = JobOptions {
        // A beat every 100 ms against a 300 ms deadline.
        visibility: Duration::from_millis(300),
        ..options()
    };

    // A handler that outlives its deadline four times over is not taken away while it beats,
    // even though the same runner reaps expired jobs on every poll.
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let slow = instance
        .runner(
            registry(handler(move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    Ok(())
                })
            })),
            short,
        )
        .await;
    let long = instance
        .db
        .enqueue_job(&ctx, NewJob::new("test.work", json!({})))
        .await
        .unwrap()
        .job
        .id;
    assert_eq!(wait_for(&instance.db, &long, JobState::Done).await, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    slow.shutdown(Instant::now() + Duration::from_secs(5)).await;

    // The runner "dies" with a job in its hands: nothing is recorded, nothing beats.
    let started = Arc::new(AtomicUsize::new(0));
    let begun = started.clone();
    let doomed = instance
        .runner(
            registry(handler(move |_| {
                begun.fetch_add(1, Ordering::SeqCst);
                Box::pin(std::future::pending())
            })),
            short,
        )
        .await;
    let lost = instance
        .db
        .enqueue_job(&ctx, NewJob::new("test.work", json!({})))
        .await
        .unwrap()
        .job
        .id;
    eventually("the first attempt to start", || async {
        (started.load(Ordering::SeqCst) == 1).then_some(())
    })
    .await;
    drop(doomed);
    assert_eq!(state_of(&instance.db, &lost).await.0, JobState::Running);

    // Another runner finds the job once the deadline passes.
    let finished = Arc::new(AtomicUsize::new(0));
    let done = finished.clone();
    let rescuer = instance
        .runner(
            registry(handler(move |_| {
                done.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            })),
            short,
        )
        .await;
    assert_eq!(wait_for(&instance.db, &lost, JobState::Done).await, 2);
    assert_eq!(finished.load(Ordering::SeqCst), 1);
    assert_eq!(started.load(Ordering::SeqCst), 1);
    rescuer
        .shutdown(Instant::now() + Duration::from_secs(5))
        .await;
    instance.stop().await;
    env.stop().await;
}

#[tokio::test]
async fn a_drain_lets_a_quick_job_finish_and_hands_back_the_one_it_had_to_stop() {
    let env = Env::start().await;
    let instance = Instance::start(&env).await;
    let ctx = tenant(&instance.db, "alpha").await;
    let started = Arc::new(AtomicUsize::new(0));
    let begun = started.clone();
    let runner = instance
        .runner(
            registry(handler(move |context| {
                begun.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if context.job.payload["quick"] == json!(true) {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        Ok(())
                    } else {
                        std::future::pending().await
                    }
                })
            })),
            options(),
        )
        .await;
    let make = |quick: bool| {
        let db = instance.db.clone();
        let ctx = ctx.clone();
        async move {
            db.enqueue_job(&ctx, NewJob::new("test.work", json!({ "quick": quick })))
                .await
                .unwrap()
                .job
                .id
        }
    };
    let quick = make(true).await;
    let stuck = make(false).await;
    eventually("both to start", || async {
        (started.load(Ordering::SeqCst) == 2).then_some(())
    })
    .await;

    // The same steps as the binary's SIGTERM: stop taking, wait, stop what is left, hand back,
    // release the leases.
    let mut keeper = instance.keeper;
    keeper.begin_drain().await;
    let later = make(true).await;
    let aborted = runner
        .shutdown(Instant::now() + Duration::from_secs(1))
        .await;
    assert_eq!(aborted, 1, "only the job that does not end is stopped");
    let report = keeper
        .finish_drain(&JobRequeue::new(instance.db.clone()))
        .await
        .unwrap();
    assert_eq!(report.requeued, 1);

    assert_eq!(state_of(&instance.db, &quick).await, (JobState::Done, 1));
    // Back in the queue, free to run at once, and the attempt it was stopped in is not spent.
    assert_eq!(state_of(&instance.db, &stuck).await, (JobState::Queued, 0));
    // Nothing is taken after the drain began.
    assert_eq!(state_of(&instance.db, &later).await, (JobState::Queued, 0));
    assert_eq!(started.load(Ordering::SeqCst), 2);
    env.stop().await;
}

/// What a handler saw of the world while it ran one job.
struct Seen {
    job_tenant: TenantId,
    context_tenant: TenantId,
    machines: Vec<String>,
    foreign_machine_found: bool,
    secret: Option<String>,
}

#[tokio::test]
async fn a_job_runs_as_its_own_tenant_and_a_handler_sees_nothing_of_another() {
    let env = Env::start().await;
    let instance = Instance::start(&env).await;
    let tenants = jian_testkit::TwoTenants::seed(&instance.db).await;
    let ids = [tenants.a.machine_id(), tenants.b.machine_id()];

    // What each run found, by the tenant its job belongs to.
    let seen: Arc<Mutex<HashMap<TenantId, Seen>>> = Arc::default();
    let recorder = seen.clone();
    let probe = handler(move |context| {
        let (recorder, ids) = (recorder.clone(), ids.clone());
        Box::pin(async move {
            let (ctx, db) = (&context.tenant, &context.db);
            let page = db.list_machines(ctx, None, 100).await.unwrap();
            // The machine that is not this tenant's.
            let foreign = ids
                .iter()
                .find(|id| page.items.iter().all(|m| m.id != id.as_str()))
                .unwrap();
            let found = Seen {
                job_tenant: context.job.tenant.clone(),
                context_tenant: ctx.id().clone(),
                machines: page.items.iter().map(|m| m.id.clone()).collect(),
                foreign_machine_found: db.machine(ctx, foreign).await.unwrap().is_some(),
                secret: db
                    .vault()
                    .read(ctx, jian_testkit::SECRET_OWNER)
                    .await
                    .unwrap()
                    .map(|s| s.expose().to_owned()),
            };
            recorder
                .lock()
                .unwrap()
                .insert(context.job.tenant.clone(), found);
            Ok(())
        })
    });
    let runner = instance
        .runner(
            JobRegistry::new().register(jian_testkit::JOB_KIND, probe),
            options(),
        )
        .await;
    for side in [&tenants.a, &tenants.b] {
        wait_for(&instance.db, &side.job.id, JobState::Done).await;
    }

    let seen = std::mem::take(&mut *seen.lock().unwrap());
    for (own, other) in tenants.crossings() {
        let saw = &seen[&own.id];
        assert_eq!(saw.job_tenant, own.id);
        assert_eq!(
            saw.context_tenant, own.id,
            "the handler got another context"
        );
        assert_eq!(saw.machines, vec![own.machine.id.clone()]);
        assert!(
            !saw.foreign_machine_found,
            "{}'s handler read {}'s machine",
            own.id, other.id
        );
        assert_eq!(saw.secret.as_deref(), Some(own.secret_text.as_str()));
    }

    let until = Instant::now() + Duration::from_secs(5);
    assert_eq!(runner.shutdown(until).await, 0);
    instance.stop().await;
    env.stop().await;
}

#[tokio::test]
async fn a_handler_that_panics_fails_its_own_job_and_another_tenants_job_still_runs() {
    let env = Env::start().await;
    let instance = Instance::start(&env).await;
    let bad = tenant(&instance.db, "bad").await;
    let good = tenant(&instance.db, "good").await;

    let runner = instance
        .runner(
            registry(handler(|context| {
                Box::pin(async move {
                    assert!(
                        context.job.payload["boom"].as_bool() != Some(true),
                        "a handler bug"
                    );
                    Ok(())
                })
            })),
            // One place: if the panic leaked it, the next job could never start.
            JobOptions {
                concurrency: 1,
                ..options()
            },
        )
        .await;
    let enqueue = |ctx: &TenantCtx, boom: bool| {
        let (db, ctx) = (instance.db.clone(), ctx.clone());
        async move {
            db.enqueue_job(&ctx, NewJob::new("test.work", json!({ "boom": boom })))
                .await
                .unwrap()
                .job
                .id
        }
    };
    let panicking = enqueue(&bad, true).await;
    let fine = enqueue(&good, false).await;

    wait_for(&instance.db, &panicking, JobState::Dead).await;
    wait_for(&instance.db, &fine, JobState::Done).await;
    let dead = instance.db.job(&panicking).await.unwrap().unwrap();
    assert_eq!(dead.last_error.as_deref(), Some("the handler panicked"));

    runner
        .shutdown(Instant::now() + Duration::from_secs(5))
        .await;
    instance.stop().await;
    env.stop().await;
}
