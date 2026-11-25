//! Agents, threads and messages against a real Postgres: who sees what inside a tenant, that
//! another tenant sees nothing, that message numbers have no hole under concurrent writers, and
//! that the import of the old conversations can run twice.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{MessageParts, ThreadKind, Visibility};
use jian_store::{
    Agent, AgentId, AgentPatch, Author, Database, ImportOutcome, LegacyAgent, LegacyChat,
    LegacyMessage, LegacyThread, MessageId, NewAgent, NewMessage, NewThread, StoreError, Thread,
    ThreadId, Viewer, Who, Window,
};
use jian_testkit::{Side, TestDb, TwoTenants};

const SCRATCH: &str = env!("CARGO_TARGET_TMPDIR");

fn admin(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

fn member(side: &Side) -> Viewer {
    Viewer {
        account: side.member.account_id.clone(),
        admin: false,
    }
}

fn peer(side: &Side) -> Viewer {
    Viewer {
        account: side.peer.account_id.clone(),
        admin: false,
    }
}

fn new_agent(name: &str, visibility: Visibility) -> NewAgent {
    NewAgent {
        name: name.to_owned(),
        description: String::new(),
        instructions: "be brief".to_owned(),
        avatar: None,
        visibility,
        viewers: Vec::new(),
    }
}

fn dm(agent: &Agent) -> NewThread {
    NewThread {
        kind: ThreadKind::Dm,
        title: None,
        members: Vec::new(),
        agents: vec![agent.id.clone()],
    }
}

fn text(text: &str, key: Option<&str>) -> NewMessage {
    NewMessage {
        parts: MessageParts::text(text).unwrap(),
        reply_to: None,
        client_key: key.map(str::to_owned),
    }
}

async fn make_agent(
    db: &Database,
    side: &Side,
    by: &Viewer,
    name: &str,
    visibility: Visibility,
) -> Agent {
    // A plain member needs the grant; an admin never does.
    db.grant(
        &side.ctx,
        &side.admin.account_id,
        &by.account,
        "agents.create",
    )
    .await
    .unwrap();
    db.create_agent(&side.ctx, by, &new_agent(name, visibility))
        .await
        .unwrap()
}

#[tokio::test]
async fn only_an_admin_or_a_member_with_the_grant_makes_agents() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let new = new_agent("Scout", Visibility::Workspace);
    let denied = db
        .create_agent(ctx, &member(&side), &new)
        .await
        .unwrap_err();
    assert!(matches!(denied, StoreError::Denied(_)), "{denied}");
    db.create_agent(ctx, &admin(&side), &new).await.unwrap();
    db.grant(
        ctx,
        &side.admin.account_id,
        &side.member.account_id,
        "agents.create",
    )
    .await
    .unwrap();
    db.create_agent(ctx, &member(&side), &new).await.unwrap();
    assert!(
        db.grant(ctx, &side.admin.account_id, &side.member.account_id, "root")
            .await
            .is_err()
    );
    assert!(
        db.revoke_grant(ctx, &side.member.account_id, "agents.create")
            .await
            .unwrap()
    );
    let denied = db
        .create_agent(ctx, &member(&side), &new)
        .await
        .unwrap_err();
    assert!(matches!(denied, StoreError::Denied(_)));
}

