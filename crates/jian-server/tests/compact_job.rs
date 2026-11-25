//! The `thread.compact` job against a real Postgres and a fake provider: it runs as the tenant
//! that queued it, writes a checkpoint there and nowhere else, and a tenant over its token limit
//! ends the job without the provider being called.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::BoxFuture;
use futures_util::stream;
use jian_core::{MessageParts, ModelInfo, ProviderKind, ThreadKind, Visibility};
use jian_llm::{Event, EventStream, LlmError, Provider, Request, StopReason};
use jian_server::{
    JobContext, JobError, JobHandler, Model, ModelSource, THREAD_COMPACT_KIND, ThreadCompactor,
};
use jian_store::{
    Database, DatabaseSource, NewAgent, NewJob, NewMessage, NewThread, Quotas, TenantCtx, ThreadId,
    TokenCounts, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};
use serde_json::json;

#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
}

impl Provider for Fake {
    fn stream<'a>(&'a self, _: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let events = vec![
                Ok(Event::Text("A summary.".to_owned())),
                Ok(Event::Done(StopReason::EndTurn)),
            ];
            Ok(Box::pin(stream::iter(events)) as EventStream)
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct Source(Arc<Fake>);

impl ModelSource for Source {
    fn model(&self, _: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        let provider: Arc<dyn Provider> = self.0.clone();
        Box::pin(async move {
            Some(Model {
                provider,
                kind: ProviderKind::Anthropic,
                model: "m".to_owned(),
            })
        })
    }
}

async fn thread_of(db: &Database, side: &Side, count: usize) -> ThreadId {
    let who = Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    };
    let agent = db
        .create_agent(
            &side.ctx,
            &who,
            &NewAgent {
                name: "pear".to_owned(),
                description: String::new(),
                instructions: String::new(),
                avatar: None,
                visibility: Visibility::Workspace,
                viewers: Vec::new(),
            },
        )
        .await
        .unwrap();
    let new = NewThread {
        kind: ThreadKind::Dm,
        title: None,
        members: Vec::new(),
        agents: vec![agent.id],
    };
    let thread = db
        .create_thread(&side.ctx, &who, &new)
        .await
        .unwrap()
        .unwrap()
        .id;
    for n in 1..=count {
        let message = NewMessage {
            parts: MessageParts::text(format!("message {n}")).unwrap(),
            reply_to: None,
            client_key: None,
        };
        db.post_message(&side.ctx, &who, &thread, message)
            .await
            .unwrap()
            .unwrap();
    }
    thread
}

/// The job as the queue holds it, so its ids are real, with the tenant and database it runs as.
async fn context(test: &TestDb, side: &Side, payload: serde_json::Value) -> JobContext {
    let job = test
        .db
        .enqueue_job(&side.ctx, NewJob::new(THREAD_COMPACT_KIND, payload))
        .await
        .unwrap()
        .job;
    let db = Database::open(DatabaseSource::External(test.url.clone()))
        .await
        .unwrap()
        .with_master_keys(jian_testkit::master_keys());
    JobContext {
        job,
        tenant: side.ctx.clone(),
        db: Arc::new(db),
    }
}

fn of(thread: &ThreadId) -> serde_json::Value {
    json!({ "threadId": thread.as_str() })
}

#[tokio::test]
async fn a_compaction_job_runs_as_its_own_tenant_and_a_tenant_over_its_limit_costs_the_provider_nothing()
 {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let thread_a = thread_of(&test.db, a, 30).await;
    let fake = Arc::new(Fake::default());
    let handler = ThreadCompactor::new(Arc::new(Source(fake.clone())));

    // B's job naming A's thread finds no such thread in B's schema, and calls nobody.
    let crossed = handler.handle(context(&test, b, of(&thread_a)).await).await;
    assert!(matches!(crossed, Err(JobError::Retry(_))));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);

    // Over its limit, A's job ends for good and the provider is not called.
    let limit = Quotas {
        monthly_tokens: Some(5),
        ..Quotas::default()
    };
    test.db.set_quotas(&a.ctx, &limit).await.unwrap();
    let counts = TokenCounts {
        input: 5,
        ..TokenCounts::default()
    };
    test.db
        .record_usage(&a.ctx, ProviderKind::Groq, "m", counts, None)
        .await
        .unwrap();
    let refused = handler.handle(context(&test, a, of(&thread_a)).await).await;
    assert!(matches!(refused, Err(JobError::Permanent(_))));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);

    // With room, the same job writes A's checkpoint: 30 messages, the newest 12 stay out.
    test.db
        .set_quotas(&a.ctx, &Quotas::default())
        .await
        .unwrap();
    handler
        .handle(context(&test, a, of(&thread_a)).await)
        .await
        .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    let saved = test.db.latest_checkpoint(&a.ctx, &thread_a).await.unwrap();
    assert_eq!(saved.map(|c| c.upto_seq), Some(18));
    assert!(
        test.db
            .latest_checkpoint(&b.ctx, &thread_a)
            .await
            .unwrap()
            .is_none()
    );
    // A job with no thread in its payload is no use to retry.
    let mut empty = context(&test, a, of(&thread_a)).await;
    empty.job.payload = json!({});
    assert!(matches!(
        handler.handle(empty).await,
        Err(JobError::Permanent(_))
    ));
}
