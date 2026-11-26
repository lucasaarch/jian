//! Compaction and the context a turn reads, against a real Postgres and a fake provider: the
//! rows read follow the budget and not the thread, one compaction runs per thread, a tenant over
//! its token limit costs the provider nothing, and tenant B reaches none of tenant A's threads.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream;
use jian_core::{MessageParts, ModelInfo, ProviderKind, ThreadKind, Visibility};
use jian_llm::{Event, LlmError, Provider, Request, StopReason, Usage};
use jian_runtime::{
    CompactError, Compacted, Compactor, History, PAGE, build_context, queue_compaction_if_due,
};
use jian_store::{
    Checkpoint, Database, HistoryRow, NewAgent, NewMessage, NewThread, Quotas, StoreError,
    ThreadId, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

/// A provider that answers with one fixed summary and remembers what it was asked.
#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
    asked: Mutex<Vec<String>>,
}

impl Provider for Fake {
    fn stream<'a>(
        &'a self,
        request: &'a Request,
    ) -> BoxFuture<'a, Result<jian_llm::EventStream, LlmError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.asked.lock().unwrap().push(format!("{request:?}"));
            // Long enough for concurrent compactions to meet.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let events = vec![
                Ok(Event::Text("They talked about pears.".to_owned())),
                Ok(Event::Usage(Usage {
                    input_tokens: 30,
                    output_tokens: 5,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                })),
                Ok(Event::Done(StopReason::EndTurn)),
            ];
            Ok(Box::pin(stream::iter(events)) as jian_llm::EventStream)
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

fn wall_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

fn viewer(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

/// A thread of `count` messages, "message 1" and so on, in `side`'s tenant.
async fn thread_of(db: &Database, side: &Side, count: usize) -> ThreadId {
    let who = viewer(side);
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
    let thread = db
        .create_thread(
            &side.ctx,
            &who,
            &NewThread {
                kind: ThreadKind::Dm,
                title: None,
                members: Vec::new(),
                agents: vec![agent.id],
            },
        )
        .await
        .unwrap()
        .unwrap()
        .id;
    for n in 1..=count {
        let new = NewMessage {
            parts: MessageParts::text(format!("message {n}")).unwrap(),
            reply_to: None,
            client_key: None,
        };
        db.post_message(&side.ctx, &who, &thread, new)
            .await
            .unwrap()
            .unwrap();
    }
    thread
}

fn compactor<'a>(
    db: &'a Database,
    side: &'a Side,
    fake: &'a Fake,
    keep_recent: usize,
) -> Compactor<'a, Fake> {
    Compactor {
        db,
        ctx: &side.ctx,
        provider: fake,
        kind: ProviderKind::Anthropic,
        model: "m",
        keep_recent,
    }
}

/// A thread that is only a counter: a million messages, none of them held, so the test can say
/// how many a context build asked for.
struct Endless {
    served: AtomicUsize,
}

impl History for Endless {
    fn checkpoint(
        &self,
        _: &ThreadId,
    ) -> impl Future<Output = Result<Option<Checkpoint>, StoreError>> + Send {
        std::future::ready(Ok(None))
    }

    fn page(
        &self,
        _: &ThreadId,
        after_seq: i64,
        before_seq: Option<i64>,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<HistoryRow>, StoreError>> + Send {
        let top = before_seq.map_or(1_000_000, |b| b - 1);
        let rows: Vec<HistoryRow> = (after_seq + 1..=top)
            .rev()
            .take(limit as usize)
            .map(|seq| HistoryRow {
                seq,
                from_agent: false,
                agent: None,
                text: "forty bytes of text, more or less....".to_owned(),
            })
            .collect();
        self.served.fetch_add(rows.len(), Ordering::SeqCst);
        std::future::ready(Ok(rows))
    }
}

#[tokio::test]
async fn the_rows_a_context_reads_follow_its_budget_and_not_the_length_of_the_thread() {
    let thread = ThreadId::new("thr_endless");
    for budget in [100_u64, 1_000] {
        let history = Endless {
            served: AtomicUsize::new(0),
        };
        let context = build_context(&history, &thread, budget).await.unwrap();
        let read = history.served.load(Ordering::SeqCst);
        // A million messages, and the build read one or two pages of them.
        assert_eq!(read, context.rows_read);
        // What fits, and at most the page that overshot the budget.
        let most = context.messages.len() + PAGE as usize;
        assert!(read <= most, "read {read} rows for a budget of {budget}");
        assert!(read < 1_000, "a million-message thread read {read} rows");
        assert!(context.tokens <= budget);
        let seqs: Vec<i64> = context.messages.iter().map(|m| m.seq).collect();
        // The newest messages, oldest first, with nothing missing in between.
        assert_eq!(seqs.last(), Some(&1_000_000));
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    }
}

#[tokio::test]
async fn a_context_is_the_latest_summary_and_the_messages_after_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let thread = thread_of(db, &side, 12).await;
    let fake = Fake::default();

