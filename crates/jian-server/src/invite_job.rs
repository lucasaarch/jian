//! The job that e-mails an invitation: `invite.send`.
//!
//! The payload is `{"inviteId": "..."}` and nothing else. The tenant comes from the job, and the
//! token does not exist until the handler makes it, so no secret is ever in the queue's table.
//!
//! One attempt does four things in this order: find a mailer, replace the invitation's token
//! (which kills the previous one), send the message with the new token's link, and record how it
//! went **if the invitation still holds that token**. If the admin copied the link in between,
//! the token this e-mail carries is dead and the status is left to whoever replaced it: the
//! e-mail went out, but its link no longer works, and that is the cost of a copy racing a send.
//! The admin who copies a link holds the working one.
//!
//! A refusal that waiting cannot fix (a key that is not valid, a sender the provider has not
//! verified, no mailer at all) ends the job as done with the invitation `failed`: a dead job
//! retried in a loop would only repeat it. A refusal that may pass (a provider error, the
//! network) is retried by the queue, and when the attempts run out the invitation is `failed`.
//! A retry replaces the token again, so only the last attempt's link works, and since e-mail has
//! no exactly-once, a message that was in fact delivered before a timeout may arrive twice.

use futures_util::future::BoxFuture;
use jian_mail::{InviteMail, MailError, invite_message};
use jian_store::{SendOutcome, TenantCtx, TokenHash};

use crate::mail::{self, Sending};
use crate::{JobContext, JobError, JobHandler, Settings};

/// The kind of job this handler runs.
pub const INVITE_SEND_KIND: &str = "invite.send";

/// Sends invitations. Built from the settings the gateway runs with, so the job and the routes
/// agree on the public URL and on where the mailer comes from.
#[derive(Clone, Debug)]
pub struct InviteSender {
    settings: Settings,
}

impl InviteSender {
    /// A handler under these settings.
    #[must_use]
    pub fn new(settings: &Settings) -> Self {
        Self {
            settings: settings.clone(),
        }
    }

    async fn run(&self, context: JobContext) -> Result<(), JobError> {
        let JobContext { job, tenant, db } = context;
        let id = job.payload["inviteId"]
            .as_str()
            .ok_or_else(|| JobError::permanent("the payload has no inviteId"))?;
        let retry = |error: &dyn std::fmt::Display| JobError::retry(error.to_string());
        let give_up = |reason: &'static str| async {
            // No token was replaced yet, so there is no generation to match.
            db.finish_invite_send(&tenant, id, None, SendOutcome::Failed { reason })
                .await
                .map(|_| ())
                .map_err(|error| retry(&error))
        };

        let Some(public) = &self.settings.public_url else {
            return give_up("the gateway has no public URL to put in the link").await;
        };
        let Some(Sending { mailer, from }) = mail::resolve(&self.settings, &db, &tenant)
            .await
            .map_err(|error| retry(&error))?
        else {
            return give_up("e-mail is not configured").await;
        };
        let Some(issued) = self
            .settings
            .auth
            .rotate_invite(&db, &tenant, id, false)
            .await
            .map_err(|error| retry(&error))?
        else {
            // Used, revoked, expired or gone while the job waited: nothing to send.
            tracing::info!(
                invite = id,
                "the invitation is no longer live; nothing sent"
            );
            return Ok(());
        };
        let generation = TokenHash::of(issued.token.expose());
        let Some(link) = public.invite_link(issued.token.expose()) else {
            return give_up("the invitation link could not be built").await;
        };
        let inviter = match &issued.invite.invited_by {
            Some(account) => db
                .account(account)
                .await
                .map_err(|error| retry(&error))?
                .map(|account| account.name),
            None => None,
        };
        let message = invite_message(&InviteMail {
            from: &from,
            to: &issued.invite.email,
            workspace: &self.settings.workspace_name,
            inviter: inviter.as_deref(),
            link: &link,
            expires_at: &issued.invite.expires_at,
        });

        let record = |outcome| record(&db, &tenant, id, &generation, outcome);
        match mailer.send(&message).await {
            Ok(receipt) => {
                let message_id = receipt.message_id.as_deref();
                if !record(SendOutcome::Sent { message_id }).await? {
                    tracing::info!(invite = id, "sent, but the token was replaced meanwhile");
                }
                Ok(())
            }
            Err(MailError::Permanent(reason)) => {
                record(SendOutcome::Failed { reason: &reason }).await?;
                Ok(())
            }
            Err(MailError::Temporary(reason)) if job.attempts < job.max_attempts => {
                Err(JobError::retry(reason))
            }
            Err(MailError::Temporary(reason)) => {
                record(SendOutcome::Failed { reason: &reason }).await?;
                Err(JobError::permanent(format!("gave up: {reason}")))
            }
        }
    }
}

/// Writes how the send of the token `generation` ended; a later token's result is not touched.
async fn record(
    db: &jian_store::Database,
    tenant: &TenantCtx,
    id: &str,
    generation: &TokenHash,
    outcome: SendOutcome<'_>,
) -> Result<bool, JobError> {
    db.finish_invite_send(tenant, id, Some(generation), outcome)
        .await
        .map_err(|error| JobError::retry(error.to_string()))
}

impl JobHandler for InviteSender {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.run(context))
    }
}

/// Queues the e-mail of an invitation: marks it pending first, so the job's result is never
/// overwritten by this, then enqueues. If the queue refuses, the invitation says so.
pub(crate) async fn queue(
    db: &jian_store::Database,
    ctx: &TenantCtx,
    id: &str,
) -> Result<Option<jian_store::Invite>, jian_store::StoreError> {
    let Some(invite) = db.queue_invite_send(ctx, id).await? else {
        return Ok(None);
    };
    let job = jian_store::NewJob::new(INVITE_SEND_KIND, serde_json::json!({ "inviteId": id }));
    if let Err(error) = db.enqueue_job(ctx, job).await {
        let reason = "the e-mail could not be queued";
        let _ = db
            .finish_invite_send(ctx, id, None, SendOutcome::Failed { reason })
            .await;
        return Err(error);
    }
    Ok(Some(invite))
}
