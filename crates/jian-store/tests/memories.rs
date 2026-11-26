//! An agent's memories against a real Postgres: versions, flash
//! expiry by an injected clock, full-text search, what a conversation may recall, links, and
//! that tenant B reads and changes nothing of tenant A's.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{ThreadKind, Visibility};
use jian_store::{
    Agent, AgentId, Database, MAX_MEMORY_LINKS, MemoryQuery, MemoryWrite, NewAgent, NewThread,
    OriginKind, RecallScope, StoreError, Thread, ThreadId, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

const HOUR: i64 = 3_600_000;
const T0: i64 = 1_750_000_000_000;

fn viewer(side: &Side, admin: bool) -> Viewer {
    Viewer {
        account: if admin {
            side.admin.account_id.clone()
        } else {
            side.member.account_id.clone()
        },
        admin,
    }
}

async fn agent(db: &Database, side: &Side) -> Agent {
    db.create_agent(
        &side.ctx,
        &viewer(side, true),
        &NewAgent {
            name: "remembers".to_owned(),
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

async fn thread(
    db: &Database,
    side: &Side,
    by: &Viewer,
    kind: ThreadKind,
    agent: &Agent,
) -> Thread {
    let members = if kind == ThreadKind::Group {
        vec![side.member.account_id.clone()]
    } else {
        Vec::new()
    };
    db.create_thread(
        &side.ctx,
        by,
        &NewThread {
            kind,
            title: None,
            members,
            agents: vec![agent.id.clone()],
        },
    )
    .await
    .unwrap()
    .unwrap()
}

fn say(content: &str) -> MemoryWrite {
    MemoryWrite {
        content: content.to_owned(),
        ..MemoryWrite::default()
    }
}

fn everything() -> MemoryQuery {
    MemoryQuery {
        scope: RecallScope::Everything,
        search: None,
        after: None,
        limit: 100,
    }
}

async fn keys(
    db: &Database,
    side: &Side,
    agent: &AgentId,
    query: &MemoryQuery,
    now: i64,
) -> Vec<String> {
    db.list_memories(&side.ctx, agent, query, now)
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|m| m.key)
        .collect()
}

#[tokio::test]
async fn a_write_with_the_wrong_version_fails_and_the_right_one_goes_through() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;

    let first = db
        .write_memory(&side.ctx, &a.id, "likes", &say("tea"), T0)
        .await
        .unwrap();
    assert_eq!(first.version, 1);
    assert_eq!(first.origin.kind, OriginKind::Manual);

    // `Some(0)` is "create only": it fails on a key that exists.
    let mut write = say("coffee");
    write.expected_version = Some(0);
    let refused = db.write_memory(&side.ctx, &a.id, "likes", &write, T0).await;
    assert!(matches!(
        refused,
        Err(StoreError::VersionConflict { current: 1 })
    ));
    write.expected_version = Some(7);
    let refused = db.write_memory(&side.ctx, &a.id, "likes", &write, T0).await;
    assert!(matches!(
        refused,
        Err(StoreError::VersionConflict { current: 1 })
    ));
    write.expected_version = Some(1);
    let second = db
        .write_memory(&side.ctx, &a.id, "likes", &write, T0)
        .await
        .unwrap();
    assert_eq!((second.version, second.content.as_str()), (2, "coffee"));
    // The refused writes changed nothing, and a stale delete is refused too.
    assert!(matches!(
        db.delete_memory(&side.ctx, &a.id, "likes", Some(1), T0)
            .await,
        Err(StoreError::VersionConflict { current: 2 })
    ));
    assert!(
        db.delete_memory(&side.ctx, &a.id, "likes", Some(2), T0)
            .await
            .unwrap()
    );
    assert!(
        db.memory(&side.ctx, &a.id, "likes", T0)
            .await
            .unwrap()
            .is_none()
    );

    for bad in ["", "Upper", "has space", &"k".repeat(101)] {
        assert!(matches!(
            db.write_memory(&side.ctx, &a.id, bad, &say("x"), T0).await,
            Err(StoreError::InvalidWorkspace(_))
        ));
    }
    test.stop().await;
}

#[tokio::test]
async fn two_writers_creating_the_same_key_at_once_cannot_both_win() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;
    let mut create = say("mine");
    create.expected_version = Some(0);
    let results = futures_util::future::join_all(
        (0..6).map(|_| db.write_memory(&side.ctx, &a.id, "race", &create, T0)),
    )
    .await;
    let won = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(won, 1, "{results:?}");
    assert!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| matches!(e, StoreError::VersionConflict { current: 1 }))
    );
    test.stop().await;
}

