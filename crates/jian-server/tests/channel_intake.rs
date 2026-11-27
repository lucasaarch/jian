//! What the gateway does with messages a chat channel reports, against a real Postgres and the
//! contract's fake channel: no network, no real number.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{
    Channel, ChannelError, ChannelKind, ChatId, ChatKind, InboundBody, InboundMessage, MessageId,
    PairingMethod, Participant, ParticipantId,
};
use jian_core::Visibility;
use jian_server::{
    CHANNEL_MESSAGE_EVENT, CHANNEL_UNKNOWN_SENDER_EVENT, Intake, ReplyError, receive, reply,
};
use jian_store::{
    AgentEvent, AgentId, ChannelAccount, Database, Identity, NewAgent, PersonRole, Sender,
    TenantCtx, Viewer, channel_secret_owner, secrets::Secret,
};
use jian_testkit::{Side, TestDb, TwoTenants};

const OWNER: &str = "5511900000001@s.whatsapp.net";
const STRANGER: &str = "5511900000002@s.whatsapp.net";
const FRIEND: &str = "5511900000003@s.whatsapp.net";
const SESSION_KEY: &str = "SESSION-KEY-never-printed-0123456789";

struct Rig {
    test: TestDb,
    tenants: TwoTenants,
}

fn viewer(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

async fn agent(db: &Database, side: &Side, name: &str) -> AgentId {
    let new = NewAgent {
        name: name.to_owned(),
        description: String::new(),
        instructions: "Be brief.".to_owned(),
        avatar: None,
        visibility: Visibility::Workspace,
        viewers: Vec::new(),
    };
    db.create_agent(&side.ctx, &viewer(side), &new)
        .await
        .unwrap()
        .id
}

async fn account(db: &Database, side: &Side, agent: &AgentId) -> ChannelAccount {
    db.create_channel_account(&side.ctx, &viewer(side), agent, "whatsapp", Some(OWNER))
        .await
        .unwrap()
}

fn said(id: &str, from: &str, text: &str) -> InboundMessage {
    InboundMessage {
        id: MessageId::new(id),
        chat: ChatId::new(from),
        chat_kind: ChatKind::Direct,
        sender: Participant {
            id: ParticipantId::new(from),
            display_name: Some("Someone".to_owned()),
            is_admin: false,
        },
        from_self: false,
        at_ms: 1,
        reply_to: None,
        body: InboundBody::Text {
            text: text.to_owned(),
        },
    }
}

impl Rig {
    async fn new() -> Self {
        let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
        let tenants = TwoTenants::seed(&test.db).await;
        Self { test, tenants }
    }

    async fn inbox(&self, ctx: &TenantCtx, agent: &AgentId) -> Vec<AgentEvent> {
        self.test
            .db
            .pending_events(ctx, agent, i64::MAX, 100)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn an_unknown_sender_is_a_stranger_never_a_contact_and_the_first_time_is_marked_once() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;

    let first = receive(db, &a.ctx, &acct, &said("m1", STRANGER, "hi, it is me"))
        .await
        .unwrap();
    let again = receive(db, &a.ctx, &acct, &said("m2", STRANGER, "hello?"))
        .await
        .unwrap();
    assert!(
        matches!(&first, Intake::Stranger { first: true, text, .. } if text == "hi, it is me"),
        "{first:?}"
    );
    assert!(
        matches!(&again, Intake::Stranger { first: false, .. }),
        "{again:?}"
    );
    // The same message again is not a third run.
    let replay = receive(db, &a.ctx, &acct, &said("m2", STRANGER, "hello?"))
        .await
        .unwrap();
    assert_eq!(replay, Intake::Duplicate);

    // Their words are in no inbox event: the one event is the marker, with no text.
    let events = rig.inbox(&a.ctx, &pear).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, CHANNEL_UNKNOWN_SENDER_EVENT);
    let raw = events[0].payload.to_string();
    assert!(
        !raw.contains("hi, it is me") && !raw.contains("hello?"),
        "{raw}"
    );
    // And they did not become a person of the agent (or anything else of the workspace).
    let people = db.people_of(&a.ctx, &pear).await.unwrap();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0].role, PersonRole::Creator);
}

