//! What a tool is to the agent loop, and the registry of the ones a run has.
//!
//! A tool is a name, a schema the model reads, and a call. Two things are said up front so the
//! loop can act before it calls: whether the tool needs a machine (so the run wakes one only when
//! the first such tool is called) and whether a person must allow the call.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::future::BoxFuture;
use jian_exec::{ExecError, Executor, Machine, Scope};
use jian_llm::ToolSpec;
use jian_skills::RunSkills;
use jian_store::{AgentId, Database, TenantCtx, ThreadId};
use serde_json::Value;
use tokio::sync::OnceCell;

/// The machine of one run, woken the first time a tool asks for it and never twice.
///
/// It lives outside the loop's future, so whoever drives the loop can still read how long the
/// machine was awake when the loop is dropped by a stop or a panic.
pub struct MachineSlot {
    executor: Arc<dyn Executor>,
    scope: Scope,
    machine: OnceCell<Box<dyn Machine>>,
    woke_at: Mutex<Option<Instant>>,
    /// Machine time the run spent in earlier jobs (it was parked on a subagent and resumed):
    /// each job has its own slot, and the run's recorded time must only ever grow.
    base_ms: u64,
}

impl MachineSlot {
    /// A slot with nothing awake yet.
    #[must_use]
    pub fn new(executor: Arc<dyn Executor>, scope: Scope) -> Self {
        Self {
            executor,
            scope,
            machine: OnceCell::new(),
            woke_at: Mutex::new(None),
            base_ms: 0,
        }
    }

    /// The same slot for a run that already held a machine for `ms` before this job.
    #[must_use]
    pub fn with_base_ms(mut self, ms: u64) -> Self {
        self.base_ms = ms;
        self
    }

    /// The machine, waking it on the first call. Two tools asking at once wake one.
    pub async fn get(&self) -> Result<&dyn Machine, ExecError> {
        let machine = self
            .machine
            .get_or_try_init(|| async {
                let machine = self.executor.open(&self.scope).await?;
                if let Ok(mut at) = self.woke_at.lock() {
                    *at = Some(Instant::now());
                }
                Ok::<_, ExecError>(machine)
            })
            .await?;
        Ok(machine.as_ref())
    }

    /// How long the run's machine has been awake in milliseconds, earlier jobs included, at
    /// least 1 once it was woken here, and `None` when this job never woke it.
    #[must_use]
    pub fn machine_ms(&self) -> Option<u64> {
        let at = (*self.woke_at.lock().ok()?)?;
        let here = u64::try_from(at.elapsed().as_millis())
            .unwrap_or(u64::MAX)
            .max(1);
        Some(self.base_ms.saturating_add(here))
    }
}

/// What a tool may reach while it runs.
pub struct ToolEnv<'a> {
    /// The database.
    pub db: &'a Database,
    /// The tenant.
    pub ctx: &'a TenantCtx,
    /// The agent that runs.
    pub agent: &'a AgentId,
    /// The thread it runs in.
    pub thread: &'a ThreadId,
    /// The run, which a tool that makes other work for it keys that work by.
    pub run: &'a str,
    /// The model's id for the call being run: unchanged when the call is run again after the
    /// run waited on it.
    pub call_id: &'a str,
    /// The skills the run offers.
    pub skills: &'a RunSkills,
    /// The run's machine.
    pub machine: &'a MachineSlot,
    /// Now, in Unix milliseconds.
    pub now_ms: i64,
}

/// A tool the model may call. The `Err` of a call is text for the model: it reads it as the
/// tool's failure and may try something else.
pub trait Tool: Send + Sync {
    /// The name the model calls it by.
    fn name(&self) -> &'static str;

    /// What the model reads of it.
    fn spec(&self) -> ToolSpec;

    /// Whether it runs on the run's machine. Such a tool wakes the machine on its first call.
    fn needs_machine(&self) -> bool;

    /// Whether the tool only reads: it changes nothing, here or on the machine. A run that may
    /// only suggest (a wake of an agent in `suggest` mode) has these and no other. The default
    /// is no, so a new tool is out of such a run until someone says it is safe.
    fn read_only(&self) -> bool {
        false
    }

    /// Runs the call.
    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>>;

    /// What the loop runs: the call, or `Ok(None)` when it cannot answer yet and the run must
    /// park on it until something outside ends the wait (a subagent's report). The loop runs the
    /// call again, with the same [`ToolEnv::call_id`], when it goes on, so a tool that can wait
    /// must find what it started the first time. Most tools just call.
    fn settle<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.call(input, env).await.map(Some) })
    }
}

/// The tools a run has.
#[derive(Clone, Default)]
pub struct Tools(Vec<Arc<dyn Tool>>);

impl Tools {
    /// No tools.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a tool.
    #[must_use]
    pub fn with(mut self, tool: Arc<dyn Tool>) -> Self {
        self.0.push(tool);
        self
    }

    /// Adds several tools.
    #[must_use]
    pub fn with_all(mut self, tools: impl IntoIterator<Item = Arc<dyn Tool>>) -> Self {
        self.0.extend(tools);
        self
    }

    /// The same set without the tools called `names`.
    #[must_use]
    pub fn without(mut self, names: &[&str]) -> Self {
        self.0.retain(|tool| !names.contains(&tool.name()));
        self
    }

    /// The same set with only the tools that [`read_only`](Tool::read_only).
    #[must_use]
    pub fn read_only(mut self) -> Self {
        self.0.retain(|tool| tool.read_only());
        self
    }

    /// One tool by name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.0.iter().find(|tool| tool.name() == name)
    }

    /// The names, which go to the model and to the skills filter alike.
    #[must_use]
    pub fn names(&self) -> Vec<&'static str> {
        self.0.iter().map(|tool| tool.name()).collect()
    }

    /// What the model reads of each.
    #[must_use]
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.0.iter().map(|tool| tool.spec()).collect()
    }
}
