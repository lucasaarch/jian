//! The connections of the chat accounts this instance holds: one long-lived task per account.
//!
//! A task owns its account's connection. It subscribes to the channel, connects (pairing first
//! when a person asked), reads the events and hands every message to [`crate::receive`], which
//! writes it to the agent's inbox before the event counts as handled. When the connection drops
//! it waits out a [`Backoff`] (with a jitter of its own, so accounts that lost the network
//! together do not come back together) and connects again, with the session it has.
//!
//! # Who may hold a connection
//!
//! The provider ends a session that connects twice, so exactly one instance holds an account.
//! That instance is the one that serves the tenant's slot ([`SlotOwnership`], the lease that
//! decides who serves the tenant): the task starts only while the slot is served here and stops,
//! closing the connection (the session is kept), the moment it is lost. The instance that takes
//! the slot picks the account up in [`ChannelHub::reconcile`], which the binary runs on a timer,
//! from the accounts left `connected` in the database. Nothing is lost between the two: a
//! message is in the inbox, keyed by its provider id, or the provider has not been told it
//! arrived and sends it again to whoever connects next.
//!
//! In the local and self-hosted editions the one instance has every slot, so the same code holds
//! the connections in the process.
//!
//! # What is not here
//!
//! A provider itself. [`ChannelHub::register`] takes, per provider, a function that makes the
//! [`Channel`] of an account, given the account's [`SessionStore`] (its keys, sealed in the
//! database and visible to that account alone); a build with none for a provider answers
//! [`HubError::NoProvider`].
//! A pairing code is kept in memory for whoever asks for the account's state, and nowhere else:
//! not in the database, not in a log line, not in a `{:?}`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use jian_channel_api::{
    Backoff, Channel, ChannelError, ChannelKind, ConnectionState, Disconnect, PairingMethod,
    PairingPrompt, SentMessage, SessionStore,
};
use jian_store::{
    AgentId, ChannelAccount, ChannelAccountId, ChannelStatus, Database, StoreError, TenantCtx,
    TenantId, ThreadId,
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::SlotOwnership;
use crate::channel_intake::{ReplyError, reply};
use crate::channel_session::AccountSession;

mod answer;
mod hold;
mod people;

pub use people::StrangerLimits;
pub(crate) use people::creator_text;

/// Makes the [`Channel`] of an account, keeping its session in the store it is given. It only
/// builds the object; connecting is the task's.
pub type ChannelOpener =
    Arc<dyn Fn(&ChannelAccount, Arc<dyn SessionStore>) -> Arc<dyn Channel> + Send + Sync>;

/// Why the hub could not do what it was asked.
#[derive(Debug, thiserror::Error)]
pub enum HubError {
    /// The tenant's slot is served by another instance, which is the one that holds its
    /// connections.
    #[error("this instance does not serve that workspace")]
    NotServed,
    /// This build has no connection for the provider.
    #[error("this build cannot connect to that provider")]
    NoProvider,
    /// The account is already pairing or connected here.
    #[error("the account is already connected here")]
    Running,
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// One account's task, as the hub and the task both see it.
pub(crate) struct Live {
    pub(crate) channel: Arc<dyn Channel>,
    /// Ends the task. Cancelled by a disconnect, or by the shutdown.
    pub(crate) cancel: CancellationToken,
    /// What the task does to the session on its way out.
    pub(crate) how: Mutex<Disconnect>,
    /// The code the person must be shown now.
    pub(crate) prompt: Mutex<Option<PairingPrompt>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

type Key = (TenantId, ChannelAccountId);

pub(crate) struct Inner {
    pub(crate) db: Arc<Database>,
    pub(crate) slots: SlotOwnership,
    pub(crate) backoff: Backoff,
    closing: CancellationToken,
    openers: RwLock<HashMap<ChannelKind, ChannelOpener>>,
    pub(crate) running: Mutex<HashMap<Key, Arc<Live>>>,
    pub(crate) stranger_limits: Mutex<StrangerLimits>,
    /// Where a provider that can push is told to push. Only a build that can be reached from
    /// outside (`channel-webhooks`) has one; any other, or a gateway with no address, polls.
    #[cfg(feature = "channel-webhooks")]
    public_url: Mutex<Option<crate::PublicUrl>>,
}

/// The accounts this instance keeps connected. Cloning shares them.
#[derive(Clone)]
pub struct ChannelHub {
    inner: Arc<Inner>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A task that panicked must not make the account impossible to disconnect.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ChannelHub {
    /// A hub with no providers, holding connections only for the tenants `slots` serves. Every
    /// task ends when `closing` is cancelled. `backoff` is the wait between reconnects.
    #[must_use]
    pub fn new(
        db: Arc<Database>,
        slots: SlotOwnership,
        closing: CancellationToken,
        backoff: Backoff,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                db,
                slots,
                backoff,
                closing,
                openers: RwLock::default(),
                running: Mutex::default(),
                stranger_limits: Mutex::default(),
                #[cfg(feature = "channel-webhooks")]
                public_url: Mutex::new(None),
            }),
        }
    }

    /// Tells the hub the gateway's public address, so a provider that can push is asked to
    /// deliver there instead of being polled. Accounts connected after this call.
    #[cfg(feature = "channel-webhooks")]
    pub fn push_through(&self, url: crate::PublicUrl) {
        *locked(&self.inner.public_url) = Some(url);
    }

    /// Hands the channel of an account the delivery its provider pushed. It enters like anything
    /// the channel fetches itself; a wrong secret enters nothing.
    ///
    /// # Errors
    ///
    /// [`ChannelError::NotConnected`] when this instance does not hold the account in that
    /// workspace, which is also what another workspace's account looks like;
    /// [`ChannelError::Unauthorized`] for a secret that is not the channel's.
    pub async fn push(
        &self,
        tenant: &TenantId,
        account: &ChannelAccountId,
        secret: Option<&str>,
        body: &[u8],
    ) -> Result<(), ChannelError> {
        let live = locked(&self.inner.running)
            .get(&(tenant.clone(), account.clone()))
            .cloned()
            .ok_or(ChannelError::NotConnected)?;
        live.channel.receive_push(secret, body).await
    }

    /// Delivers a webhook already authenticated by the public ingress and queued for this
    /// tenant's slot. Only the durable provider-webhook handler calls this path.
    #[cfg(feature = "slack-events-api")]
    pub(crate) async fn push_verified(
        &self,
        tenant: &TenantId,
        account: &ChannelAccountId,
        body: &[u8],
    ) -> Result<(), ChannelError> {
        let live = locked(&self.inner.running)
            .get(&(tenant.clone(), account.clone()))
            .cloned()
            .ok_or(ChannelError::NotConnected)?;
        live.channel.receive_verified_push(body).await
    }

    /// Says how an account of `kind` is connected, replacing what was said before.
    pub fn register(&self, kind: ChannelKind, opener: ChannelOpener) {
        self.inner
            .openers
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(kind, opener);
    }

    /// Whether this build can connect accounts of `provider`.
    #[must_use]
    pub fn provides(&self, provider: &str) -> bool {
        ChannelKind::parse(provider).is_some_and(|kind| {
            self.inner
                .openers
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&kind)
        })
    }

    fn opener(&self, provider: &str) -> Result<ChannelOpener, HubError> {
        ChannelKind::parse(provider)
            .and_then(|kind| {
                self.inner
                    .openers
                    .read()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(&kind)
                    .cloned()
            })
            .ok_or(HubError::NoProvider)
    }

    /// How many accounts this hub holds now.
    #[must_use]
    pub fn running(&self) -> usize {
        locked(&self.inner.running).len()
    }

    /// Starts holding `account`: connects with `method` and keeps it up.
    ///
    /// # Errors
    ///
    /// [`HubError::NotServed`] when the tenant's slot is not this instance's, so the caller never
    /// opens a second session; [`HubError::NoProvider`]; [`HubError::Running`].
    pub fn connect(
        &self,
        ctx: &TenantCtx,
        account: &ChannelAccount,
        method: PairingMethod,
    ) -> Result<(), HubError> {
        if !self.inner.slots.owns(ctx.id()) {
            return Err(HubError::NotServed);
        }
        let channel = self.opener(&account.provider)?(account, self.session(ctx, account));
        #[cfg(feature = "channel-webhooks")]
        if let Some(url) = locked(&self.inner.public_url).as_ref().and_then(|base| {
            match account.provider.as_str() {
                "slack" => Some(base.slack_events()),
                _ => base.channel_webhook(ctx.id().as_str(), account.id.as_str()),
            }
        }) {
            channel.use_push(url);
        }
        let live = Arc::new(Live {
            channel,
            cancel: self.inner.closing.child_token(),
            how: Mutex::new(Disconnect::Keep),
            prompt: Mutex::new(None),
            task: Mutex::new(None),
        });
        let key = (ctx.id().clone(), account.id.clone());
        let mut running = locked(&self.inner.running);
        if running.contains_key(&key) {
            return Err(HubError::Running);
        }
        running.insert(key.clone(), live.clone());
        // Spawned under the lock, after the insert: the task's last act is to remove itself, and
        // it cannot do that before it is in the map.
        let task = tokio::spawn(hold::hold(
            self.inner.clone(),
            ctx.clone(),
            account.id.clone(),
            live.clone(),
            method,
        ));
        *locked(&live.task) = Some(task);
        Ok(())
    }

    fn session(&self, ctx: &TenantCtx, account: &ChannelAccount) -> Arc<dyn SessionStore> {
        Arc::new(AccountSession::new(
            self.inner.db.clone(),
            ctx.clone(),
            account.id.clone(),
        ))
    }

    /// Where the account's connection is, and the code to show while it pairs. An account this
    /// instance does not hold is `Disconnected`.
    #[must_use]
    pub fn state(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
    ) -> (ConnectionState, Option<PairingPrompt>) {
        let live = locked(&self.inner.running)
            .get(&(ctx.id().clone(), id.clone()))
            .cloned();
        live.map_or((ConnectionState::Disconnected, None), |live| {
            let prompt = locked(&live.prompt).clone();
            (live.channel.state(), prompt)
        })
    }

    /// Closes the account's connection and records it. [`Disconnect::LogOut`] also ends the
    /// session at the provider and forgets the number, so the account is paired again, maybe
    /// with another phone; [`Disconnect::Keep`] leaves it to be resumed.
    ///
    /// # Errors
    ///
    /// [`HubError::NotServed`] when another instance holds it; the store's own failure.
    pub async fn disconnect(
        &self,
        ctx: &TenantCtx,
        account: &ChannelAccount,
        how: Disconnect,
    ) -> Result<(), HubError> {
        if !self.inner.slots.owns(ctx.id()) {
            return Err(HubError::NotServed);
        }
        let live = locked(&self.inner.running)
            .get(&(ctx.id().clone(), account.id.clone()))
            .cloned();
        if let Some(live) = live {
            *locked(&live.how) = how;
            live.cancel.cancel();
            let task = locked(&live.task).take();
            if let Some(task) = task {
                // Its last act is to close the connection the way `how` says.
                let _ = task.await;
            }
        } else if how == Disconnect::LogOut
            && let Ok(opener) = self.opener(&account.provider)
        {
            // Nothing holds it: a session left in the vault is still ended.
            if let Err(error) = opener(account, self.session(ctx, account))
                .disconnect(how)
                .await
            {
                tracing::warn!(account = %account.id, %error, "ending a channel session failed");
            }
        }
        match how {
            Disconnect::Keep => {
                self.inner
                    .db
                    .set_channel_status(ctx, &account.id, ChannelStatus::Disconnected)
                    .await?;
            }
            Disconnect::LogOut => {
                // The channel wipes its own session on the way out; this makes sure of it for
                // one that was not held, or that failed to.
                self.inner
                    .db
                    .clear_channel_session(ctx, &account.id)
                    .await?;
                self.inner
                    .db
                    .clear_channel_address(ctx, &account.id)
                    .await?;
            }
        }
        Ok(())
    }

    /// Starts the accounts this instance must hold and does not: the linked ones, in the tenants
    /// whose slot it serves. Run it on a timer; it is how an instance that has just taken a slot
    /// picks up the connections the old owner let go of. Answers how many it started.
    ///
    /// # Errors
    ///
    /// The tenants could not be listed. One tenant that fails is logged and skipped.
    pub async fn reconcile(&self) -> Result<usize, StoreError> {
        let mut started = 0;
        for tenant in self.inner.db.list_tenants().await? {
            if !self.inner.slots.owns(&tenant) {
                continue;
            }
            let found = async {
                let ctx = self.inner.db.tenant(tenant.clone()).await?;
                let accounts = self.inner.db.channel_accounts_to_connect(&ctx).await?;
                Ok::<_, StoreError>((ctx, accounts))
            };
            let (ctx, accounts) = match found.await {
                Ok(found) => found,
                Err(error) => {
                    tracing::warn!(%tenant, %error, "reading the channel accounts failed");
                    continue;
                }
            };
            for account in accounts {
                // An error is: held already, slot lost since the look, or no provider here. None
                // is a failure.
                if self.connect(&ctx, &account, PairingMethod::Resume).is_ok() {
                    started += 1;
                }
            }
        }
        Ok(started)
    }

    /// Sends the agent's reply on the chat `thread` came in on, through the account that is held
    /// here. A [`ChannelError::NotConnected`] when this instance does not hold it.
    ///
    /// # Errors
    ///
    /// As [`crate::reply`].
    pub async fn reply(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        thread: &ThreadId,
        text: &str,
    ) -> Result<SentMessage, ReplyError> {
        let db = &self.inner.db;
        let Some((owner, provider, _)) = db.channel_chat_of_thread(ctx, thread).await? else {
            return Err(ReplyError::NotThisAgents);
        };
        let account = db
            .channel_accounts_of(ctx, agent)
            .await?
            .into_iter()
            .find(|account| account.provider == provider);
        let Some(account) = account.filter(|_| owner == *agent) else {
            return Err(ReplyError::NotThisAgents);
        };
        let live = locked(&self.inner.running)
            .get(&(ctx.id().clone(), account.id.clone()))
            .cloned()
            .ok_or(ReplyError::Channel(ChannelError::NotConnected))?;
        reply(
            db,
            ctx,
            live.channel.as_ref(),
            &account,
            agent,
            thread,
            text,
        )
        .await
    }

    /// Stops every task, closing each connection with its session kept, and waits for them.
    pub async fn shutdown(&self) {
        let lives: Vec<Arc<Live>> = locked(&self.inner.running).values().cloned().collect();
        for live in &lives {
            live.cancel.cancel();
        }
        for live in lives {
            let task = locked(&live.task).take();
            if let Some(task) = task {
                let _ = task.await;
            }
        }
    }
}
