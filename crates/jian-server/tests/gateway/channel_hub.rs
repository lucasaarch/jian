//! The hub that holds the chat connections: it reconnects after a drop with a backoff, gives the
//! connection up the moment the slot is lost and picks it up again where the slot went, and
//! neither loses nor repeats a message across any of it. Real Postgres and a fake channel: no
//! network, no number.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{
    Backoff, Channel, ChannelEvent, ChannelKind, ChatId, ChatKind, ConnectionState, Disconnect,
    InboundBody, InboundMessage, MessageId, PairingMethod, PairingPrompt, Participant,
    ParticipantId,
};
use jian_server::{CHANNEL_MESSAGE_EVENT, ChannelHub, Settings};
use jian_store::{AgentId, ChannelAccount, ChannelStatus, SlotOptions, TenantCtx, Viewer};
use jian_testkit::TwoTenants;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::accounts::open_settings;
use super::channels::named_agent;
use super::support::Gateway;

const OWNER: &str = "5511900000001@s.whatsapp.net";
const NUMBER: &str = "5511900000099@s.whatsapp.net";
const OTHER_NUMBER: &str = "5511900000098@s.whatsapp.net";
const WAIT: Duration = Duration::from_secs(20);

/// A lease no test outlasts: only a release can explain a slot changing hands within it.
const LONG: SlotOptions = SlotOptions {
    lease: Duration::from_secs(60),
    renew_every: Duration::from_millis(100),
    release_batch: 256,
};

/// What `tracing` printed in this process, for the test that looks for a code in it.
fn logs() -> &'static Arc<Mutex<String>> {
    static LOGS: OnceLock<Arc<Mutex<String>>> = OnceLock::new();
    LOGS.get_or_init(|| {
        let sink = Arc::new(Mutex::new(String::new()));
        // Another test binary's subscriber is not this one's business: a second try fails, and
        // the log stays what it is.
        let _ = tracing::subscriber::set_global_default(Capture(sink.clone()));
        sink
    })
}

struct Capture(Arc<Mutex<String>>);

struct Fields<'a>(&'a mut String);

impl tracing::field::Visit for Fields<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0, "{}={value:?} ", field.name());
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut line = String::new();
        event.record(&mut Fields(&mut line));
        if let Ok(mut all) = self.0.lock() {
            all.push_str(&line);
            all.push('\n');
        }
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

