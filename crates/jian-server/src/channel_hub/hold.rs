//! The task that holds one account's connection. It logs ids and error texts, never what was
//! said, a pairing code or a number.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use jian_channel_api::{ChannelError, ChannelEvent, ConnectionState, Disconnect, PairingMethod};
use jian_store::{ChannelAccount, ChannelAccountId, ChannelStatus, TenantCtx};

use super::people::{answer_in_chat, engage};
use super::{Inner, Live, locked};
use crate::channel_intake::{Intake, receive};

/// What an event asks of the task.
enum Step {
    Go,
    /// The connection is gone: wait, and connect again.
    Drop,
    /// The account is out of service until a person pairs it again.
    Done,
}

/// Why the task is ending.
#[derive(Clone, Copy)]
enum Exit {
    /// A disconnect or the shutdown.
    Stopped,
    /// The tenant's slot is not served here any more.
    SlotLost,
    /// Nothing more to hold: logged out, deleted, or refused.
    Finished,
}

enum Listened {
    Dropped,
    Ended(Exit),
}

type Lost<'a> = &'a mut BoxFuture<'static, ()>;

/// The wait before attempt `attempt`: the backoff, plus up to a quarter more that depends on the
/// account, so accounts that dropped together do not come back together. No clock or random
/// source, so a test can bound it.
fn delay(inner: &Inner, id: &ChannelAccountId, attempt: u32) -> Duration {
    let base = inner.backoff.delay(attempt);
    let mut hasher = DefaultHasher::new();
    id.as_str().hash(&mut hasher);
    attempt.hash(&mut hasher);
    let permille = u32::try_from(hasher.finish() % 250).unwrap_or(0);
    base + base * permille / 1000
}

/// Waits `wait`, or less when the task is told to end: then why.
async fn pause(live: &Live, lost: Lost<'_>, wait: Duration) -> Option<Exit> {
    tokio::select! {
        () = tokio::time::sleep(wait) => None,
        () = live.cancel.cancelled() => Some(Exit::Stopped),
        () = &mut *lost => Some(Exit::SlotLost),
    }
}

/// The provider ended the session (or it was refused): its keys are worth nothing now and must
/// not stay in the database.
async fn forget(inner: &Inner, ctx: &TenantCtx, id: &ChannelAccountId) {
    if let Err(error) = inner.db.clear_channel_session(ctx, id).await {
        tracing::warn!(account = %id, %error, "forgetting a channel's session failed");
    }
}

async fn mark(inner: &Inner, ctx: &TenantCtx, id: &ChannelAccountId, status: ChannelStatus) {
    if let Err(error) = inner.db.set_channel_status(ctx, id, status).await {
        tracing::warn!(account = %id, %error, "recording a channel's status failed");
    }
}

/// Holds the account until it is told to stop, the slot is lost, or there is nothing to hold.
pub(super) async fn hold(
    inner: Arc<Inner>,
    ctx: TenantCtx,
    id: ChannelAccountId,
    live: Arc<Live>,
    first: PairingMethod,
) {
    let mut lost: BoxFuture<'static, ()> = Box::pin(inner.slots.lost(ctx.id()));
    let mut method = first;
    let mut attempt = 0u32;
    let exit = loop {
        if live.cancel.is_cancelled() {
            break Exit::Stopped;
        }
        if !inner.slots.owns(ctx.id()) {
            break Exit::SlotLost;
        }
        let account = match inner.db.channel_account_of_host(&ctx, &id).await {
            Ok(Some(account)) => account,
            Ok(None) => break Exit::Finished,
            Err(error) => {
                tracing::warn!(account = %id, %error, "reading a channel account failed");
                if let Some(exit) = pause(&live, &mut lost, delay(&inner, &id, attempt)).await {
                    break exit;
                }
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        // Subscribed before connecting, so nothing the connection says first is missed.
        let mut events = live.channel.events();
        match live.channel.connect(method.clone()).await {
            Ok(()) => method = PairingMethod::Resume,
            Err(ChannelError::LoggedOut) => {
                forget(&inner, &ctx, &id).await;
                mark(&inner, &ctx, &id, ChannelStatus::LoggedOut).await;
                break Exit::Finished;
            }
            Err(ChannelError::PairingRefused(_)) => {
                tracing::warn!(account = %id, "the provider refused the pairing");
                mark(&inner, &ctx, &id, ChannelStatus::NeedsPairing).await;
                break Exit::Finished;
            }
            Err(error) => {
                tracing::warn!(account = %id, %error, "connecting a channel failed");
                if let Some(exit) = pause(&live, &mut lost, delay(&inner, &id, attempt)).await {
                    break exit;
                }
                attempt = attempt.saturating_add(1);
                continue;
            }
        }
        let listened = listen(
            &inner,
            &ctx,
            &account,
            &live,
            &mut events,
            &mut lost,
            &mut attempt,
        )
        .await;
        match listened {
            Listened::Ended(exit) => break exit,
            Listened::Dropped => {
                // Closed cleanly first, so the next connect starts from nothing half open.
                if let Err(error) = live.channel.disconnect(Disconnect::Keep).await {
                    tracing::warn!(account = %id, %error, "closing a dropped channel failed");
                }
                if let Some(exit) = pause(&live, &mut lost, delay(&inner, &id, attempt)).await {
                    break exit;
                }
                attempt = attempt.saturating_add(1);
            }
        }
    };
    let how = match exit {
        Exit::Stopped => *locked(&live.how),
        Exit::SlotLost | Exit::Finished => Disconnect::Keep,
    };
    // A session already ended (logged out, or a refused phone) is not closed a second way.
    let ended =
        matches!(exit, Exit::Finished) && live.channel.state() == ConnectionState::LoggedOut;
    if !ended && let Err(error) = live.channel.disconnect(how).await {
        tracing::warn!(account = %id, %error, "closing a channel failed");
    }
    let mut running = locked(&inner.running);
    let key = (ctx.id().clone(), id);
    // A newer task of the same account may already stand there.
    if running
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &live))
    {
        running.remove(&key);
    }
}

