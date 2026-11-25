//! Which instance serves a tenant: two gateways on one database, a tenant that belongs to the
//! other, an instance that dies, one that drains.

use std::time::Duration;

use jian_protocol::client::{CLIENT_PATH, CLOSE_RECONNECT, ClientRequest, ClientResponse};
use jian_protocol::machine::CONNECT_PATH;
use jian_server::Settings;
use jian_store::{SLOT_COUNT, SlotId, SlotOptions, TenantId, slot_of};
use tokio::time::Instant;

use super::support::{Client, Gateway, RawWorker, closed_with, dial};

/// How long a test waits for something that must happen.
const WAIT: Duration = Duration::from_secs(20);

/// Short leases so a death is noticed in a second, with room to renew several times in one.
const FAST: SlotOptions = SlotOptions {
    lease: Duration::from_millis(1500),
    renew_every: Duration::from_millis(100),
    release_batch: 256,
};

/// A lease no test outlasts: only a release can explain a slot changing hands within it.
const LONG: SlotOptions = SlotOptions {
    lease: Duration::from_secs(60),
    renew_every: Duration::from_millis(100),
    release_batch: 256,
};

/// Polls until `done`, failing when it takes longer than `limit`.
async fn eventually(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < limit, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn slots() -> impl Iterator<Item = SlotId> {
    (0..SLOT_COUNT).filter_map(SlotId::new)
}

/// Two gateways that have settled: every slot is served by exactly one of them.
async fn pair(options: SlotOptions) -> (Gateway, Gateway) {
    let first = Gateway::start_with(Settings::default(), options).await;
    let second = first.join(Settings::default(), options).await;
    let (a, b) = (first.slots(), second.slots());
    eventually("an even split", WAIT, || {
        a.count() == 512 && b.count() == 512
    })
    .await;
    for slot in slots() {
        assert_ne!(a.owns_slot(slot), b.owns_slot(slot), "slot {slot}");
    }
    (first, second)
}

/// The first tenant name, in a sequence, that `wanted` accepts by its slot.
fn tenant_where(wanted: impl Fn(SlotId) -> bool) -> TenantId {
    (0..100_000)
        .filter_map(|number| TenantId::parse(&format!("t{number}")).ok())
        .find(|tenant| wanted(slot_of(tenant)))
        .unwrap()
}

#[tokio::test]
async fn a_socket_of_a_tenant_another_instance_serves_is_told_to_reconnect() {
    let (first, second) = pair(FAST).await;
    let (a, b) = (first.slots(), second.slots());
    let mine = tenant_where(|slot| a.owns_slot(slot));
    let theirs = tenant_where(|slot| b.owns_slot(slot));
    let (mine_token, _) = first.tenant(mine.as_str()).await;
    let (theirs_token, _) = first.tenant(theirs.as_str()).await;

    // The client's socket: the owner is served, the other is sent away with the code.
    Client::open(first.addr, &mine_token).await;
    Client::open(second.addr, &theirs_token).await;
    let mut wrong = dial(second.addr, CLIENT_PATH, Some(&mine_token))
        .await
        .unwrap();
    assert_eq!(closed_with(&mut wrong).await, Some(CLOSE_RECONNECT));

    // The worker's socket too, before it has said a word.
    let mut client = Client::open(first.addr, &mine_token).await;
    let ClientResponse::MachineToken { token, .. } = client
        .call(ClientRequest::IssueMachine { name: "box".into() })
        .await
        .unwrap()
    else {
        panic!("expected a machine token");
    };
    RawWorker::welcomed(first.addr, &token, &["shell"]).await;
    let mut wrong = dial(second.addr, CONNECT_PATH, Some(&token)).await.unwrap();
    assert_eq!(closed_with(&mut wrong).await, Some(CLOSE_RECONNECT));

    second.stop().await;
    first.stop().await;
}

#[tokio::test]
async fn a_connection_is_told_to_reconnect_when_its_slot_moves_to_a_new_instance() {
    let first = Gateway::start_with(Settings::default(), FAST).await;
    // Alone it serves everything, and hands back the highest slots first when another arrives.
    let moving = tenant_where(|slot| slot.get() >= 900);
    let (token, _) = first.tenant(moving.as_str()).await;
    let mut client = Client::open(first.addr, &token).await;
    assert!(first.slots().owns(&moving));

    let second = first.join(Settings::default(), FAST).await;
    assert_eq!(closed_with(&mut client.socket).await, Some(CLOSE_RECONNECT));
    assert!(!first.slots().owns(&moving));
    eventually("the slot to be served by the new instance", WAIT, || {
        second.slots().owns(&moving)
    })
    .await;

    second.stop().await;
    first.stop().await;
}

#[tokio::test]
async fn an_instance_that_dies_hands_over_without_a_moment_of_two_owners() {
    let (mut first, second) = pair(FAST).await;
    let (a, b) = (first.slots(), second.slots());
    // The epoch of every slot b serves, to see that the ones it takes from a are new ones.
    let tenant = tenant_where(|slot| a.owns_slot(slot));
    let before = first.db.slot_rows().await.unwrap();

    first.crash();
    let started = Instant::now();
    // Looked at every few milliseconds, all slots each time: a slot served by both, or by
    // neither for good, fails here.
    loop {
        for slot in slots() {
            assert!(
                !(a.owns_slot(slot) && b.owns_slot(slot)),
                "slot {slot} is served by both instances"
            );
        }
        if b.count() == usize::from(SLOT_COUNT) {
            break;
        }
        assert!(started.elapsed() < WAIT, "b never took over: {}", b.count());
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(a.count(), 0, "the dead instance still serves slots");
    assert!(b.owns(&tenant));
    // What changed hands has a higher epoch than before: the old owner is fenced.
    let after = second.db.slot_rows().await.unwrap();
    for (was, now) in before.iter().zip(&after) {
        assert!(now.live && now.epoch >= was.epoch, "slot {}", now.slot);
        if was.owner != now.owner {
            assert!(now.epoch > was.epoch, "slot {}", now.slot);
        }
    }

    second.stop().await;
    first.stop().await;
}

#[tokio::test]
async fn a_draining_instance_gives_its_slots_without_waiting_for_the_leases() {
    let (mut first, second) = pair(LONG).await;
    let (a, b) = (first.slots(), second.slots());
    let mine = tenant_where(|slot| a.owns_slot(slot));
    let (token, _) = first.tenant(mine.as_str()).await;
    let mut client = Client::open(first.addr, &token).await;

    first.begin_drain().await;
    // Serving stops at once, and the open socket is sent to reconnect.
    assert_eq!(a.count(), 0);
    assert_eq!(closed_with(&mut client.socket).await, Some(CLOSE_RECONNECT));
    assert!(
        !a.owns(&mine) && !b.owns(&mine),
        "the slot is in between owners"
    );

    let started = Instant::now();
    let report = first.finish_drain().await;
    assert_eq!((report.released, report.requeued), (512, 0));
    eventually("b to take every slot", WAIT, || {
        b.count() == usize::from(SLOT_COUNT)
    })
    .await;
    // The lease was a minute long.
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(b.owns(&mine));
    let rows = second.db.slot_rows().await.unwrap();
    assert!(rows.iter().all(|row| row.live && row.owner.is_some()));

    // A drained instance takes nothing back and refuses new sockets.
    let mut late = dial(first.addr, CLIENT_PATH, Some(&token)).await.unwrap();
    assert_eq!(closed_with(&mut late).await, Some(CLOSE_RECONNECT));

    second.stop().await;
    first.stop().await;
}