async fn eventually(what: &str, mut done: impl AsyncFnMut() -> bool) {
    let started = Instant::now();
    while !done().await {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn said(id: &str, text: &str) -> ChannelEvent {
    ChannelEvent::Message(InboundMessage {
        id: MessageId::new(id),
        chat: ChatId::new(OWNER),
        chat_kind: ChatKind::Direct,
        sender: Participant {
            id: ParticipantId::new(OWNER),
            display_name: None,
            is_admin: false,
        },
        from_self: false,
        at_ms: 1,
        reply_to: None,
        body: InboundBody::Text {
            text: text.to_owned(),
        },
    })
}

/// A linked account of a new agent of the first tenant, with the fake behind its provider.
struct Rig {
    ctx: TenantCtx,
    agent: AgentId,
    account: ChannelAccount,
}

impl Rig {
    async fn new(gateway: &Gateway, tenants: &TwoTenants) -> Self {
        let a = &tenants.a;
        let agent = AgentId::new(named_agent(gateway, &a.admin_session, "pear").await);
        let viewer = Viewer {
            account: a.admin.account_id.clone(),
            admin: true,
        };
        let account = gateway
            .db
            .create_channel_account(&a.ctx, &viewer, &agent, "whatsapp", Some(OWNER))
            .await
            .unwrap();
        assert!(
            gateway
                .db
                .bind_channel_address(&a.ctx, &account.id, NUMBER)
                .await
                .unwrap()
        );
        gateway
            .db
            .set_channel_status(&a.ctx, &account.id, ChannelStatus::Connected)
            .await
            .unwrap();
        Self {
            ctx: a.ctx.clone(),
            agent,
            account,
        }
    }

    /// How many messages the agent has been told of.
    async fn heard(&self, gateway: &Gateway) -> usize {
        gateway
            .db
            .pending_events(&self.ctx, &self.agent, i64::MAX, 100)
            .await
            .unwrap()
            .iter()
            .filter(|event| event.kind == CHANNEL_MESSAGE_EVENT)
            .count()
    }
}

fn hub(gateway: &Gateway, backoff: Backoff, fake: &FakeChannel) -> ChannelHub {
    let hub = ChannelHub::new(
        gateway.db.clone(),
        gateway.slots(),
        CancellationToken::new(),
        backoff,
    );
    let fake = fake.clone();
    hub.register(
        ChannelKind::Whatsapp,
        Arc::new(move |_| Arc::new(fake.clone()) as Arc<dyn Channel>),
    );
    hub
}

fn quick() -> Backoff {
    Backoff::new(Duration::from_millis(20), Duration::from_millis(80))
}

#[tokio::test]
async fn a_dropped_connection_is_made_again_after_the_backoff_and_messages_keep_arriving() {
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    let first_wait = Duration::from_millis(300);
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let hub = hub(
        &gateway,
        Backoff::new(first_wait, Duration::from_secs(2)),
        &fake,
    );

    hub.connect(&rig.ctx, &rig.account, PairingMethod::Resume)
        .unwrap();
    eventually("the first connection", async || {
        fake.connections().len() == 1
    })
    .await;
    // Not a second session of the same account while one is held.
    assert!(
        hub.connect(&rig.ctx, &rig.account, PairingMethod::Resume)
            .is_err()
    );

    fake.push(said("m1", "one"));
    eventually("the first message", async || rig.heard(&gateway).await == 1).await;

    fake.push(ChannelEvent::State(ConnectionState::Disconnected));
    eventually("the second connection", async || {
        fake.connections().len() == 2
    })
    .await;
    let connections = fake.connections();
    let gap = connections[1].1 - connections[0].1;
    // At least the backoff, and not much more than it with its jitter of a quarter.
    assert!(gap >= first_wait, "reconnected after {gap:?}");
    assert!(gap < first_wait * 2, "reconnected after {gap:?}");
    assert_eq!(connections[1].0, PairingMethod::Resume);

    fake.push(said("m2", "two"));
    eventually("the message after the drop", async || {
        rig.heard(&gateway).await == 2
    })
    .await;
    // The provider sent the first again after the drop, as it does when not told it arrived.
    fake.push(said("m1", "one"));
    fake.push(said("m3", "three"));
    eventually("the third message", async || rig.heard(&gateway).await == 3).await;
    assert_eq!(rig.heard(&gateway).await, 3);

    hub.shutdown().await;
    assert_eq!(hub.running(), 0);
    gateway.stop().await;
}

#[tokio::test]
async fn an_instance_that_loses_the_slot_lets_the_connection_go_and_the_next_takes_it_up_once() {
    let mut first = Gateway::start_with(Settings::default(), LONG).await;
    let tenants = TwoTenants::seed(&first.db).await;
    let rig = Rig::new(&first, &tenants).await;
    let fake_a = FakeChannel::new(ChannelKind::Whatsapp);
    let hub_a = hub(&first, quick(), &fake_a);
    hub_a
        .connect(&rig.ctx, &rig.account, PairingMethod::Resume)
        .unwrap();
    eventually("a to connect", async || fake_a.connections().len() == 1).await;
    fake_a.push(said("m1", "one"));
    eventually("m1", async || rig.heard(&first).await == 1).await;

    // The instance stops serving; its leases are still held, so nobody else has the slot yet.
    first.begin_drain().await;
    eventually("a to let go", async || hub_a.running() == 0).await;
    // The session is kept, so whoever takes it over resumes it.
    assert_eq!(fake_a.disconnections(), vec![Disconnect::Keep]);
    // What the old connection hears now is nobody's.
    fake_a.push(said("late", "to nobody"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.heard(&first).await, 1);

    let second = first.join(Settings::default(), LONG).await;
    first.finish_drain().await;
    let owner = second.slots();
    eventually("b to take the slot", async || owner.owns(rig.ctx.id())).await;

    let fake_b = FakeChannel::new(ChannelKind::Whatsapp);
    let hub_b = hub(&second, quick(), &fake_b);
    assert_eq!(hub_b.reconcile().await.unwrap(), 1);
    eventually("b to connect", async || fake_b.connections().len() == 1).await;
    assert_eq!(fake_b.connections()[0].0, PairingMethod::Resume);
    // The provider sends again what it was not told arrived, and one more.
    fake_b.push(said("m1", "one"));
    fake_b.push(said("m2", "two"));
    eventually("m2", async || rig.heard(&second).await == 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rig.heard(&second).await, 2, "m1 was written twice");
    // Nothing starts a second session of an account that is held.
    assert_eq!(hub_b.reconcile().await.unwrap(), 0);

    hub_b.shutdown().await;
    second.stop().await;
    first.stop().await;
}

#[tokio::test]
async fn a_restarted_hub_resumes_the_linked_accounts_without_losing_or_repeating_a_message() {
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    let before = FakeChannel::new(ChannelKind::Whatsapp);
    let hub_before = hub(&gateway, quick(), &before);
    assert_eq!(hub_before.reconcile().await.unwrap(), 1);
    eventually("the connection", async || before.connections().len() == 1).await;
    before.push(said("m1", "one"));
    eventually("m1", async || rig.heard(&gateway).await == 1).await;

    hub_before.shutdown().await;
    assert_eq!(hub_before.running(), 0);
    assert_eq!(before.disconnections(), vec![Disconnect::Keep]);
    // Stopping is not unlinking: the account still says it is connected.
    let kept = gateway
        .db
        .channel_account_of_host(&rig.ctx, &rig.account.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.status, ChannelStatus::Connected);

    let after = FakeChannel::new(ChannelKind::Whatsapp);
    let hub_after = hub(&gateway, quick(), &after);
    assert_eq!(hub_after.reconcile().await.unwrap(), 1);
    eventually("the new connection", async || {
        after.connections().len() == 1
    })
    .await;
    // The one it did not hear while it was down arrives with the one it had, again.
    after.push(said("m1", "one"));
    after.push(said("m2", "two"));
    eventually("m2", async || rig.heard(&gateway).await == 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(rig.heard(&gateway).await, 2);

    hub_after.shutdown().await;
    gateway.stop().await;
}

#[tokio::test]
async fn disconnecting_with_forget_ends_the_session_and_frees_the_number_but_keeping_does_not() {
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let hub = hub(&gateway, quick(), &fake);
    let read = async || {
        gateway
            .db
            .channel_account_of_host(&rig.ctx, &rig.account.id)
            .await
            .unwrap()
            .unwrap()
    };

    hub.connect(&rig.ctx, &rig.account, PairingMethod::Resume)
        .unwrap();
    eventually("the connection", async || fake.connections().len() == 1).await;
    hub.disconnect(&rig.ctx, &rig.account, Disconnect::Keep)
        .await
        .unwrap();
    assert_eq!(hub.running(), 0);
    let kept = read().await;
    assert_eq!(kept.status, ChannelStatus::Disconnected);
    assert_eq!(kept.provider_address.as_deref(), Some(NUMBER));

    hub.disconnect(&rig.ctx, &rig.account, Disconnect::LogOut)
        .await
        .unwrap();
    let forgotten = read().await;
    assert_eq!(forgotten.status, ChannelStatus::NeedsPairing);
    assert_eq!(forgotten.provider_address, None);
    assert_eq!(fake.disconnections().last(), Some(&Disconnect::LogOut));

    // Disconnected accounts are not picked up again by a restart.
    assert_eq!(hub.reconcile().await.unwrap(), 0);
    gateway.stop().await;
}

#[tokio::test]
async fn a_pairing_code_is_in_no_debug_no_log_and_a_different_phone_is_refused() {
    let sink = logs();
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    gateway
        .db
        .clear_channel_address(&rig.ctx, &rig.account.id)
        .await
        .unwrap();
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let hub = hub(&gateway, quick(), &fake);

    hub.connect(
        &rig.ctx,
        &rig.account,
        PairingMethod::Code {
            phone: "5511900000099".to_owned(),
        },
    )
    .unwrap();
    let mut shown = None;
    eventually("the code", async || {
        shown = hub.state(&rig.ctx, &rig.account.id).1;
        shown.is_some()
    })
    .await;
    let prompt = shown.unwrap();
    let PairingPrompt::Code { code } = &prompt else {
        panic!("a code was asked for");
    };
    assert_eq!(code, "FAKE-CODE");
    assert!(!format!("{prompt:?}").contains(code), "{prompt:?}");
    assert_eq!(
        hub.state(&rig.ctx, &rig.account.id).0,
        ConnectionState::Pairing
    );

    // Linked: the code is gone, and the number is the account's for good.
    fake.push(ChannelEvent::Paired {
        account: NUMBER.to_owned(),
    });
    eventually("the number", async || {
        hub.state(&rig.ctx, &rig.account.id).1.is_none()
    })
    .await;
    // Another phone is refused: the session ends and the account is logged out.
    fake.push(ChannelEvent::Paired {
        account: OTHER_NUMBER.to_owned(),
    });
    eventually("the refusal", async || hub.running() == 0).await;
    assert_eq!(fake.disconnections().last(), Some(&Disconnect::LogOut));
    let account = gateway
        .db
        .channel_account_of_host(&rig.ctx, &rig.account.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.status, ChannelStatus::LoggedOut);
    assert_eq!(account.provider_address.as_deref(), Some(NUMBER));

    let printed = sink.lock().unwrap().clone();
    assert!(
        printed.contains("different number"),
        "the capture heard nothing: {printed}"
    );
    for secret in [code.as_str(), NUMBER, OTHER_NUMBER, "5511900000099"] {
        assert!(
            !printed.contains(secret),
            "a log line says {secret}: {printed}"
        );
    }
    gateway.stop().await;
}
