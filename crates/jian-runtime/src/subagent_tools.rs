//! The tools that hand work to subagents: `spawn_subagent` and `stop_subagent`.
//!
//! A subagent is a thread of its own, with the same agent and the people of the thread that
//! asked, and a run (`origin = subagent`) that works on a brief and answers once. When that run
//! ends its last answer, whole, goes back to the parent thread. With `wait` the parent run parks
//! on the call (state `waiting`): it holds no job, and the report queues the job that goes on
//! (see `Runner`); without it the report is a message in the parent thread and the parent run
//! does not stop for it.
//!
//! The limits are constants below, checked by the store when the subagent is made. A run that
//! may not spawn any more (a subagent at [`MAX_SUBAGENT_DEPTH`]) is given the set
//! [`without`](crate::Tools::without) [`SUBAGENT_TOOLS`], and a call past a limit is refused with
//! words for the model all the same.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_store::{Database, NewJob, NewSubagent, Spawn, SubagentLimits, SubagentState, TenantCtx};
use serde_json::{Value, json};

use crate::run::RUN_KIND;
use crate::tool::{Tool, ToolEnv};

/// How deep subagents nest: a conversation spawns children (depth 1), which may spawn their own
/// (depth 2), which may not.
pub const MAX_SUBAGENT_DEPTH: i32 = 2;
/// How many subagents of one run may be running at once.
pub const MAX_RUNNING_SUBAGENTS: i64 = 4;
/// The longest brief, in bytes.
const MAX_BRIEF_BYTES: usize = 16 * 1024;

/// The names of the two tools.
pub const SUBAGENT_TOOLS: [&str; 2] = ["spawn_subagent", "stop_subagent"];

/// The name of the tool that starts one.
pub(crate) const SPAWN: &str = "spawn_subagent";

pub(crate) fn subagent_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(SpawnTool), Arc::new(Stop)]
}

/// Queues the job of a run, once however often it is asked.
pub async fn queue_run(
    db: &Database,
    ctx: &TenantCtx,
    run: &str,
) -> Result<(), jian_store::StoreError> {
    let job = NewJob::new(RUN_KIND, json!({ "runId": run })).idempotent(format!("run:{run}"));
    db.enqueue_job(ctx, job).await.map(|_| ())
}

/// Queues the job that takes `run` back from the call it is parked on, once per `key` and call.
pub async fn queue_resume(
    db: &Database,
    ctx: &TenantCtx,
    run: &str,
    call: &str,
    key: &str,
) -> Result<(), jian_store::StoreError> {
    let job = NewJob::new(RUN_KIND, json!({ "runId": run, "callId": call }))
        .idempotent(format!("run:{run}:{key}:{call}"));
    db.enqueue_job(ctx, job).await.map(|_| ())
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: schema,
        cache: false,
    }
}

struct SpawnTool;

impl Tool for SpawnTool {
    fn name(&self) -> &'static str {
        SPAWN
    }

    fn spec(&self) -> ToolSpec {
        spec(
            SPAWN,
            "Hands a task to a subagent: the same agent, in a conversation of its own, working \
             only from your brief. Its last answer comes back to this conversation. With `wait` \
             you stop here until it does and the answer is this call's result; without it you \
             go on and the answer arrives as a message. Write the brief so it stands alone.",
            json!({
                "type": "object",
                "properties": {
                    "brief": { "type": "string", "description": "What to do, self-contained." },
                    "wait": { "type": "boolean", "description": "Wait for the answer." }
                },
                "required": ["brief"]
            }),
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            // Only the loop can park a run; asked plainly, this says where it stands.
            Ok(self.settle(input, env).await?.unwrap_or_else(|| {
                "the subagent is still working; its report comes back when it ends".to_owned()
            }))
        })
    }

    fn settle<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let brief = input
                .get("brief")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|brief| !brief.is_empty())
                .ok_or("`brief` is required and must not be empty")?;
            if brief.len() > MAX_BRIEF_BYTES {
                return Err(format!("the brief is over {MAX_BRIEF_BYTES} bytes"));
            }
            let wait = input.get("wait").and_then(Value::as_bool).unwrap_or(false);
            let spawned = env
                .db
                .spawn_subagent(
                    env.ctx,
                    &NewSubagent {
                        parent_thread: env.thread,
                        parent_run: env.run,
                        parent_call: env.call_id,
                        agent: env.agent,
                        brief,
                        wait,
                    },
                    SubagentLimits {
                        max_depth: MAX_SUBAGENT_DEPTH,
                        max_running: MAX_RUNNING_SUBAGENTS,
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            let sub = match spawned {
                Spawn::Made(sub) | Spawn::Existing(sub) => sub,
                Spawn::TooDeep => {
                    return Err(format!(
                        "subagents nest at most {MAX_SUBAGENT_DEPTH} deep and this conversation \
                         is at the limit: do the task yourself"
                    ));
                }
                Spawn::TooMany => {
                    return Err(format!(
                        "this run already has {MAX_RUNNING_SUBAGENTS} subagents running: wait \
                         for one to report back or stop one"
                    ));
                }
            };
            // Every time, not only when it was made: the job is one per run, and a crash between
            // the spawn and here must not leave a subagent nobody runs.
            queue_run(env.db, env.ctx, &sub.child_run)
                .await
                .map_err(|e| e.to_string())?;
            if !sub.wait {
                return Ok(Some(format!(
                    "subagent started in conversation {}; its report will arrive here as a \
                     message",
                    sub.child_thread
                )));
            }
            let report = sub.report.unwrap_or_default();
            match sub.state {
                SubagentState::Running => Ok(None),
                SubagentState::Done => Ok(Some(report)),
                SubagentState::Failed | SubagentState::Stopped => Err(report),
            }
        })
    }
}

struct Stop;

impl Tool for Stop {
    fn name(&self) -> &'static str {
        "stop_subagent"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "stop_subagent",
            "Stops a subagent you started, by the conversation id `spawn_subagent` gave. You \
             get a message when it has stopped.",
            json!({
                "type": "object",
                "properties": { "thread_id": { "type": "string" } },
                "required": ["thread_id"]
            }),
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = input
                .get("thread_id")
                .and_then(Value::as_str)
                .ok_or("`thread_id` is required and must be a string")?;
            let child = jian_store::ThreadId::new(id);
            let sub = env
                .db
                .subagent_of_thread(env.ctx, &child)
                .await
                .map_err(|e| e.to_string())?
                // Another conversation's subagent is none of this run's business.
                .filter(|sub| sub.parent_thread == *env.thread)
                .ok_or("there is no such subagent in this conversation")?;
            if sub.state != SubagentState::Running {
                return Err("that subagent has already ended".to_owned());
            }
            let run = env
                .db
                .request_run_stop(env.ctx, &child, &sub.child_run)
                .await
                .map_err(|e| e.to_string())?;
            if run.is_some_and(|run| run.state.is_terminal()) {
                // It ended at once (queued, or parked): no worker holds it to tell the parent,
                // so a job that finds it ended does.
                let job = NewJob::new(RUN_KIND, json!({ "runId": sub.child_run }))
                    .idempotent(format!("run:{}:stopped", sub.child_run));
                env.db
                    .enqueue_job(env.ctx, job)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok("the subagent is stopping; you will get a message when it has".to_owned())
        })
    }
}
