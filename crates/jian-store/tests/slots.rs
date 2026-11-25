//! Slots against a real Postgres: the hash that places a tenant, and the leases that give each
//! slot one owner. Two instances here are two pools on one database, as two gateways would be.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::HashMap;
use std::time::Duration;

use jian_store::{Database, InstanceId, SLOT_COUNT, SlotOptions, SlotRow, slot_of};
use support::{Server, id};

/// Short enough that waiting for a lease to run out is quick, long enough to renew in time.
const LEASE: Duration = Duration::from_millis(600);

fn options() -> SlotOptions {
    SlotOptions {
        lease: LEASE,
        renew_every: Duration::from_millis(100),
        release_batch: 256,
    }
}

async fn migrated(server: &Server) -> Database {
    let db = server.connect().await;
    db.migrate().await.unwrap();
    db
}

/// How many slots each owner has, counting only leases that still run.
fn shares(rows: &[SlotRow]) -> HashMap<InstanceId, usize> {
    let mut shares = HashMap::new();
    for row in rows.iter().filter(|row| row.live) {
        *shares.entry(row.owner.clone().unwrap()).or_default() += 1;
    }
    shares
}

#[test]
fn a_tenant_always_falls_in_the_same_slot() {
    // These values are the contract: a tenant that moved slot on an upgrade would be served by
    // two instances at once during a rolling deploy. Never change them to make a test pass.
    let known = [("local", 862), ("a", 192), ("alpha", 400), ("tenant0", 445)];
    for (tenant, slot) in known {
        assert_eq!(slot_of(&id(tenant)).get(), slot, "{tenant}");
    }
    // Spread: 20 000 ids reach every slot, and none is crowded.
    let mut counts = vec![0u32; usize::from(SLOT_COUNT)];
    for number in 0..20_000 {
        counts[slot_of(&id(&format!("t{number}"))).index()] += 1;
    }
    assert!(counts.iter().all(|count| *count > 0), "an empty slot");
    assert!(counts.iter().all(|count| *count < 60), "a crowded slot");
}

