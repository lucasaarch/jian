//! What the hub does about people: starting the run that answers a stranger, and talking to the
//! agent's creator. Texts here go to the creator in a chat, so they hold what the stranger wrote
//! (clipped) and never anything of the workspace.

use jian_channel_api::{ChannelError, ChatId, OutboundContent, OutboundMessage};
use jian_runtime::RUN_KIND;
use jian_store::{AgentId, ChannelAccount, NewJob, RunOrigin, StoreError, TenantCtx, ThreadId};
use serde_json::json;

use super::{ChannelHub, Inner, Live, locked};
use crate::channel_intake::ReplyError;

/// The most characters of a stranger's words the note to the creator carries.
const NOTE_CHARS: usize = 300;

/// What the creator is told the first time a stranger writes.
fn first_note(account: &ChannelAccount, chat: &str, label: &str, text: &str) -> String {
    let said: String = text.chars().take(NOTE_CHARS).collect();
    format!(
        "{label} ({} {chat}) wrote to you and I do not know them: \"{said}\". Who are they? \
         Tell me their name and I will add them.",
        account.provider
    )
}

/// How many runs strangers may cost, because each is a model call nobody approved. Over a limit
/// the message stays in its thread and starts nothing; the creator is not told again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StrangerLimits {
    /// The most runs one sender may start with one agent in a window.
    pub per_sender: i64,
    /// The most runs all strangers together may start with one agent in a window.
    pub per_agent: i64,
    /// The length of the window, in milliseconds.
    pub window_ms: i64,
}

impl Default for StrangerLimits {
    /// Three runs an hour for a sender, thirty an hour for an agent.
    fn default() -> Self {
        Self {
            per_sender: 3,
            per_agent: 30,
            window_ms: 60 * 60 * 1000,
        }
    }
}

/// Starts the run that answers a stranger, once for each message, and tells the creator the
/// first time. A failure to tell is logged: the run still answers the stranger with the minimum.
///
/// The creator is told before the run is made: if making it fails, the provider's replay of the
/// message comes back here as a message still awaiting its run, and the one note is not sent
/// twice. Runs that were never made are not counted against the limits.
pub(super) async fn engage(
    inner: &Inner,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    thread: &ThreadId,
    seq: i64,
    from: (&str, Option<(&str, &str, &str)>),
) -> Result<(), StoreError> {
    let (sender, note) = from;
    if let Some((chat, label, text)) = note
        && let Err(error) = tell_creator_via(
            inner,
            ctx,
            &account.agent,
            &first_note(account, chat, label, text),
        )
        .await
    {
        tracing::warn!(account = %account.id, %error, "telling the creator about a stranger failed");
    }
    if over_the_limits(inner, ctx, account, sender).await? {
        tracing::info!(account = %account.id, "a stranger is over the run limits; no run");
        return Ok(());
    }
    let (run, created) = inner
        .db
        .start_run(ctx, thread, &account.agent, None, seq, RunOrigin::Stranger)
        .await?;
    if created {
        let job =
            NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
        inner.db.enqueue_job(ctx, job).await?;
    }
    Ok(())
}

async fn over_the_limits(
    inner: &Inner,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    sender: &str,
) -> Result<bool, StoreError> {
    let limits = *locked(&inner.stranger_limits);
    let since = crate::workspace::now_ms() - limits.window_ms;
    let by_sender = inner
        .db
        .stranger_runs_since(
            ctx,
            &account.agent,
            Some((&account.provider, sender)),
            since,
        )
        .await?;
    if by_sender >= limits.per_sender {
        return Ok(true);
    }
    let by_agent = inner
        .db
        .stranger_runs_since(ctx, &account.agent, None, since)
        .await?;
    Ok(by_agent >= limits.per_agent)
}

/// Sends `text` to the agent's creator, on the first channel the creator has an identity on and
/// the agent has an account held here.
pub(super) async fn tell_creator_via(
    inner: &Inner,
    ctx: &TenantCtx,
    agent: &AgentId,
    text: &str,
) -> Result<(), ReplyError> {
    let creator = inner.db.ensure_creator(ctx, agent).await?;
    for account in inner.db.channel_accounts_of(ctx, agent).await? {
        let live = locked(&inner.running)
            .get(&(ctx.id().clone(), account.id.clone()))
            .cloned();
        let (Some(live), Some(identity)) = (
            live,
            creator
                .identities
                .iter()
                .find(|identity| identity.channel == account.provider),
        ) else {
            continue;
        };
        live.channel
            .send(OutboundMessage {
                chat: ChatId::new(identity.address.clone()),
                content: OutboundContent::Text(text.to_owned()),
                reply_to: None,
            })
            .await?;
        return Ok(());
    }
    Err(ReplyError::Channel(ChannelError::NotConnected))
}

/// Answers the creator's `/confirm` or `/deny` in the chat it came from.
pub(super) async fn answer_in_chat(live: &Live, chat: &str, text: &str) {
    let sent = live
        .channel
        .send(OutboundMessage {
            chat: ChatId::new(chat.to_owned()),
            content: OutboundContent::Text(text.to_owned()),
            reply_to: None,
        })
        .await;
    if let Err(error) = sent {
        tracing::warn!(%error, "answering the creator's decision failed");
    }
}

/// The text the stranger run's `tell_creator` sends: where the stranger writes from is named
/// by the gateway, never by the model.
pub(crate) fn creator_text(provider: &str, chat: &str, said: &str) -> String {
    format!("About {provider} {chat}: {said}")
}

impl ChannelHub {
    /// Changes how many runs strangers may start; the default is [`StrangerLimits::default`].
    pub fn set_stranger_limits(&self, limits: StrangerLimits) {
        *locked(&self.inner.stranger_limits) = limits;
    }

    /// Sends `text` to the creator of `agent` on a channel held here.
    ///
    /// # Errors
    ///
    /// [`ChannelError::NotConnected`] when none of the creator's channels is held here.
    pub async fn tell_creator(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        text: &str,
    ) -> Result<(), ReplyError> {
        tell_creator_via(&self.inner, ctx, agent, text).await
    }

    /// The chat of a thread, when it is a chat of one of the agent's accounts: where a stranger
    /// writes from, for the creator to be told. The model never names it.
    pub(crate) async fn chat_of(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        thread: &ThreadId,
    ) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .inner
            .db
            .channel_chat_of_thread(ctx, thread)
            .await?
            .filter(|(owner, _, _)| owner == agent)
            .map(|(_, provider, chat)| (provider, chat)))
    }
}
