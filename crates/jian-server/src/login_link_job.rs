//! The job that e-mails a sign-in link: `login_link.send`.
//!
//! The request route only queues this, and it queues it for every address it is given, so what it
//! answers and how long it takes cannot depend on whether the address belongs to a member. This
//! handler is the one place that finds out: for a member it makes the link and sends it, for
//! anybody else it does nothing and succeeds.
//!
//! The payload is `{"email": "..."}`. The tenant comes from the job and the token does not exist
//! until the handler makes it, so no secret is ever in the queue's table. A retry makes a new
//! token (which kills the one before), so only the last attempt's link works; a message delivered
//! before a timeout may therefore arrive twice, with the first link dead.

use futures_util::future::BoxFuture;
use jian_mail::{LoginLinkMail, MailError, login_link_message};

use crate::mail::{self, Sending};
use crate::{JobContext, JobError, JobHandler, Settings};

/// The kind of job this handler runs.
pub const LOGIN_LINK_SEND_KIND: &str = "login_link.send";

/// Sends sign-in links. Built from the settings the gateway runs with, so the job and the routes
/// agree on the public URL and on where the mailer comes from.
#[derive(Clone, Debug)]
pub struct LoginLinkSender {
    settings: Settings,
}

impl LoginLinkSender {
    /// A handler under these settings.
    #[must_use]
    pub fn new(settings: &Settings) -> Self {
        Self {
            settings: settings.clone(),
        }
    }

    async fn run(&self, context: JobContext) -> Result<(), JobError> {
        let JobContext { job, tenant, db } = context;
        let email = job.payload["email"]
            .as_str()
            .ok_or_else(|| JobError::permanent("the payload has no email"))?;
        let retry = |error: &dyn std::fmt::Display| JobError::retry(error.to_string());

        // The route checked all of this before queueing; a setting that went away since leaves
        // nothing to do, and nobody to tell (the person who asked was answered long ago).
        let Some(public) = &self.settings.public_url else {
            tracing::warn!("a sign-in link was asked for but the gateway has no public URL");
            return Ok(());
        };
        let Some(Sending { mailer, from }) = mail::resolve(&self.settings, &db, &tenant)
            .await
            .map_err(|error| retry(&error))?
        else {
            tracing::warn!("a sign-in link was asked for but e-mail is not configured");
            return Ok(());
        };
        let Some(issued) = self
            .settings
            .auth
            .issue_login_link(&db, tenant.id(), email)
            .await
            .map_err(|error| retry(&error))?
        else {
            // Not a member: nothing was written and nothing is sent. Not logged with the address.
            return Ok(());
        };
        let Some(link) = public.login_link(issued.token.expose()) else {
            return Err(JobError::permanent("the sign-in link could not be built"));
        };
        let message = login_link_message(&LoginLinkMail {
            from: &from,
            to: &issued.email,
            workspace: &self.settings.workspace_name,
            link: &link,
            minutes: issued.ttl.as_secs().div_ceil(60),
        });
        match mailer.send(&message).await {
            Ok(_) => Ok(()),
            Err(MailError::Permanent(reason)) => {
                tracing::warn!(%reason, "a sign-in link was refused by the mail provider");
                Ok(())
            }
            Err(MailError::Temporary(reason)) if job.attempts < job.max_attempts => {
                Err(JobError::retry(reason))
            }
            Err(MailError::Temporary(reason)) => {
                Err(JobError::permanent(format!("gave up: {reason}")))
            }
        }
    }
}

impl JobHandler for LoginLinkSender {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.run(context))
    }
}
