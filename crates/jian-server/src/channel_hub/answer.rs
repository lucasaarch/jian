//! What a finished run said, sent back to the chat it was answering.

use jian_channel_api::ChannelError;
use jian_store::{Run, RunOrigin, TenantCtx};

use super::ChannelHub;
use crate::channel_intake::ReplyError;

impl ChannelHub {
    /// Sends what `run` said last to the chat its thread came in on, once: a run is terminal
    /// after this, so it is never asked twice. A thread that is not a chat of the agent's own
    /// channel, a run that said nothing, or a [`RunOrigin::Wake`] run (whose output is a
    /// suggestion for the owner, never words for a contact) sends nothing. A failure is logged
    /// and not retried, because a send that may have left must not reach the person twice.
    pub async fn deliver_answer(&self, ctx: &TenantCtx, run: &Run) {
        if run.origin == RunOrigin::Wake {
            return;
        }
        let db = &self.inner.db;
        // Asked first and cheaply: most runs are not in a chat thread.
        match db.channel_chat_of_thread(ctx, &run.thread).await {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(run = %run.id, %error, "reading a run's chat failed");
                return;
            }
        }
        let text = match db.run_answer(ctx, &run.thread, &run.agent, &run.id).await {
            Ok(Some(text)) if !text.trim().is_empty() => text,
            Ok(_) => return,
            Err(error) => {
                tracing::warn!(run = %run.id, %error, "reading a run's answer failed");
                return;
            }
        };
        match self.reply(ctx, &run.agent, &run.thread, &text).await {
            Ok(_) | Err(ReplyError::NotThisAgents) => {}
            Err(ReplyError::Channel(ChannelError::NotConnected)) => {
                tracing::warn!(run = %run.id, "the chat is not connected here; the answer was not sent");
            }
            Err(error) => tracing::warn!(run = %run.id, %error, "sending a run's answer failed"),
        }
    }
}