async fn listen(
    inner: &Inner,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    live: &Live,
    events: &mut BoxStream<'static, ChannelEvent>,
    lost: Lost<'_>,
    attempt: &mut u32,
) -> Listened {
    loop {
        let event = tokio::select! {
            () = live.cancel.cancelled() => return Listened::Ended(Exit::Stopped),
            () = &mut *lost => return Listened::Ended(Exit::SlotLost),
            event = events.next() => event,
        };
        let Some(event) = event else {
            return Listened::Dropped;
        };
        match handle(inner, ctx, account, live, event, attempt).await {
            Step::Go => {}
            Step::Drop => return Listened::Dropped,
            Step::Done => return Listened::Ended(Exit::Finished),
        }
    }
}

async fn handle(
    inner: &Inner,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    live: &Live,
    event: ChannelEvent,
    attempt: &mut u32,
) -> Step {
    match event {
        ChannelEvent::State(ConnectionState::Connected) => {
            *attempt = 0;
            *locked(&live.prompt) = None;
            mark(inner, ctx, &account.id, ChannelStatus::Connected).await;
            Step::Go
        }
        ChannelEvent::State(ConnectionState::Pairing) => {
            mark(inner, ctx, &account.id, ChannelStatus::Pairing).await;
            Step::Go
        }
        ChannelEvent::State(ConnectionState::LoggedOut) => {
            *locked(&live.prompt) = None;
            forget(inner, ctx, &account.id).await;
            mark(inner, ctx, &account.id, ChannelStatus::LoggedOut).await;
            Step::Done
        }
        // The channel's own, unasked: the connection is gone. A disconnect we asked for ends the
        // task before this is read.
        ChannelEvent::State(ConnectionState::Disconnected) => Step::Drop,
        // The channel is reconnecting by itself.
        ChannelEvent::State(ConnectionState::Connecting | ConnectionState::Reconnecting) => {
            Step::Go
        }
        ChannelEvent::Pairing(prompt) => {
            *locked(&live.prompt) = Some(prompt);
            Step::Go
        }
        ChannelEvent::Paired { account: address } => {
            paired(inner, ctx, account, live, &address).await
        }
        ChannelEvent::Message(message) => {
            let step = match receive(&inner.db, ctx, account, &message).await {
                Ok(Intake::Stranger {
                    thread,
                    seq,
                    first,
                    text,
                    label,
                }) => {
                    let chat = message.chat.as_str();
                    let note = first.then_some((chat, label.as_str(), text.as_str()));
                    let sender = message.sender.id.as_str();
                    engage(inner, ctx, account, &thread, seq, (sender, note)).await
                }
                Ok(Intake::Decision { reply }) => {
                    answer_in_chat(live, message.chat.as_str(), &reply).await;
                    Ok(())
                }
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };
            match step {
                Ok(()) => Step::Go,
                // Not acknowledged: closing and connecting again makes the provider send it
                // over.
                Err(error) => {
                    tracing::warn!(account = %account.id, %error, "writing a message to the inbox failed");
                    Step::Drop
                }
            }
        }
    }
}

/// Linking worked. The first number the account is linked to is its number for good: another
/// phone is refused and its session ended, because replies queued for this account must never
/// leave from a different number. Disconnecting with `forget` is how a new phone is allowed.
async fn paired(
    inner: &Inner,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    live: &Live,
    address: &str,
) -> Step {
    match inner
        .db
        .bind_channel_address(ctx, &account.id, address)
        .await
    {
        Ok(true) => {
            *locked(&live.prompt) = None;
            mark(inner, ctx, &account.id, ChannelStatus::Connected).await;
            Step::Go
        }
        Ok(false) => {
            tracing::warn!(account = %account.id, "paired with a different number; refused");
            if let Err(error) = live.channel.disconnect(Disconnect::LogOut).await {
                tracing::warn!(account = %account.id, %error, "ending the refused session failed");
            }
            *locked(&live.prompt) = None;
            forget(inner, ctx, &account.id).await;
            mark(inner, ctx, &account.id, ChannelStatus::LoggedOut).await;
            Step::Done
        }
        Err(error) => {
            tracing::warn!(account = %account.id, %error, "recording the number failed");
            Step::Drop
        }
    }
}