#[tokio::test]
async fn an_agent_is_seen_as_its_visibility_says_and_changed_only_by_its_creator_or_an_admin() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (x, y, boss) = (member(&side), peer(&side), admin(&side));
    let secret = make_agent(db, &side, &x, "Secret", Visibility::Private).await;

    // Private: Y gets nothing, however they ask. Nor does the admin, who does not manage what
    // they cannot see.
    assert!(
        db.list_agents(ctx, &y, None, 50)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert!(db.agent(ctx, &y, &secret.id).await.unwrap().is_none());
    assert!(db.agent(ctx, &boss, &secret.id).await.unwrap().is_none());
    assert!(!db.can_see_agent(ctx, &y, &secret.id).await.unwrap());
    assert!(
        db.create_thread(ctx, &y, &dm(&secret))
            .await
            .unwrap()
            .is_none()
    );
    let group = NewThread {
        kind: ThreadKind::Group,
        title: None,
        members: vec![x.account.clone()],
        agents: vec![secret.id.clone()],
    };
    assert!(db.create_thread(ctx, &y, &group).await.unwrap().is_none());
    assert!(
        db.update_agent(ctx, &y, &secret.id, &AgentPatch::default())
            .await
            .unwrap()
            .is_none()
    );

    // Members: Y listed sees it, and stops when removed.
    let patch = AgentPatch {
        visibility: Some(Visibility::Members),
        viewers: Some(vec![y.account.clone()]),
        ..AgentPatch::default()
    };
    db.update_agent(ctx, &x, &secret.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        db.list_agents(ctx, &y, None, 50).await.unwrap().items.len(),
        1
    );
    assert!(
        db.create_thread(ctx, &y, &dm(&secret))
            .await
            .unwrap()
            .is_some()
    );
    let patch = AgentPatch {
        viewers: Some(Vec::new()),
        ..AgentPatch::default()
    };
    db.update_agent(ctx, &x, &secret.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert!(db.agent(ctx, &y, &secret.id).await.unwrap().is_none());

    // Workspace: Y sees it but may not change it; the creator and the admin may.
    let patch = AgentPatch {
        visibility: Some(Visibility::Workspace),
        ..AgentPatch::default()
    };
    db.update_agent(ctx, &x, &secret.id, &patch)
        .await
        .unwrap()
        .unwrap();
    let rename = AgentPatch {
        name: Some("Renamed".to_owned()),
        ..AgentPatch::default()
    };
    let denied = db
        .update_agent(ctx, &y, &secret.id, &rename)
        .await
        .unwrap_err();
    assert!(matches!(denied, StoreError::Denied(_)));
    let denied = db.archive_agent(ctx, &y, &secret.id).await.unwrap_err();
    assert!(matches!(denied, StoreError::Denied(_)));
    let done = db
        .update_agent(ctx, &boss, &secret.id, &rename)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(done.name, "Renamed");
    db.archive_agent(ctx, &x, &secret.id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        db.list_agents(ctx, &y, None, 50)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    // An archived agent is not offered for a new thread.
    assert!(
        db.create_thread(ctx, &y, &dm(&secret))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_thread_is_seen_only_by_the_people_in_it_and_through_the_agent_too() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (x, y) = (member(&side), peer(&side));
    let agent = make_agent(db, &side, &x, "Shared", Visibility::Workspace).await;
    let mine = db
        .create_thread(ctx, &x, &dm(&agent))
        .await
        .unwrap()
        .unwrap();
    let hers = db
        .create_thread(ctx, &y, &dm(&agent))
        .await
        .unwrap()
        .unwrap();
    // Several dms of one pair are allowed.
    let again = db
        .create_thread(ctx, &x, &dm(&agent))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(mine.id, again.id);

    db.post_message(ctx, &x, &mine.id, text("secret plan", None))
        .await
        .unwrap()
        .unwrap();
    // Y: not in the list, not by id, not through the agent, cannot read or write or add.
    let listed = db.list_threads(ctx, &y, None, None, 50).await.unwrap();
    assert_eq!(
        listed.items.iter().map(|t| &t.id).collect::<Vec<_>>(),
        [&hers.id]
    );
    let through_agent = db
        .list_agent_threads(ctx, &y, &agent.id, None, 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(through_agent.items.len(), 1);
    assert!(db.thread(ctx, &y, &mine.id).await.unwrap().is_none());
    assert!(
        db.list_messages(ctx, &y, &mine.id, Window::Latest, 10)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.post_message(ctx, &y, &mine.id, text("hi", None))
            .await
            .unwrap()
            .is_none()
    );
    let who = Who::Member(y.account.clone());
    assert!(
        db.add_participant(ctx, &y, &mine.id, &who)
            .await
            .unwrap()
            .is_none()
    );
    // The admin does not see it either: being an admin is not being in the thread.
    assert!(
        db.thread(ctx, &admin(&side), &mine.id)
            .await
            .unwrap()
            .is_none()
    );

    // Only a group takes people, and the person taken in sees it from then on.
    let denied = db
        .add_participant(ctx, &x, &mine.id, &who)
        .await
        .unwrap_err();
    assert!(matches!(denied, StoreError::InvalidWorkspace(_)));
    let group = NewThread {
        kind: ThreadKind::Group,
        title: Some("team".to_owned()),
        members: Vec::new(),
        agents: vec![agent.id.clone()],
    };
    let group = db.create_thread(ctx, &x, &group).await.unwrap().unwrap();
    assert!(db.thread(ctx, &y, &group.id).await.unwrap().is_none());
    db.add_participant(ctx, &x, &group.id, &who)
        .await
        .unwrap()
        .unwrap();
    assert!(db.thread(ctx, &y, &group.id).await.unwrap().is_some());
    assert_eq!(db.thread_audience(ctx, &group.id).await.unwrap().len(), 2);
    assert!(
        db.remove_participant(ctx, &x, &group.id, &who)
            .await
            .unwrap()
    );
    assert!(db.thread(ctx, &y, &group.id).await.unwrap().is_none());
    // Y can no longer write there.
    assert!(
        db.post_message(ctx, &y, &group.id, text("hi", None))
            .await
            .unwrap()
            .is_none()
    );
    // The last member cannot leave.
    let last = Who::Member(x.account.clone());
    assert!(
        db.remove_participant(ctx, &x, &group.id, &last)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_agent_that_becomes_private_hides_the_threads_it_is_in_from_those_who_lose_it() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (x, y) = (member(&side), peer(&side));
    let agent = make_agent(db, &side, &x, "Fickle", Visibility::Workspace).await;
    let hers = db
        .create_thread(ctx, &y, &dm(&agent))
        .await
        .unwrap()
        .unwrap();
    let patch = AgentPatch {
        visibility: Some(Visibility::Private),
        ..AgentPatch::default()
    };
    db.update_agent(ctx, &x, &agent.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert!(db.thread(ctx, &y, &hers.id).await.unwrap().is_none());
}

#[tokio::test]
async fn another_tenant_sees_nothing_of_an_agent_a_thread_or_a_message() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let (a, b) = (&sides.a, &sides.b);
    let x = member(a);
    let agent = make_agent(db, a, &x, "Mine", Visibility::Workspace).await;
    let thread = db
        .create_thread(&a.ctx, &x, &dm(&agent))
        .await
        .unwrap()
        .unwrap();
    let posted = db
        .post_message(&a.ctx, &x, &thread.id, text("a", None))
        .await
        .unwrap()
        .unwrap();

    // B's people, with A's ids and B's context.
    for who in [member(b), admin(b)] {
        assert!(db.agent(&b.ctx, &who, &agent.id).await.unwrap().is_none());
        assert!(
            db.list_agents(&b.ctx, &who, None, 50)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(db.thread(&b.ctx, &who, &thread.id).await.unwrap().is_none());
        assert!(
            db.list_threads(&b.ctx, &who, None, None, 50)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            db.list_messages(&b.ctx, &who, &thread.id, Window::Latest, 10)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.post_message(&b.ctx, &who, &thread.id, text("b", None))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.delete_message(&b.ctx, &who, &thread.id, &posted.message.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.create_thread(&b.ctx, &who, &dm(&agent))
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(db.list_grants(&b.ctx).await.unwrap().is_empty());
}

#[tokio::test]
async fn writers_at_once_get_numbers_from_one_to_n_and_a_key_makes_one_message() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (x, y) = (member(&side), peer(&side));
    let agent = make_agent(db, &side, &x, "Busy", Visibility::Workspace).await;
    let group = NewThread {
        kind: ThreadKind::Group,
        title: None,
        members: vec![y.account.clone()],
        agents: vec![agent.id.clone()],
    };
    let thread = db.create_thread(ctx, &x, &group).await.unwrap().unwrap();

    let writer = |who: Viewer, tag: &'static str| {
        let (db, ctx, id) = (db, ctx, thread.id.clone());
        async move {
            for n in 0..20 {
                db.post_message(ctx, &who, &id, text(&format!("{tag} {n}"), None))
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
    };
    tokio::join!(writer(x.clone(), "x"), writer(y.clone(), "y"));
    let page = db
        .list_messages(ctx, &x, &thread.id, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let seqs: Vec<i64> = page.items.iter().map(|m| m.seq).collect();
    assert_eq!(seqs, (1..=40).collect::<Vec<_>>());

    // The same key, twice and at once, as the same author: one message.
    let (one, two) = tokio::join!(
        db.post_message(ctx, &x, &thread.id, text("once", Some("k1"))),
        db.post_message(ctx, &x, &thread.id, text("once", Some("k1"))),
    );
    let (one, two) = (one.unwrap().unwrap(), two.unwrap().unwrap());
    assert_eq!(one.message.id, two.message.id);
    assert_eq!([one.created, two.created].iter().filter(|c| **c).count(), 1);
    // Another author with the same key is another message.
    let other = db
        .post_message(ctx, &y, &thread.id, text("once", Some("k1")))
        .await
        .unwrap()
        .unwrap();
    assert!(other.created);
    assert_eq!(other.message.seq, 42);

    // Cursors read both ways with no overlap.
    let newest = db
        .list_messages(ctx, &x, &thread.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(newest.items.first().unwrap().seq, 33);
    let older = db
        .list_messages(
            ctx,
            &x,
            &thread.id,
            Window::Before(newest.next.unwrap()),
            10,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(older.items.last().unwrap().seq, 32);
    let newer = db
        .list_messages(ctx, &x, &thread.id, Window::After(40), 10)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        newer.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        [41, 42]
    );
    assert!(newer.next.is_none());
}

#[tokio::test]
async fn only_the_author_edits_or_deletes_and_a_deleted_message_keeps_its_place() {
    let test = TestDb::start(SCRATCH).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (x, y) = (member(&side), peer(&side));
    let agent = make_agent(db, &side, &x, "Pal", Visibility::Workspace).await;
    let group = NewThread {
        kind: ThreadKind::Group,
        title: None,
        members: vec![y.account.clone()],
        agents: vec![agent.id.clone()],
    };
    let thread = db.create_thread(ctx, &x, &group).await.unwrap().unwrap();
    let first = db
        .post_message(ctx, &x, &thread.id, text("one", None))
        .await
        .unwrap()
        .unwrap()
        .message;
    let reply = NewMessage {
        reply_to: Some(first.id.clone()),
        ..text("two", None)
    };
    let second = db
        .post_message(ctx, &y, &thread.id, reply)
        .await
        .unwrap()
        .unwrap()
        .message;
    assert_eq!(second.reply_to.as_ref(), Some(&first.id));
    let stray = NewMessage {
        reply_to: Some(MessageId::new("msg_nowhere")),
        ..text("three", None)
    };
    assert!(db.post_message(ctx, &y, &thread.id, stray).await.is_err());

    let parts = MessageParts::text("edited").unwrap();
    let denied = db
        .edit_message(ctx, &y, &thread.id, &first.id, &parts)
        .await
        .unwrap_err();
    assert!(matches!(denied, StoreError::Denied(_)));
    let denied = db
        .delete_message(ctx, &admin(&side), &thread.id, &first.id)
        .await;
    assert!(
        denied.is_ok_and(|m| m.is_none()),
        "the admin is not in the thread: 404"
    );
    let edited = db
        .edit_message(ctx, &x, &thread.id, &first.id, &parts)
        .await
        .unwrap()
        .unwrap();
    assert!(edited.edited_at.is_some());
    let gone = db
        .delete_message(ctx, &x, &thread.id, &first.id)
        .await
        .unwrap()
        .unwrap();
    assert!(gone.deleted && gone.parts.is_empty() && gone.seq == 1);
    assert!(
        db.delete_message(ctx, &x, &thread.id, &first.id)
            .await
            .unwrap()
            .is_none()
    );
    let page = db
        .list_messages(ctx, &y, &thread.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.items.len(), 2);

    // An agent writes through the store only, and only from inside the thread.
    let said = MessageParts::text("hello").unwrap();
    let posted = db
        .post_agent_message(
            ctx,
            &thread.id,
            &agent.id,
            said.clone(),
            Some("run-1".to_owned()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(posted.message.author, Author::Agent(agent.id.clone()));
    let stranger = AgentId::new("agt_stranger");
    assert!(
        db.post_agent_message(ctx, &thread.id, &stranger, said, None)
            .await
            .unwrap()
            .is_none()
    );
}

fn legacy_message(id: &str, role: &str, content: &str, at: &str) -> LegacyMessage {
    LegacyMessage {
        id: id.to_owned(),
        role: role.to_owned(),
        content: content.to_owned(),
        created_at: at.to_owned(),
        author_id: None,
        author_name: None,
        extras: None,
    }
}

#[tokio::test]
async fn imported_conversations_keep_their_order_and_a_second_run_adds_nothing() {
    let test = TestDb::start(SCRATCH).await;
    let sides = TwoTenants::seed(&test.db).await;
    let (db, a, b) = (&test.db, &sides.a, &sides.b);
    let owner = a.admin.account_id.clone();
    let agent = LegacyAgent {
        id: "p-1".to_owned(),
        name: "Old agent".to_owned(),
        instructions: "x".to_owned(),
        summary: "what it did".to_owned(),
        avatar: None,
        created_at: "2026-01-01 10:00:00+00".to_owned(),
    };
    let desk = LegacyThread {
        id: "s-1".to_owned(),
        agent_id: "p-1".to_owned(),
        title: Some("desk".to_owned()),
        created_at: "2026-01-02 10:00:00+00".to_owned(),
        chat: None,
    };
    let chat = LegacyThread {
        id: "s-2".to_owned(),
        chat: Some(LegacyChat {
            channel: "whatsapp".to_owned(),
            chat_id: "5511999990000".to_owned(),
            title: Some("Ana".to_owned()),
        }),
        ..desk.clone()
    };
    let mut from_ana = legacy_message("m-3", "user", "oi", "2026-01-02 11:00:00+00");
    from_ana.author_id = Some("5511999990000".to_owned());
    from_ana.author_name = Some("Ana".to_owned());
    from_ana.extras = Some("{\"reactions\":[\"+1\"]}".to_owned());
    let desk_messages = [
        legacy_message("m-1", "user", "first", "2026-01-02 10:01:00+00"),
        legacy_message("m-2", "assistant", "second", "2026-01-02 10:02:00+00"),
    ];
    for round in 0..2 {
        let expected = if round == 0 {
            ImportOutcome::Imported
        } else {
            ImportOutcome::AlreadyThere
        };
        assert_eq!(
            db.import_agent(&a.ctx, &owner, &agent).await.unwrap(),
            expected
        );
        assert_eq!(
            db.import_thread(&a.ctx, &owner, &desk).await.unwrap(),
            expected
        );
        assert_eq!(
            db.import_thread(&a.ctx, &owner, &chat).await.unwrap(),
            expected
        );
        let done = db
            .import_messages(&a.ctx, &owner, "s-1", &desk_messages)
            .await
            .unwrap();
        assert!(done.iter().all(|o| *o.as_ref().unwrap() == expected));
        db.import_messages(&a.ctx, &owner, "s-2", std::slice::from_ref(&from_ana))
            .await
            .unwrap();
    }
    let viewer = Viewer {
        account: owner,
        admin: true,
    };
    let threads: Vec<Thread> = db
        .list_threads(&a.ctx, &viewer, None, None, 50)
        .await
        .unwrap()
        .items;
    assert_eq!(threads.len(), 2, "no duplicates after the second run");
    let dm = threads.iter().find(|t| t.kind == ThreadKind::Dm).unwrap();
    let page = db
        .list_messages(&a.ctx, &viewer, &dm.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    let said: Vec<(i64, &str)> = page
        .items
        .iter()
        .map(|m| (m.seq, m.author.kind()))
        .collect();
    assert_eq!(said, [(1, "member"), (2, "agent")]);
    let channel = threads
        .iter()
        .find(|t| t.kind == ThreadKind::Channel)
        .unwrap();
    assert!(channel.origin.is_some());
    let page = db
        .list_messages(&a.ctx, &viewer, &channel.id, Window::Latest, 10)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0].parts.len(),
        2,
        "the reactions are kept as a legacy part"
    );

    // The people who manage the agent see the channel thread; others do not.
    let outsider = peer(a);
    assert!(
        db.thread(&a.ctx, &outsider, &channel.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.list_threads(&b.ctx, &member(b), None, None, 50)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    let id = ThreadId::new(channel.id.as_str());
    assert!(
        db.thread_audience(&a.ctx, &id)
            .await
            .unwrap()
            .contains(&a.admin.account_id)
    );
}
