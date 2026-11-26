//! Runs against a real Postgres: one active run per thread and agent however many start at
//! once, a run that ended never changes, an approval is answered once and in time, and another
//! tenant reaches none of it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{ThreadKind, Visibility};
use jian_store::{
    Answer, ApprovalState, NewAgent, NewThread, Quotas, RunOrigin, RunState, StoreError, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

async fn thread_and_agent(
    test: &TestDb,
    side: &Side,
) -> (jian_store::ThreadId, jian_store::AgentId) {
    let who = Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    };
    let agent = test
        .db
        .create_agent(
            &side.ctx,
            &who,
            &NewAgent {
                name: "pear".to_owned(),
                description: String::new(),
                instructions: String::new(),
                avatar: None,
                visibility: Visibility::Workspace,
                viewers: Vec::new(),
            },
        )
        .await
        .unwrap()
        .id;
    let thread = test
        .db
        .create_thread(
            &side.ctx,
            &who,
            &NewThread {
                kind: ThreadKind::Dm,
                title: None,
                members: Vec::new(),
                agents: vec![agent.clone()],
            },
        )
        .await
        .unwrap()
        .unwrap()
        .id;
    (thread, agent)
}

#[tokio::test]
async fn a_thread_and_agent_have_one_active_run_whoever_starts_it_and_when() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (thread, agent) = thread_and_agent(&test, &side).await;
    let by = side.admin.account_id.clone();

    let starts = (0..8).map(|n| {
        let (db, ctx, thread, agent, by) = (&test.db, &side.ctx, &thread, &agent, &by);
        async move {
            db.start_run(ctx, thread, agent, Some(by), n, RunOrigin::Message)
                .await
                .unwrap()
        }
    });
    let results = futures_util::future::join_all(starts).await;
    assert_eq!(results.iter().filter(|(_, created)| *created).count(), 1);
    let id = &results[0].0.id;
    assert!(results.iter().all(|(run, _)| &run.id == id));

    // Ended runs are history: the next one starts fresh, and the old one never moves again.
    assert!(test.db.claim_run(&side.ctx, id).await.unwrap());
    assert!(
        test.db
            .set_run_state(&side.ctx, id, RunState::Done, None)
            .await
            .unwrap()
    );
    assert!(
        !test
            .db
            .set_run_state(&side.ctx, id, RunState::Failed, Some("late"))
            .await
            .unwrap()
    );
    let (next, created) = test
        .db
        .start_run(&side.ctx, &thread, &agent, Some(&by), 9, RunOrigin::Message)
        .await
        .unwrap();
    assert!(created && &next.id != id);
    let runs = test.db.list_runs(&side.ctx, &thread, 10).await.unwrap();
    assert_eq!(
        runs.iter().map(|r| r.state).collect::<Vec<_>>(),
        [RunState::Queued, RunState::Done]
    );

    // A run that has not started stops at once; one that has is only asked to.
    let stopped = test
        .db
        .request_run_stop(&side.ctx, &thread, &next.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopped.state, RunState::Stopped);
    test.stop().await;
}

