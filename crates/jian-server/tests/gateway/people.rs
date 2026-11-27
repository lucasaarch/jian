//! What an agent knows about people, through the gateway: a stranger who writes gets a run that
//! can only tell the creator, and the creator is told once; the creator's `/confirm` links an
//! identity; and the routes show an agent's people to nobody but who manages it.

use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{
    ChannelEvent, ChannelKind, ChatId, ChatKind, InboundBody, InboundMessage, MessageId,
    OutboundContent, Participant, ParticipantId,
};
use jian_server::{TELL_CREATOR, people_tools, stranger_tools};
use jian_store::{Identity, PersonRole, RunOrigin, Sender};
use jian_testkit::TwoTenants;
use serde_json::json;

use super::accounts::{open_settings, start};
use super::channel_hub::{Rig, eventually, hub, quick};
use super::channels::{call, named_agent};
use super::support::Gateway;

const OWNER: &str = "5511900000001@s.whatsapp.net";
const STRANGER: &str = "5511911110000@s.whatsapp.net";

fn text_from(chat: &str, id: &str, text: &str) -> ChannelEvent {
    ChannelEvent::Message(InboundMessage {
        id: MessageId::new(id),
        chat: ChatId::new(chat),
        chat_kind: ChatKind::Direct,
        sender: Participant {
            id: ParticipantId::new(chat),
            display_name: Some("Zed".to_owned()),
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

#[test]
fn a_strangers_run_has_the_one_tool_that_tells_the_creator_and_no_data_tool() {
    assert_eq!(stranger_tools(None).names(), [TELL_CREATOR]);
    // The tools that read or change people are for the other runs, never in the stranger's list.
    assert!(!people_tools(None).is_empty());
}

#[tokio::test]
async fn a_stranger_gets_a_limited_run_and_the_creator_is_told_once() {
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let hub = hub(&gateway, quick(), &fake);
    assert_eq!(hub.reconcile().await.unwrap(), 1);
    eventually("the connection", async || fake.connections().len() == 1).await;

    fake.push(text_from(STRANGER, "s1", "hi, is this the shop?"));
    eventually("the creator is told", async || {
        fake.sent().iter().any(|m| m.chat.as_str() == OWNER)
    })
    .await;
    // The same person writing again is not a second note to the creator.
    fake.push(text_from(STRANGER, "s2", "hello?"));
    eventually("the second message is stored", async || {
        let thread = gateway
            .db
            .open_channel_thread(
                &rig.ctx,
                &rig.account,
                STRANGER,
                "whatsapp: zed",
                ("zed", "Zed"),
            )
            .await
            .unwrap();
        gateway
            .db
            .list_runs(&rig.ctx, &thread, 10)
            .await
            .unwrap()
            .len()
            == 1
    })
    .await;
    let to_creator: Vec<_> = fake
        .sent()
        .into_iter()
        .filter(|m| m.chat.as_str() == OWNER)
        .collect();
    assert_eq!(to_creator.len(), 1);
    assert!(
        matches!(&to_creator[0].content, OutboundContent::Text(t) if t.contains("hi, is this"))
    );

    // The run is the stranger kind; nothing was told to the agent as a message, and writing made
    // nobody a person.
    let thread = gateway
        .db
        .open_channel_thread(
            &rig.ctx,
            &rig.account,
            STRANGER,
            "whatsapp: zed",
            ("zed", "Zed"),
        )
        .await
        .unwrap();
    let runs = gateway.db.list_runs(&rig.ctx, &thread, 10).await.unwrap();
    assert_eq!(runs[0].origin, RunOrigin::Stranger);
    let heard = gateway
        .db
        .pending_events(&rig.ctx, &rig.agent, i64::MAX, 100)
        .await
        .unwrap();
    assert!(
        heard
            .iter()
            .all(|e| e.kind != jian_server::CHANNEL_MESSAGE_EVENT)
    );
    assert_eq!(
        gateway
            .db
            .resolve_sender(&rig.ctx, &rig.account, STRANGER)
            .await
            .unwrap(),
        Sender::Unknown
    );

    hub.shutdown().await;
    gateway.stop().await;
}

#[tokio::test]
async fn only_the_creator_confirms_a_new_identity_through_the_chat() {
    let gateway = Gateway::start(open_settings()).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    let rig = Rig::new(&gateway, &tenants).await;
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let hub = hub(&gateway, quick(), &fake);
    assert_eq!(hub.reconcile().await.unwrap(), 1);
    eventually("the connection", async || fake.connections().len() == 1).await;
    let db = &gateway.db;
    let ana = db
        .create_person(&rig.ctx, &rig.agent, "Ana", PersonRole::Known, &[], "test")
        .await
        .unwrap();
    let asked = db
        .request_identity_link(
            &rig.ctx,
            &rig.agent,
            &ana.id,
            &Identity::new("whatsapp", STRANGER),
            "run:test",
        )
        .await
        .unwrap()
        .unwrap();

    // The stranger sending the code does nothing.
    fake.push(text_from(
        STRANGER,
        "c1",
        &format!("/confirm {}", asked.request.code),
    ));
    fake.push(text_from(
        OWNER,
        "c2",
        &format!("/confirm {}", asked.request.code),
    ));
    eventually("the creator hears it was linked", async || {
        fake.sent().iter().any(|m| {
            m.chat.as_str() == OWNER
                && matches!(&m.content, OutboundContent::Text(t) if t.starts_with("Linked"))
        })
    })
    .await;
    assert!(matches!(
        db.resolve_sender(&rig.ctx, &rig.account, STRANGER).await.unwrap(),
        Sender::Person(p) if p.id == ana.id
    ));

    hub.shutdown().await;
    gateway.stop().await;
}

#[tokio::test]
async fn the_people_of_an_agent_are_invisible_to_other_agents_and_other_workspaces() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = tenants.a.admin_session.as_str();
    let member = tenants.a.member_session.as_str();
    let other = tenants.b.admin_session.as_str();
    let agent = named_agent(&gateway, admin, "pear").await;
    let plum = named_agent(&gateway, admin, "plum").await;
    let people = format!("/v1/agents/{agent}/people");

    // Adding someone who never wrote: no message, no channel connected.
    let body = json!({
        "name": "Ana",
        "role": "known",
        "identities": [{ "channel": "whatsapp", "address": "5511922220000" }]
    });
    let (status, made) = call(&gateway, "POST", &people, admin, Some(body.clone())).await;
    assert_eq!(status, 201, "{made}");
    let id = made["id"].as_str().unwrap().to_owned();
    let one = format!("{people}/{id}");
    let (status, listed) = call(&gateway, "GET", &people, admin, None).await;
    assert_eq!(status, 200);
    assert!(
        listed["people"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == id)
    );
    // Not two people with one number.
    assert_eq!(
        call(&gateway, "POST", &people, admin, Some(body.clone()))
            .await
            .0,
        409
    );

    let address = "/identities/whatsapp/5511922220000";
    let identity = json!({ "channel": "telegram", "address": "42" });
    let requests = format!("/v1/agents/{agent}/identity-requests");
    // Another workspace finds no such agent at all.
    for (method, path, payload) in [
        ("GET", people.clone(), None),
        ("POST", people.clone(), Some(body.clone())),
        ("GET", one.clone(), None),
        ("PATCH", one.clone(), Some(json!({ "name": "X" }))),
        ("DELETE", one.clone(), None),
        ("POST", format!("{one}/identities"), Some(identity.clone())),
        ("DELETE", format!("{one}{address}"), None),
        ("GET", requests.clone(), None),
        ("POST", format!("{requests}/x/confirm"), None),
        ("POST", format!("{requests}/x/decline"), None),
    ] {
        let (status, _) = call(&gateway, method, &path, other, payload).await;
        assert_eq!(status, 404, "{method} {path}");
    }
    // A member who only sees the agent may not read or change what it knows of anyone.
    for (method, path, payload) in [
        ("GET", people.clone(), None),
        ("POST", people.clone(), Some(body.clone())),
        ("GET", one.clone(), None),
        ("DELETE", one.clone(), None),
        ("GET", requests.clone(), None),
        ("POST", format!("{requests}/x/confirm"), None),
    ] {
        let (status, _) = call(&gateway, method, &path, member, payload).await;
        assert_eq!(status, 403, "{method} {path}");
    }
    // Another agent of the same workspace does not know Ana.
    let (status, _) = call(
        &gateway,
        "GET",
        &format!("/v1/agents/{plum}/people/{id}"),
        admin,
        None,
    )
    .await;
    assert_eq!(status, 404);

    // A link the agent asked for waits for the creator: another workspace cannot decide it, and
    // the creator's confirm adds the identity.
    let db = &gateway.db;
    let ctx = &tenants.a.ctx;
    let person = jian_store::PersonId::new(id.clone());
    let agent_id = jian_store::AgentId::new(agent.clone());
    let asked = db
        .request_identity_link(
            ctx,
            &agent_id,
            &person,
            &Identity::new("telegram", "42"),
            "run:t",
        )
        .await
        .unwrap()
        .unwrap();
    let confirm = format!("{requests}/{}/confirm", asked.request.id);
    assert_eq!(call(&gateway, "POST", &confirm, other, None).await.0, 404);
    let (status, waiting) = call(&gateway, "GET", &requests, admin, None).await;
    assert_eq!(status, 200);
    assert_eq!(waiting["requests"].as_array().unwrap().len(), 1);
    assert_eq!(call(&gateway, "POST", &confirm, admin, None).await.0, 200);
    let (_, ana) = call(&gateway, "GET", &one, admin, None).await;
    assert_eq!(ana["identities"].as_array().unwrap().len(), 2);

    // Declining leaves the identity unlinked.
    let asked = db
        .request_identity_link(
            ctx,
            &agent_id,
            &person,
            &Identity::new("slack", "U1"),
            "run:t",
        )
        .await
        .unwrap()
        .unwrap();
    let decline = format!("{requests}/{}/decline", asked.request.id);
    assert_eq!(call(&gateway, "POST", &decline, admin, None).await.0, 200);
    let (_, ana) = call(&gateway, "GET", &one, admin, None).await;
    assert_eq!(ana["identities"].as_array().unwrap().len(), 2);

    assert_eq!(call(&gateway, "DELETE", &one, admin, None).await.0, 204);
    assert_eq!(call(&gateway, "GET", &one, admin, None).await.0, 404);
    gateway.stop().await;
}