#[tokio::test]
async fn a_flash_memory_ends_on_the_injected_clock_and_a_permanent_one_never_turns_flash() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;

    let mut flash = say("meeting at 3");
    flash.flash_hours = Some(2);
    let written = db
        .write_memory(&side.ctx, &a.id, "now", &flash, T0)
        .await
        .unwrap();
    assert!(written.expires_at.is_some());
    assert!(
        db.memory(&side.ctx, &a.id, "now", T0 + HOUR)
            .await
            .unwrap()
            .is_some()
    );
    // Gone to every read at the expiry, before the row is purged.
    let after = T0 + 2 * HOUR;
    assert!(
        db.memory(&side.ctx, &a.id, "now", after)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        keys(db, &side, &a.id, &everything(), after)
            .await
            .is_empty()
    );
    // Writing it again is a new memory, from version 1, even asking for "create only".
    flash.expected_version = Some(0);
    let again = db
        .write_memory(&side.ctx, &a.id, "now", &flash, after)
        .await
        .unwrap();
    assert_eq!(again.version, 1);
    assert_eq!(db.purge_memories(&side.ctx, after).await.unwrap(), 0);
    assert_eq!(
        db.purge_memories(&side.ctx, after + 3 * HOUR)
            .await
            .unwrap(),
        1
    );

    // Hours outside 1..=24 are refused.
    for hours in [0, 25] {
        let mut bad = say("x");
        bad.flash_hours = Some(hours);
        assert!(matches!(
            db.write_memory(&side.ctx, &a.id, "bad", &bad, T0).await,
            Err(StoreError::InvalidWorkspace(_))
        ));
    }

    // A permanent memory written as flash stays permanent; a flash one written plain becomes it.
    db.write_memory(&side.ctx, &a.id, "keep", &say("always"), T0)
        .await
        .unwrap();
    let mut as_flash = say("still always");
    as_flash.flash_hours = Some(1);
    let kept = db
        .write_memory(&side.ctx, &a.id, "keep", &as_flash, T0)
        .await
        .unwrap();
    assert!(kept.expires_at.is_none());
    let mut brief = say("brief");
    brief.flash_hours = Some(1);
    db.write_memory(&side.ctx, &a.id, "brief", &brief, T0)
        .await
        .unwrap();
    let promoted = db
        .write_memory(&side.ctx, &a.id, "brief", &say("now permanent"), T0)
        .await
        .unwrap();
    assert!(promoted.expires_at.is_none());
    assert!(
        db.memory(&side.ctx, &a.id, "brief", T0 + 48 * HOUR)
            .await
            .unwrap()
            .is_some()
    );
    test.stop().await;
}

#[tokio::test]
async fn search_finds_by_words_best_match_first_and_pages_by_key() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;
    for (key, text) in [
        ("pet-cat", "The cat sleeps on the sofa"),
        ("pet-dog", "The dog barks"),
        ("cats-food", "cat food cat food cat"),
        ("weather", "It rains in Lisbon"),
    ] {
        db.write_memory(&side.ctx, &a.id, key, &say(text), T0)
            .await
            .unwrap();
    }
    let mut query = everything();
    query.search = Some("cat".to_owned());
    assert_eq!(
        keys(db, &side, &a.id, &query, T0).await,
        ["cats-food", "pet-cat"]
    );
    query.search = Some("lisbon".to_owned());
    assert_eq!(keys(db, &side, &a.id, &query, T0).await, ["weather"]);

    let mut paged = everything();
    paged.limit = 3;
    let page = db
        .list_memories(&side.ctx, &a.id, &paged, T0)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 3);
    paged.after = page.next;
    let last = db
        .list_memories(&side.ctx, &a.id, &paged, T0)
        .await
        .unwrap();
    assert_eq!(last.items.len(), 1);
    assert!(last.next.is_none());
    test.stop().await;
}

#[tokio::test]
async fn a_direct_chat_memory_is_not_recalled_where_someone_who_was_not_there_is() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;
    let admin = viewer(&side, true);
    let member = viewer(&side, false);
    let dm_admin = thread(db, &side, &admin, ThreadKind::Dm, &a).await;
    let dm_member = thread(db, &side, &member, ThreadKind::Dm, &a).await;
    let group = thread(db, &side, &admin, ThreadKind::Group, &a).await;

    let mut secret = say("the admin is moving house");
    secret.origin = Some(dm_admin.id.clone());
    let stored = db
        .write_memory(&side.ctx, &a.id, "private", &secret, T0)
        .await
        .unwrap();
    // The origin says where it came from and who was there.
    assert_eq!(stored.origin.kind, OriginKind::Dm);
    assert_eq!(stored.origin.thread.as_ref(), Some(&dm_admin.id));
    assert!(
        stored
            .origin
            .participants
            .contains(&format!("member:{}", side.admin.account_id))
    );
    assert!(
        stored
            .origin
            .participants
            .contains(&format!("agent:{}", a.id))
    );
    let mut open = say("the office is on the second floor");
    open.origin = Some(group.id.clone());
    db.write_memory(&side.ctx, &a.id, "office", &open, T0)
        .await
        .unwrap();
    db.write_memory(&side.ctx, &a.id, "typed", &say("by a person"), T0)
        .await
        .unwrap();

    let recall = |thread: &Thread| MemoryQuery {
        scope: RecallScope::Thread(thread.id.clone()),
        ..everything()
    };
    // In the DM it was learned in, everything. In another person's DM, the private one is held
    // back. In a group with the same people it came from (plus another), it is not.
    assert_eq!(
        keys(db, &side, &a.id, &recall(&dm_admin), T0).await,
        ["office", "private", "typed"]
    );
    assert_eq!(
        keys(db, &side, &a.id, &recall(&dm_member), T0).await,
        ["office", "typed"]
    );
    assert_eq!(
        keys(db, &side, &a.id, &recall(&group), T0).await,
        ["office", "private", "typed"]
    );
    // Without a scope everything is there, marked with its origin.
    assert_eq!(keys(db, &side, &a.id, &everything(), T0).await.len(), 3);

    // The member joins nothing new: someone who was never in the DM, in a group, is held back.
    let outsider = db
        .create_thread(
            &side.ctx,
            &member,
            &NewThread {
                kind: ThreadKind::Group,
                title: None,
                members: vec![side.peer.account_id.clone()],
                agents: vec![a.id.clone()],
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        keys(db, &side, &a.id, &recall(&outsider), T0).await,
        ["office", "typed"]
    );
    // A search honours the scope too.
    let mut search = recall(&outsider);
    search.search = Some("moving".to_owned());
    assert!(keys(db, &side, &a.id, &search, T0).await.is_empty());
    // A thread that is not there is a refusal, not a silent empty origin.
    let mut ghost = say("x");
    ghost.origin = Some(ThreadId::new("thr_never"));
    assert!(matches!(
        db.write_memory(&side.ctx, &a.id, "ghost", &ghost, T0).await,
        Err(StoreError::InvalidWorkspace(_))
    ));
    test.stop().await;
}