#[tokio::test]
async fn a_blocked_person_stays_silent_and_a_person_added_without_a_message_talks_to_the_agent() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;
    // Neither of them ever wrote: the creator added them.
    let by = a.admin.account_id.as_str();
    let friend = Identity::new("whatsapp", FRIEND);
    let foe = Identity::new("whatsapp", STRANGER);
    db.create_person(&a.ctx, &pear, "Friend", PersonRole::Known, &[friend], by)
        .await
        .unwrap();
    db.create_person(&a.ctx, &pear, "Foe", PersonRole::Blocked, &[foe], by)
        .await
        .unwrap();

    let declined = receive(db, &a.ctx, &acct, &said("m2", STRANGER, "please"))
        .await
        .unwrap();
    let approved = receive(db, &a.ctx, &acct, &said("m3", FRIEND, "oi agente"))
        .await
        .unwrap();
    assert_eq!(declined, Intake::Ignored);
    assert!(
        matches!(approved, Intake::Delivered { notify: true, .. }),
        "{approved:?}"
    );

    let messages: Vec<_> = rig
        .inbox(&a.ctx, &pear)
        .await
        .into_iter()
        .filter(|e| e.kind == CHANNEL_MESSAGE_EVENT)
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].payload["body"]["text"], "oi agente");
    assert_eq!(messages[0].payload["role"], "contact");
}

#[tokio::test]
async fn the_owners_own_message_reaches_the_agent_but_never_asks_for_a_notification() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;

    let got = receive(db, &a.ctx, &acct, &said("m1", OWNER, "do the thing"))
        .await
        .unwrap();
    assert!(
        matches!(got, Intake::Delivered { notify: false, .. }),
        "{got:?}"
    );
    let events = rig.inbox(&a.ctx, &pear).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload["notify"], false);
    assert_eq!(events[0].payload["role"], "owner");

    // What the account's own device sent is dropped before it is an event at all.
    let mut own = said("m2", OWNER, "sent from the phone");
    own.from_self = true;
    assert_eq!(receive(db, &a.ctx, &acct, &own).await.unwrap(), Intake::Own);
    assert_eq!(rig.inbox(&a.ctx, &pear).await.len(), 1);
}

#[tokio::test]
async fn the_same_person_is_recognised_on_two_channels() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let whatsapp = account(db, a, &pear).await;
    let telegram = db
        .create_channel_account(&a.ctx, &viewer(a), &pear, "telegram", Some("1"))
        .await
        .unwrap();
    let ana = db
        .create_person(
            &a.ctx,
            &pear,
            "Ana",
            PersonRole::Known,
            &[
                Identity::new("whatsapp", FRIEND),
                Identity::new("telegram", "77"),
            ],
            a.admin.account_id.as_str(),
        )
        .await
        .unwrap();

    for (acct, from) in [(&whatsapp, FRIEND), (&telegram, "77")] {
        let got = receive(db, &a.ctx, acct, &said("m1", from, "oi"))
            .await
            .unwrap();
        assert!(
            matches!(got, Intake::Delivered { notify: true, .. }),
            "{got:?}"
        );
        let Sender::Person(who) = db.resolve_sender(&a.ctx, acct, from).await.unwrap() else {
            panic!("{from} is a person");
        };
        assert_eq!(who.id, ana.id);
    }
}

