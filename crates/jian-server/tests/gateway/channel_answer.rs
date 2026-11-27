//! A run that goes through the real `agent.run` job, in a chat thread, answers the chat: once,
//! never on a wake, and never again after a send that failed. The model is scripted and the
//! channel is a fake; Postgres is real. Nothing leaves the machine.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{ChannelError, ChannelKind, OutboundContent};
use jian_core::ProviderKind;
use jian_server::{
    AgentRunner, ChannelHub, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
};
use jian_store::{NewJob, Run, RunOrigin, RunState, TenantCtx};
use jian_testkit::{FakeExecutor, FakeMachineScript, FakeProvider, TwoTenants, say};
use serde_json::json;

use super::accounts::open_settings;
use super::channel_hub::{NUMBER, Rig, eventually, hub, quick};
use super::support::Gateway;

/// Every tenant gets the same scripted model.
struct Scripted(Arc<FakeProvider>);

impl ModelSource for Scripted {
    fn model(&self, _: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        Box::pin(async move {
            Some(Model {
                provider: self.0.clone(),
                kind: ProviderKind::Anthropic,
                model: "fake".to_owned(),
                context_window: 100_000,
            })
        })
    }
}

/// A gateway with a connected fake channel, and the pieces a run in its chat needs.
struct Chat {
    gateway: Gateway,
    rig: Rig,
    fake: FakeChannel,
    hub: ChannelHub,
}

impl Chat {
    async fn open() -> Self {
        let gateway = Gateway::start(open_settings()).await;
        let tenants = TwoTenants::seed(&gateway.db).await;
        let rig = Rig::new(&gateway, &tenants).await;
        let fake = FakeChannel::new(ChannelKind::Whatsapp);
        let hub = hub(&gateway, quick(), &fake);
        assert_eq!(hub.reconcile().await.unwrap(), 1);
        eventually("the connection", async || fake.connections().len() == 1).await;
        Self {
            gateway,
            rig,
            fake,
            hub,
        }
    }

    /// Starts a run of `origin` in the chat's thread and runs its job to the end, with a model
    /// that says `words`. Returns the run as it ended and how many times the model was asked.
    async fn run(&self, origin: RunOrigin, words: &str) -> (Run, usize) {
        let (db, ctx) = (&self.gateway.db, &self.rig.ctx);
        let thread = db
            .open_channel_thread(
                ctx,
                &self.rig.account,
                NUMBER,
                "whatsapp: ana",
                ("ana", "Ana"),
            )
            .await
            .unwrap();
        let (run, _) = db
            .start_run(ctx, &thread, &self.rig.agent, None, 0, origin)
            .await
            .unwrap();
        let model = FakeProvider::new(vec![say(words)]);
        let runner = AgentRunner::new(
            Arc::new(Scripted(model.clone())),
            FakeExecutor::new(FakeMachineScript::default()),
            Arc::new(MemoryEventBus::new()),
        )
        .with_channels(self.hub.clone());
        let job = db
            .enqueue_job(ctx, NewJob::new(RUN_KIND, json!({ "runId": run.id })))
            .await
            .unwrap()
            .job;
        runner
            .handle(JobContext {
                job,
                tenant: ctx.clone(),
                db: db.clone(),
            })
            .await
            .unwrap();
        let ended = db.run_by_id(ctx, &run.id).await.unwrap().unwrap();
        (ended, model.streams())
    }

    async fn stop(self) {
        self.hub.shutdown().await;
        self.gateway.stop().await;
    }
}

#[tokio::test]
async fn a_run_in_a_chat_thread_answers_the_chat_once_through_the_job() {
    let chat = Chat::open().await;
    let (run, asked) = chat.run(RunOrigin::Message, "on my way").await;
    assert_eq!(run.state, RunState::Done, "{run:?}");
    assert_eq!(asked, 1);

    let sent = chat.fake.sent();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].chat.as_str(), NUMBER);
    assert!(matches!(&sent[0].content, OutboundContent::Text(text) if text == "on my way"));
    chat.stop().await;
}

#[tokio::test]
async fn a_wake_run_says_nothing_to_the_chat_even_when_it_ends_done() {
    let chat = Chat::open().await;
    let (run, asked) = chat.run(RunOrigin::Wake, "the owner may want this").await;
    assert_eq!(run.state, RunState::Done, "{run:?}");
    assert_eq!(asked, 1);
    assert!(chat.fake.sent().is_empty(), "{:?}", chat.fake.sent());
    chat.stop().await;
}

#[tokio::test]
async fn a_send_that_fails_is_not_sent_again_and_does_not_fail_the_run() {
    let chat = Chat::open().await;
    chat.fake
        .fail_next_send(ChannelError::Transport("the line dropped".to_owned()));
    let (run, _) = chat.run(RunOrigin::Message, "on my way").await;
    // The run said its words; the chat is a courtesy of it, not part of it.
    assert_eq!(run.state, RunState::Done, "{run:?}");
    // A retry would have found the fake working again and sent it.
    assert!(chat.fake.sent().is_empty(), "{:?}", chat.fake.sent());
    chat.stop().await;
}