#[tokio::test]
async fn links_are_symmetric_limited_and_end_with_the_memory() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let a = agent(db, &side).await;
    for key in ["hub", "b", "a"] {
        db.write_memory(&side.ctx, &a.id, key, &say("x"), T0)
            .await
            .unwrap();
    }
    db.link_memories(&side.ctx, &a.id, "hub", "a", T0)
        .await
        .unwrap();
    db.link_memories(&side.ctx, &a.id, "b", "hub", T0)
        .await
        .unwrap();
    db.link_memories(&side.ctx, &a.id, "a", "hub", T0)
        .await
        .unwrap();
    assert_eq!(
        db.memory_links(&side.ctx, &a.id, "hub", T0).await.unwrap(),
        ["a", "b"]
    );
    assert_eq!(
        db.memory_links(&side.ctx, &a.id, "a", T0).await.unwrap(),
        ["hub"]
    );
    assert!(matches!(
        db.link_memories(&side.ctx, &a.id, "a", "missing", T0).await,
        Err(StoreError::InvalidWorkspace(_))
    ));
    assert!(
        db.unlink_memories(&side.ctx, &a.id, "b", "hub")
            .await
            .unwrap()
    );
    assert!(
        !db.unlink_memories(&side.ctx, &a.id, "b", "hub")
            .await
            .unwrap()
    );

    for n in 0..MAX_MEMORY_LINKS {
        let key = format!("n{n}");
        db.write_memory(&side.ctx, &a.id, &key, &say("x"), T0)
            .await
            .unwrap();
        let linked = db.link_memories(&side.ctx, &a.id, "hub", &key, T0).await;
        // `hub` already has `a`, so the twelfth new one is the thirteenth link.
        assert_eq!(linked.is_ok(), n + 1 < MAX_MEMORY_LINKS, "{n}");
    }
    assert_eq!(
        db.memory_links(&side.ctx, &a.id, "hub", T0)
            .await
            .unwrap()
            .len(),
        MAX_MEMORY_LINKS
    );
    db.delete_memory(&side.ctx, &a.id, "a", None, T0)
        .await
        .unwrap();
    assert!(
        !db.memory_links(&side.ctx, &a.id, "hub", T0)
            .await
            .unwrap()
            .contains(&"a".to_owned())
    );
    test.stop().await;
}

#[tokio::test]
async fn one_tenants_agent_and_memories_are_nothing_to_the_other() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    for (actor, victim) in tenants.crossings() {
        let theirs = agent(db, victim).await;
        db.write_memory(&victim.ctx, &theirs.id, "secret", &say("theirs"), T0)
            .await
            .unwrap();
        // The same agent id under the actor's context: no memory, no list, no write, no delete.
        assert!(
            db.memory(&actor.ctx, &theirs.id, "secret", T0)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            keys(db, actor, &theirs.id, &everything(), T0)
                .await
                .is_empty()
        );
        assert!(matches!(
            db.write_memory(&actor.ctx, &theirs.id, "secret", &say("mine"), T0)
                .await,
            Err(StoreError::InvalidWorkspace(_))
        ));
        assert!(
            !db.delete_memory(&actor.ctx, &theirs.id, "secret", None, T0)
                .await
                .unwrap()
        );
        assert_eq!(
            db.purge_memories(&actor.ctx, T0 + 100 * HOUR)
                .await
                .unwrap(),
            0
        );
        let kept = db
            .memory(&victim.ctx, &theirs.id, "secret", T0)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((kept.content.as_str(), kept.version), ("theirs", 1));
    }
    test.stop().await;
}