#[tokio::test]
async fn a_new_identity_for_a_person_is_linked_only_when_the_creator_confirms() {
    const NEW: &str = "5511900000009@s.whatsapp.net";
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;
    let ana = db
        .create_person(
            &a.ctx,
            &pear,
            "Ana",
            PersonRole::Known,
            &[Identity::new("whatsapp", FRIEND)],
            a.admin.account_id.as_str(),
        )
        .await
        .unwrap();
    let new = Identity::new("whatsapp", NEW);
    let asked = db
        .request_identity_link(&a.ctx, &pear, &ana.id, &new, "run:test")
        .await
        .unwrap()
        .unwrap();
    assert!(asked.created);
    let code = asked.request.code.clone();
    // Asking again finds the same request, and an identity somebody has is refused.
    let twice = db
        .request_identity_link(&a.ctx, &pear, &ana.id, &new, "run:test")
        .await
        .unwrap()
        .unwrap();
    assert!(!twice.created && twice.request.code == code);
    let held = Identity::new("whatsapp", FRIEND);
    assert!(
        db.request_identity_link(&a.ctx, &pear, &ana.id, &held, "run:test")
            .await
            .is_err()
    );

    // The identity asked for is still nobody, and sending the code from it changes nothing.
    let confirm = format!("/confirm {code}");
    let got = receive(db, &a.ctx, &acct, &said("n1", NEW, &confirm))
        .await
        .unwrap();
    assert!(matches!(got, Intake::Stranger { .. }), "{got:?}");
    // A known person is not the creator: their /confirm is only a message.
    let got = receive(db, &a.ctx, &acct, &said("f1", FRIEND, &confirm))
        .await
        .unwrap();
    assert!(matches!(got, Intake::Delivered { .. }), "{got:?}");
    assert_eq!(
        db.resolve_sender(&a.ctx, &acct, NEW).await.unwrap(),
        Sender::Unknown
    );

    // The creator's is a decision, answered in code.
    let got = receive(db, &a.ctx, &acct, &said("o1", OWNER, &confirm))
        .await
        .unwrap();
    assert!(
        matches!(&got, Intake::Decision { reply } if reply.starts_with("Linked")),
        "{got:?}"
    );
    let Sender::Person(who) = db.resolve_sender(&a.ctx, &acct, NEW).await.unwrap() else {
        panic!("linked");
    };
    assert_eq!(who.id, ana.id);
    let got = receive(db, &a.ctx, &acct, &said("n2", NEW, "it is me"))
        .await
        .unwrap();
    assert!(
        matches!(got, Intake::Delivered { notify: true, .. }),
        "{got:?}"
    );
}

#[tokio::test]
async fn a_files_token_never_reaches_the_inbox_nor_a_debug_print() {
    use jian_channel_api::{MediaInfo, MediaKind, MediaRef};

    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;
    // What a provider may put in a token: the key that opens the file.
    let token = "{\"media_key\":\"MEDIA-KEY-never-stored-0123456789\"}";
    let mut photo = said("m1", OWNER, "");
    photo.body = InboundBody::Media {
        info: MediaInfo {
            kind: MediaKind::Image,
            mime: "image/jpeg".to_owned(),
            file_name: None,
            size: 42,
            media: MediaRef::new(token),
        },
        caption: Some("look".to_owned()),
    };
    assert!(!format!("{photo:?}").contains("MEDIA-KEY"), "{photo:?}");

    let got = receive(db, &a.ctx, &acct, &photo).await.unwrap();
    assert!(matches!(got, Intake::Delivered { .. }), "{got:?}");
    let events = rig.inbox(&a.ctx, &pear).await;
    assert_eq!(events.len(), 1);
    let raw = events[0].payload.to_string();
    assert!(
        !raw.contains("MEDIA-KEY") && !raw.contains("media_key"),
        "{raw}"
    );
    // The agent still hears what arrived.
    let body = &events[0].payload["body"];
    assert_eq!(body["type"], "media");
    assert_eq!(body["size"], 42);
    assert_eq!(body["caption"], "look");
}

