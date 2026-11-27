//! What every channel promises, shown on the in-memory one through `dyn Channel`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{
    Backoff, Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ChatKind, ConnectionState,
    Disconnect, InboundBody, InboundMessage, MessageId, OutboundContent, OutboundMessage,
    PairingMethod, PairingPrompt, Participant, ParticipantId,
};

fn message(id: &str, from_self: bool) -> InboundMessage {
    InboundMessage {
        id: MessageId::new(id),
        chat: ChatId::new("chat-1"),
        chat_kind: ChatKind::Direct,
        sender: Participant {
            id: ParticipantId::new("person-1"),
            display_name: None,
            is_admin: false,
        },
        from_self,
        at_ms: 1,
        reply_to: None,
        body: InboundBody::Text {
            text: "hello".to_owned(),
        },
    }
}

#[test]
fn backoff_doubles_and_stops_at_the_cap() {
    let backoff = Backoff::new(Duration::from_secs(2), Duration::from_secs(60));
    let waits: Vec<u64> = (0..7).map(|n| backoff.delay(n).as_secs()).collect();
    assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60]);
    // A huge attempt count neither overflows nor passes the cap.
    assert_eq!(backoff.delay(u32::MAX), Duration::from_secs(60));
    // A cap below the first wait is the first wait.
    let odd = Backoff::new(Duration::from_secs(5), Duration::from_secs(1));
    assert_eq!(odd.delay(3), Duration::from_secs(5));
}

#[test]
fn a_kind_round_trips_through_its_name() {
    for kind in [
        ChannelKind::Whatsapp,
        ChannelKind::Telegram,
        ChannelKind::Discord,
        ChannelKind::Slack,
        ChannelKind::Teams,
    ] {
        assert_eq!(ChannelKind::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(ChannelKind::parse("email"), None);
}

#[test]
fn a_pairing_prompt_never_prints_its_code() {
    let qr = PairingPrompt::Qr {
        payload: "2@secret-qr-payload".to_owned(),
    };
    let code = PairingPrompt::Code {
        code: "ABCD-1234".to_owned(),
    };
    let printed = format!("{qr:?} {code:?}");
    assert!(!printed.contains("secret-qr-payload") && !printed.contains("ABCD-1234"));
    let event = format!("{:?}", ChannelEvent::Pairing(qr));
    assert!(!event.contains("secret-qr-payload"));
}

#[tokio::test]
async fn events_come_in_order_and_sending_needs_a_connection() {
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let channel: Arc<dyn Channel> = Arc::new(fake.clone());
    let mut events = channel.events();

    let out = OutboundMessage {
        chat: ChatId::new("chat-1"),
        content: OutboundContent::Text("hi".to_owned()),
        reply_to: None,
    };
    assert!(matches!(
        channel.send(out.clone()).await,
        Err(ChannelError::NotConnected)
    ));

    channel.connect(PairingMethod::Qr).await.unwrap();
    fake.push(ChannelEvent::Message(message("m1", false)));
    fake.push(ChannelEvent::Message(message("m2", true)));
    fake.push(ChannelEvent::State(ConnectionState::Connected));

    assert_eq!(
        events.next().await,
        Some(ChannelEvent::State(ConnectionState::Pairing))
    );
    assert!(matches!(
        events.next().await,
        Some(ChannelEvent::Pairing(_))
    ));
    let Some(ChannelEvent::Message(first)) = events.next().await else {
        panic!("a message was expected");
    };
    let Some(ChannelEvent::Message(second)) = events.next().await else {
        panic!("a message was expected");
    };
    assert_eq!((first.id.as_str(), second.id.as_str()), ("m1", "m2"));
    assert!(!first.from_self && second.from_self);

    // The state is where the provider is now; the stream is the history, read at its own pace.
    assert_eq!(channel.state(), ConnectionState::Connected);
    assert_eq!(
        events.next().await,
        Some(ChannelEvent::State(ConnectionState::Connected))
    );
    channel.send(out).await.unwrap();
    assert_eq!(fake.sent().len(), 1);
}

#[tokio::test]
async fn an_uncertain_send_is_reported_and_not_repeated_by_the_channel() {
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    fake.push(ChannelEvent::State(ConnectionState::Connected));
    fake.fail_next_send(ChannelError::SendUncertain);
    let out = OutboundMessage {
        chat: ChatId::new("chat-1"),
        content: OutboundContent::Text("once".to_owned()),
        reply_to: None,
    };
    assert!(matches!(
        fake.send(out).await,
        Err(ChannelError::SendUncertain)
    ));
    assert!(fake.sent().is_empty());
}

#[tokio::test]
async fn logging_out_ends_in_the_logged_out_state() {
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    fake.connect(PairingMethod::Resume).await.unwrap();
    assert_eq!(fake.state(), ConnectionState::Connected);
    fake.disconnect(Disconnect::LogOut).await.unwrap();
    assert_eq!(fake.state(), ConnectionState::LoggedOut);
}
