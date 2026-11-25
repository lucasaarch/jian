//! Schedules against a real Postgres: firing is once however many workers try, a repeating
//! schedule that was missed fires once and goes on from now, a one-shot ends, and a change
//! between the queueing and the firing cancels the firing.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{Agent, Fired, NewAgent, NewSchedule, SchedulePatch, StoreError, Viewer, When};
use jian_testkit::{Side, TestDb, TwoTenants};

const MINUTE: i64 = 60_000;
const DAY: i64 = 24 * 60 * MINUTE;
/// 2027-01-05T08:00:00Z, a Tuesday.
const T0: i64 = 1_799_136_000_000;

async fn agent(test: &TestDb, side: &Side) -> Agent {
    test.db
        .create_agent(
            &side.ctx,
            &Viewer {
                account: side.admin.account_id.clone(),
                admin: true,
            },
            &NewAgent {
                name: "clock".to_owned(),
                description: String::new(),
                instructions: String::new(),
                avatar: None,
                visibility: Visibility::Workspace,
                viewers: Vec::new(),
            },
        )
        .await
        .unwrap()
}

fn new(when: When, zone: Option<&str>) -> NewSchedule {
    NewSchedule {
        name: "tick".to_owned(),
        instruction: "do it".to_owned(),
        when,
        time_zone: zone.map(str::to_owned),
        thread: None,
    }
}

#[tokio::test]
async fn many_workers_firing_one_due_time_write_one_event_and_a_one_shot_ends() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(&test, &side).await;
    let made = db
        .create_schedule(
            &side.ctx,
            &side.admin.account_id,
            &a.id,
            &new(When::Once(T0 + 10 * MINUTE), None),
            T0,
        )
        .await
        .unwrap();
    // Not due yet, and a one-shot in the past is refused.
    assert!(
        db.due_schedules(&side.ctx, T0, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let past = db
        .create_schedule(
            &side.ctx,
            &side.admin.account_id,
            &a.id,
            &new(When::Once(T0 - MINUTE), None),
            T0,
        )
        .await;
    assert!(matches!(past, Err(StoreError::InvalidWorkspace(_))));

    let now = T0 + 11 * MINUTE;
    let due = db.due_schedules(&side.ctx, now, 10).await.unwrap();
    assert_eq!((due.len(), due[0].due_ms), (1, T0 + 10 * MINUTE));
    let fired = futures_util::future::join_all(
        (0..5).map(|_| db.fire_schedule(&side.ctx, &made.id, due[0].due_ms, now)),
    )
    .await;
    let yes = fired
        .into_iter()
        .filter(|f| matches!(f, Ok(Fired::Yes)))
        .count();
    assert_eq!(yes, 1);
    let inbox = db.inbox(&side.ctx, &a.id, None, 10).await.unwrap();
    assert_eq!(inbox.items.len(), 1);
    let after = db
        .schedule(&side.ctx, &a.id, &made.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!after.enabled && after.next_run_at.is_none() && after.last_run_at.is_some());
    // A one-shot that has run cannot be turned on again.
    let again = db
        .update_schedule(
            &side.ctx,
            &a.id,
            &made.id,
            &SchedulePatch {
                enabled: Some(true),
                ..SchedulePatch::default()
            },
            now,
        )
        .await;
    assert!(matches!(again, Err(StoreError::InvalidWorkspace(_))));
}

#[tokio::test]
async fn a_missed_repeating_schedule_fires_once_and_goes_on_from_now() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(&test, &side).await;
    // 09:00 in New York is 14:00 UTC in January; T0 is 08:00 UTC, so it is next at 14:00 today.
    let made = db
        .create_schedule(
            &side.ctx,
            &side.admin.account_id,
            &a.id,
            &new(When::Cron("0 9 * * *".to_owned()), Some("America/New_York")),
            T0,
        )
        .await
        .unwrap();
    // The gateway was off for three days.
    let now = T0 + 3 * DAY + 6 * 60 * MINUTE;
    let due = db.due_schedules(&side.ctx, now, 10).await.unwrap();
    assert_eq!(due[0].due_ms, T0 + 6 * 60 * MINUTE);
    assert_eq!(
        db.fire_schedule(&side.ctx, &made.id, due[0].due_ms, now)
            .await
            .unwrap(),
        Fired::Yes
    );
    // One event, not four; and the next time is the one after now, not the next missed one.
    assert_eq!(
        db.inbox(&side.ctx, &a.id, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    let next = db.due_schedules(&side.ctx, now, 10).await.unwrap();
    assert!(next.is_empty());
    let later = db.due_schedules(&side.ctx, now + DAY, 10).await.unwrap();
    assert_eq!(later[0].due_ms, T0 + 4 * DAY + 6 * 60 * MINUTE);
    // A firing queued for the old time does nothing now.
    assert_eq!(
        db.fire_schedule(&side.ctx, &made.id, due[0].due_ms, now)
            .await
            .unwrap(),
        Fired::Stale
    );
    // Turned off between the queueing and the firing: nothing is written.
    db.update_schedule(
        &side.ctx,
        &a.id,
        &made.id,
        &SchedulePatch {
            enabled: Some(false),
            ..SchedulePatch::default()
        },
        now,
    )
    .await
    .unwrap();
    assert_eq!(
        db.fire_schedule(&side.ctx, &made.id, later[0].due_ms, now + DAY)
            .await
            .unwrap(),
        Fired::Stale
    );
    assert_eq!(
        db.inbox(&side.ctx, &a.id, None, 10)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
}

#[tokio::test]
async fn a_cron_that_is_too_frequent_or_has_a_bad_zone_is_refused_and_tenant_b_sees_nothing() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let a = agent(&test, &tenants.a).await;
    for bad in [
        new(When::Cron("* * * * *".to_owned()), None),
        new(When::Cron("0 9 * * *".to_owned()), Some("Mars/Base")),
    ] {
        let got = db
            .create_schedule(&tenants.a.ctx, &tenants.a.admin.account_id, &a.id, &bad, T0)
            .await;
        assert!(matches!(got, Err(StoreError::InvalidWorkspace(_))));
    }
    let made = db
        .create_schedule(
            &tenants.a.ctx,
            &tenants.a.admin.account_id,
            &a.id,
            &new(When::Cron("*/10 * * * *".to_owned()), None),
            T0,
        )
        .await
        .unwrap();
    // Tenant B's schema has no such schedule, agent or event, by id.
    assert!(
        db.schedule(&tenants.b.ctx, &a.id, &made.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.due_schedules(&tenants.b.ctx, T0 + DAY, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.fire_schedule(&tenants.b.ctx, &made.id, T0 + 10 * MINUTE, T0 + DAY)
            .await
            .unwrap(),
        Fired::Stale
    );
    assert!(
        !db.delete_schedule(&tenants.b.ctx, &a.id, &made.id)
            .await
            .unwrap()
    );
    assert_eq!(
        db.due_schedules(&tenants.a.ctx, T0 + DAY, 10)
            .await
            .unwrap()
            .len(),
        1
    );
}