#[tokio::test]
async fn the_same_message_twice_is_one_event_and_a_restart_keeps_the_queue() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;
    let msg = said("same", OWNER, "once");
    let first = receive(db, &a.ctx, &acct, &msg).await.unwrap();
    let second = receive(db, &a.ctx, &acct, &msg).await.unwrap();
    assert!(matches!(first, Intake::Delivered { .. }));
    assert_eq!(second, Intake::Duplicate);

    // A restart is a new process reading the same rows: the account is read again from the
    // store, the queue is still there, and a backlog replayed after the reconnect adds nothing.
    let reread = db
        .channel_account_of_host(&a.ctx, &acct.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receive(db, &a.ctx, &reread, &msg).await.unwrap(),
        Intake::Duplicate
    );
    assert_eq!(rig.inbox(&a.ctx, &pear).await.len(), 1);
}

#[tokio::test]
async fn one_tenants_account_is_invisible_to_the_other() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    for (actor, victim) in rig.tenants.crossings() {
        let owner = agent(db, victim, "pear").await;
        let acct = account(db, victim, &owner).await;
        // The other tenant's context finds neither the account nor its agent.
        assert!(
            db.channel_account_of_host(&actor.ctx, &acct.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.channel_account(&actor.ctx, &viewer(actor), &acct.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.create_channel_account(&actor.ctx, &viewer(actor), &owner, "whatsapp", None)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn an_agent_never_sends_from_another_agents_account() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let plum = agent(db, a, "plum").await;
    let pears = account(db, a, &pear).await;
    let plums = account(db, a, &plum).await;
    let channel = FakeChannel::new(ChannelKind::Whatsapp);
    channel.connect(PairingMethod::Resume).await.unwrap();

    let Intake::Delivered { thread, .. } = receive(db, &a.ctx, &pears, &said("m1", OWNER, "hello"))
        .await
        .unwrap()
    else {
        panic!("not delivered");
    };

    // Plum, with pear's account or pear's thread, is refused and nothing is sent.
    let refused = reply(db, &a.ctx, &channel, &pears, &plum, &thread, "stolen").await;
    assert!(matches!(refused, Err(ReplyError::NotThisAgents)));
    let refused = reply(db, &a.ctx, &channel, &plums, &plum, &thread, "stolen").await;
    assert!(matches!(refused, Err(ReplyError::NotThisAgents)));
    assert!(channel.sent().is_empty());

    reply(db, &a.ctx, &channel, &pears, &pear, &thread, "mine")
        .await
        .unwrap();
    assert_eq!(channel.sent().len(), 1);

    // An uncertain send comes back as it is, and is not tried again.
    channel.fail_next_send(ChannelError::SendUncertain);
    let lost = reply(db, &a.ctx, &channel, &pears, &pear, &thread, "maybe").await;
    assert!(matches!(
        lost,
        Err(ReplyError::Channel(ChannelError::SendUncertain))
    ));
    assert_eq!(channel.sent().len(), 1);
}

#[tokio::test]
async fn the_session_secret_stays_in_the_vault_and_out_of_debug_output() {
    let rig = Rig::new().await;
    let db = &rig.test.db;
    let a = &rig.tenants.a;
    let pear = agent(db, a, "pear").await;
    let acct = account(db, a, &pear).await;
    let owner = channel_secret_owner(&acct.id, "identity");
    db.vault()
        .put(&a.ctx, &owner, &Secret::new(SESSION_KEY))
        .await
        .unwrap();

    receive(db, &a.ctx, &acct, &said("m1", OWNER, "hi"))
        .await
        .unwrap();
    let shown = format!("{acct:?} {:?}", rig.inbox(&a.ctx, &pear).await);
    assert!(!shown.contains(SESSION_KEY), "{shown}");
    assert!(!format!("{:?}", Secret::new(SESSION_KEY)).contains(SESSION_KEY));
    // Read back only through the vault, and the other tenant has none.
    let read = db.vault().read(&a.ctx, &owner).await.unwrap().unwrap();
    assert_eq!(read.expose(), SESSION_KEY);
    assert!(
        db.vault()
            .read(&rig.tenants.b.ctx, &owner)
            .await
            .unwrap()
            .is_none()
    );
}
