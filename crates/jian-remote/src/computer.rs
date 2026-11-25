//! Computer Use tasks: one action on the primary display, through a helper process that is this
//! binary run as `computer-helper` (the `jian-computer-use` crate does the platform work).

mod helper;
pub mod macos;
mod outcome;
mod session;

use std::time::Duration;

use jian_protocol::machine::{ComputerTask, TaskResult};
use tokio_util::sync::CancellationToken;

pub use helper::HelperCommand;
pub use outcome::{ActionError, Done};
pub use session::{ComputerSession, SEAT_IDLE};

const TIMED_OUT: &str = "Computer action timed out. It was stopped, and part of it may have reached the screen: take a screenshot before going on.";
const CANCELLED: &str = "Computer action was cancelled. It was stopped, and part of it may have reached the screen: take a screenshot before going on.";

/// Runs one action within its time limit. Always answers, so the gateway's task never waits on
/// its own timeout instead.
pub async fn run_computer_task(
    id: &str,
    task: &ComputerTask,
    timeout: Duration,
    cancel: &CancellationToken,
    session: &ComputerSession,
) -> TaskResult {
    let outcome = tokio::select! {
        outcome = session.act(task) => Ok(outcome),
        () = tokio::time::sleep(timeout) => Err((TIMED_OUT, true)),
        () = cancel.cancelled() => Err((CANCELLED, false)),
    };
    match outcome {
        Ok(Ok(done)) => TaskResult {
            id: id.into(),
            exit_code: Some(0),
            stdout: done.stdout.clone(),
            stderr: done.stderr.clone(),
            computer: Some(outcome::done_outcome(&done)),
            ..TaskResult::default()
        },
        Ok(Err(error)) => failure(id, &error),
        Err((message, timed_out)) => {
            // Answering alone would leave the helper at it: a stuck action could still press
            // something after the agent was told it had failed, under whatever came next.
            session.abort().await;
            let error = if timed_out {
                ActionError::timeout(message)
            } else {
                ActionError::unclassified(message)
            };
            TaskResult {
                exit_code: None,
                timed_out,
                cancelled: !timed_out,
                ..failure(id, &error)
            }
        }
    }
}

fn failure(id: &str, error: &ActionError) -> TaskResult {
    TaskResult {
        id: id.into(),
        exit_code: Some(1),
        stderr: error.message.clone(),
        computer: Some(outcome::failed_outcome(error)),
        ..TaskResult::default()
    }
}

#[cfg(all(test, unix))]
mod tests;