#[tokio::test]
async fn the_migration_makes_every_slot_free_and_a_lone_instance_takes_them_all() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let rows = db.slot_rows().await.unwrap();
    assert_eq!(rows.len(), usize::from(SLOT_COUNT));
    assert!(rows.iter().all(|row| row.owner.is_none() && row.epoch == 0));

    let me = InstanceId::generate().unwrap();
    let claim = db.claim_slots(&me, &options()).await.unwrap();
    assert_eq!(claim.live_instances, 1);
    assert_eq!(claim.held.len(), usize::from(SLOT_COUNT));
    assert!(claim.held.iter().all(|held| held.epoch == 1));
    // Renewing keeps the epoch: nothing changed hands.
    let again = db.claim_slots(&me, &options()).await.unwrap();
    assert_eq!((again.acquired, again.released), (0, 0));
    assert!(again.held.iter().all(|held| held.epoch == 1));
    db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn two_instances_share_the_slots_and_each_slot_has_exactly_one_owner() {
    let server = Server::start().await;
    let (a_db, b_db) = (migrated(&server).await, server.connect().await);
    let (a, b) = (
        InstanceId::generate().unwrap(),
        InstanceId::generate().unwrap(),
    );
    // A started alone and holds everything when B arrives.
    a_db.claim_slots(&a, &options()).await.unwrap();

    let mut last = HashMap::new();
    for _ in 0..30 {
        // Both rounds at once, as two gateways' timers would fire.
        let options = options();
        let (from_a, from_b) = tokio::join!(
            a_db.claim_slots(&a, &options),
            b_db.claim_slots(&b, &options)
        );
        let (from_a, from_b) = (from_a.unwrap(), from_b.unwrap());
        // What each one says it holds never overlaps: a slot is in one result at most.
        for held in &from_a.held {
            assert!(from_b.held.iter().all(|other| other.slot != held.slot));
        }
        // An epoch never goes back, and only grows when the slot changed hands.
        for row in a_db.slot_rows().await.unwrap() {
            let before = last.insert(row.slot, (row.epoch, row.owner.clone()));
            if let Some((epoch, owner)) = before {
                assert!(row.epoch >= epoch, "epoch fell on slot {}", row.slot);
                if row.owner.is_some() && owner.is_some() && row.owner != owner {
                    assert!(row.epoch > epoch, "owner changed without the epoch");
                }
            }
        }
        let rows = a_db.slot_rows().await.unwrap();
        let shares = shares(&rows);
        if shares.get(&a) == Some(&512) && shares.get(&b) == Some(&512) {
            break;
        }
    }
    let rows = a_db.slot_rows().await.unwrap();
    let shares = shares(&rows);
    assert_eq!(shares.get(&a), Some(&512), "{shares:?}");
    assert_eq!(shares.get(&b), Some(&512), "{shares:?}");
    assert_eq!(shares.values().sum::<usize>(), usize::from(SLOT_COUNT));
    a_db.close().await.unwrap();
    b_db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn an_instance_that_stops_renewing_loses_its_slots_when_the_lease_runs_out() {
    let server = Server::start().await;
    let (a_db, b_db) = (migrated(&server).await, server.connect().await);
    let (a, b) = (
        InstanceId::generate().unwrap(),
        InstanceId::generate().unwrap(),
    );
    a_db.claim_slots(&a, &options()).await.unwrap();

    // While A's leases run, B cannot take any of them, however often it asks.
    let early = b_db.claim_slots(&b, &options()).await.unwrap();
    assert_eq!(early.acquired, 0);

    // A crashes: no more rounds, and nothing released. B takes everything once the leases are
    // out, and not before.
    let started = tokio::time::Instant::now();
    let taken = loop {
        let claim = b_db.claim_slots(&b, &options()).await.unwrap();
        if claim.held.len() == usize::from(SLOT_COUNT) {
            break claim;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "B never took the slots"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(started.elapsed() >= LEASE / 2, "taken while A's lease ran");
    assert_eq!(taken.live_instances, 1);
    // Every slot changed hands once more.
    assert!(taken.held.iter().all(|held| held.epoch == 2));

    // A comes back to life: it finds nothing of its own, and does not get them back by asking.
    let late = a_db.claim_slots(&a, &options()).await.unwrap();
    assert!(late.held.is_empty(), "A took back slots B holds");
    let rows = a_db.slot_rows().await.unwrap();
    assert_eq!(shares(&rows).get(&b), Some(&usize::from(SLOT_COUNT)));
    a_db.close().await.unwrap();
    b_db.close().await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn a_released_instance_frees_its_slots_for_the_next_round_of_the_other() {
    let server = Server::start().await;
    let (a_db, b_db) = (migrated(&server).await, server.connect().await);
    let (a, b) = (
        InstanceId::generate().unwrap(),
        InstanceId::generate().unwrap(),
    );
    // A long lease: only a release can explain B taking them in time.
    let long = SlotOptions {
        lease: Duration::from_secs(60),
        ..options()
    };
    a_db.claim_slots(&a, &long).await.unwrap();

    a_db.mark_instance_draining(&a).await.unwrap();
    // A draining instance is not counted, so B aims for everything straight away.
    let claim = b_db.claim_slots(&b, &long).await.unwrap();
    assert_eq!((claim.live_instances, claim.target), (1, SLOT_COUNT));
    assert_eq!(claim.acquired, 0, "A's leases are still running");

    assert_eq!(
        a_db.release_instance(&a).await.unwrap(),
        u64::from(SLOT_COUNT)
    );
    let claim = b_db.claim_slots(&b, &long).await.unwrap();
    assert_eq!(claim.held.len(), usize::from(SLOT_COUNT));
    assert!(claim.held.iter().all(|held| held.epoch == 2));
    let rows = a_db.slot_rows().await.unwrap();
    assert_eq!(shares(&rows).get(&b), Some(&usize::from(SLOT_COUNT)));
    a_db.close().await.unwrap();
    b_db.close().await.unwrap();
    server.stop().await;
}