#[tokio::test]
async fn an_approval_is_answered_once_before_it_expires_and_another_tenant_sees_no_run() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let (thread, agent) = thread_and_agent(&test, a).await;
    let by = a.admin.account_id.clone();
    let (run, _) = test
        .db
        .start_run(&a.ctx, &thread, &agent, Some(&by), 1, RunOrigin::Message)
        .await
        .unwrap();

    let ask = |call: &'static str, ttl: i64| {
        test.db
            .create_approval(&a.ctx, &run.id, call, "shell", "{}", 1_000 + ttl)
    };
    let first = ask("c1", 60_000).await.unwrap();
    // Asking again for the same call is the same approval.
    assert_eq!(ask("c1", 60_000).await.unwrap().id, first.id);
    // Only a run parked on its call takes an answer.
    assert!(test.db.claim_run(&a.ctx, &run.id).await.unwrap());
    test.db
        .pause_run(&a.ctx, &run.id, r#"{"callId":"c1"}"#)
        .await
        .unwrap();

    let answer = |approve: bool, now: i64| {
        let answer = Answer {
            approve,
            by: &by,
            reason: None,
        };
        let (db, ctx, thread, run) = (&test.db, &a.ctx, &thread, &run.id);
        async move { db.decide_approval(ctx, thread, run, &answer, now).await }
    };
    assert!(answer(true, 2_000).await.unwrap().is_some());
    assert!(answer(false, 2_000).await.unwrap().is_none());
    let kept = test
        .db
        .approval(&a.ctx, &run.id, "c1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.state, ApprovalState::Approved);

    ask("c2", 10).await.unwrap();
    assert!(answer(true, 5_000).await.unwrap().is_none());
    test.db
        .expire_approval(&a.ctx, &run.id, "c2", 5_000)
        .await
        .unwrap();
    let expired = test
        .db
        .approval(&a.ctx, &run.id, "c2")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(expired.state, ApprovalState::Expired);

    // Tenant B has no such run, cannot stop it and cannot answer its approvals.
    assert!(
        test.db
            .run(&b.ctx, &thread, &run.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(test.db.run_by_id(&b.ctx, &run.id).await.unwrap().is_none());
    assert!(
        test.db
            .request_run_stop(&b.ctx, &thread, &run.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        test.db
            .list_runs(&b.ctx, &thread, 10)
            .await
            .unwrap()
            .is_empty()
    );
    test.stop().await;
}

/// A run of `side` that held a machine for `ms`.
async fn run_with_machine(test: &TestDb, side: &Side, ms: u64) -> String {
    let (thread, agent) = thread_and_agent(test, side).await;
    let (run, _) = test
        .db
        .start_run(&side.ctx, &thread, &agent, None, 1, RunOrigin::Message)
        .await
        .unwrap();
    test.db
        .record_run_machine(&side.ctx, &run.id, ms)
        .await
        .unwrap();
    run.id
}

#[tokio::test]
async fn machine_minutes_sum_the_month_per_tenant_and_refuse_only_past_the_limit() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, a, b) = (&test.db, &tenants.a, &tenants.b);
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let now = i64::try_from(since.as_millis()).unwrap();
    let limit = Quotas {
        machine_minutes: Some(2),
        ..Quotas::default()
    };
    db.set_quotas(&a.ctx, &limit).await.unwrap();
    db.set_quotas(&b.ctx, &limit).await.unwrap();

    // 90 s is under 2 minutes; two runs of it are 3 minutes, over.
    run_with_machine(&test, a, 90_000).await;
    db.check_machine_quota(&a.ctx, now, None).await.unwrap();
    let second = run_with_machine(&test, a, 90_000).await;
    assert_eq!(
        db.machine_ms_this_month(&a.ctx, now, None).await.unwrap(),
        180_000
    );
    assert_eq!(
        db.quota_usage(&a.ctx, now).await.unwrap().machine_minutes,
        3
    );
    assert!(matches!(
        db.check_machine_quota(&a.ctx, now, None).await,
        Err(StoreError::QuotaExceeded(_))
    ));

    // Another month starts at zero; another tenant never saw A's time.
    db.check_machine_quota(&a.ctx, now + 40 * 86_400_000, None)
        .await
        .unwrap();
    db.check_machine_quota(&b.ctx, now, None).await.unwrap();
    assert_eq!(
        db.machine_ms_this_month(&b.ctx, now, None).await.unwrap(),
        0
    );

    // The time a run has held its machine since it last wrote counts, once, not on top of it.
    db.set_quotas(
        &a.ctx,
        &Quotas {
            machine_minutes: Some(4),
            ..Quotas::default()
        },
    )
    .await
    .unwrap();
    db.check_machine_quota(&a.ctx, now, None).await.unwrap();
    assert!(
        db.check_machine_quota(&a.ctx, now, Some((&second, 150_000)))
            .await
            .is_err()
    );
    assert_eq!(
        db.machine_ms_this_month(&a.ctx, now, Some((&second, 150_000)))
            .await
            .unwrap(),
        240_000
    );

    // No limit never refuses, however much was used.
    db.set_quotas(&a.ctx, &Quotas::default()).await.unwrap();
    db.check_machine_quota(&a.ctx, now, Some((&second, 10_000_000_000)))
        .await
        .unwrap();
    test.stop().await;
}