    let done = compactor(db, &side, &fake, 4)
        .compact(&thread, wall_ms())
        .await
        .unwrap();
    assert_eq!(done, Compacted::Done { upto_seq: 8 });
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    assert!(fake.asked.lock().unwrap()[0].contains("message 8"));

    let history = jian_runtime::StoreHistory { db, ctx: &side.ctx };
    let context = build_context(&history, &thread, 10_000).await.unwrap();
    assert_eq!(context.summary.as_deref(), Some("They talked about pears."));
    assert_eq!(context.summarized_to, 8);
    let texts: Vec<&str> = context.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts,
        ["message 9", "message 10", "message 11", "message 12"]
    );
    // Only the tail was read: the eight summarized messages stay in the database, untouched.
    assert_eq!(context.rows_read, 4);

    // Nothing older than the recent four is left, so a second one asks nobody.
    let again = compactor(db, &side, &fake, 4)
        .compact(&thread, wall_ms())
        .await
        .unwrap();
    assert_eq!(again, Compacted::NothingToDo);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    // The provider call was paid for, and counted against the tenant.
    assert_eq!(
        db.tokens_this_month(&side.ctx, wall_ms()).await.unwrap(),
        35
    );
}

#[tokio::test]
async fn one_compaction_runs_per_thread_at_a_time_and_a_dead_ones_claim_runs_out() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let thread = thread_of(db, &side, 10).await;
    let fake = Fake::default();

    let compactors: Vec<_> = (0..4).map(|_| compactor(db, &side, &fake, 2)).collect();
    let results =
        futures_util::future::join_all(compactors.iter().map(|c| c.compact(&thread, wall_ms())))
            .await;
    let outcomes: Vec<Compacted> = results.into_iter().map(Result::unwrap).collect();
    let done = outcomes
        .iter()
        .filter(|o| matches!(o, Compacted::Done { .. }))
        .count();
    assert_eq!(done, 1, "{outcomes:?}");
    assert!(outcomes.contains(&Compacted::Busy), "{outcomes:?}");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);

    // A worker that died holding the claim blocks the thread until the claim runs out.
    let now = wall_ms();
    assert!(
        db.claim_compaction(&side.ctx, &thread, 60_000, now)
            .await
            .unwrap()
    );
    let blocked = compactor(db, &side, &fake, 2).compact(&thread, now).await;
    assert_eq!(blocked.unwrap(), Compacted::Busy);
    assert!(
        db.claim_compaction(&side.ctx, &thread, 60_000, now + 61_000)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_tenant_over_its_token_limit_costs_the_provider_nothing_and_the_other_is_unaffected() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let (a, b) = (&tenants.a, &tenants.b);
    let thread_a = thread_of(db, a, 8).await;
    let thread_b = thread_of(db, b, 8).await;
    let limit = Quotas {
        monthly_tokens: Some(10),
        ..Quotas::default()
    };
    db.set_quotas(&a.ctx, &limit).await.unwrap();
    db.set_quotas(&b.ctx, &limit).await.unwrap();
    db.record_usage(
        &a.ctx,
        ProviderKind::Anthropic,
        "m",
        jian_store::TokenCounts {
            input: 10,
            ..jian_store::TokenCounts::default()
        },
        None,
    )
    .await
    .unwrap();

    let fake = Fake::default();
    let refused = compactor(db, a, &fake, 2)
        .compact(&thread_a, wall_ms())
        .await;
    assert!(matches!(
        refused,
        Err(CompactError::Store(StoreError::QuotaExceeded(_)))
    ));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    assert!(
        db.latest_checkpoint(&a.ctx, &thread_a)
            .await
            .unwrap()
            .is_none()
    );

    // B used nothing, so B's compaction goes ahead.
    let ok = compactor(db, b, &fake, 2)
        .compact(&thread_b, wall_ms())
        .await
        .unwrap();
    assert_eq!(ok, Compacted::Done { upto_seq: 6 });
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);

    // Its claim cannot even be made: A's thread is not in B's schema.
    let theirs = compactor(db, b, &fake, 2)
        .compact(&thread_a, wall_ms())
        .await;
    assert!(matches!(theirs, Err(CompactError::Store(_))));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    assert!(
        db.latest_checkpoint(&b.ctx, &thread_a)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(db.last_seq(&b.ctx, &thread_a).await.unwrap(), 0);
}

#[tokio::test]
async fn a_thread_that_grows_to_the_window_queues_one_compaction_and_a_short_one_none() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let thread = thread_of(db, &side, 20).await;

    // Twenty short messages are far under a real window.
    assert!(
        !queue_compaction_if_due(db, &side.ctx, &thread, 200_000)
            .await
            .unwrap()
    );
    // And over a window of 100 tokens: queued once, however often it is asked.
    assert!(
        queue_compaction_if_due(db, &side.ctx, &thread, 100)
            .await
            .unwrap()
    );
    assert!(
        !queue_compaction_if_due(db, &side.ctx, &thread, 100)
            .await
            .unwrap()
    );
}
