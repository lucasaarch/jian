//! The flags that say where e-mail comes from.

use std::sync::Arc;

use anyhow::Context as _;
use clap::Args;
use futures_util::future::BoxFuture;
use jian_mail::{DEFAULT_BASE_URL, MailError, Mailbox, Mailer, Message, ResendMailer, SendReceipt};
use jian_server::{DeployMail, MailConfig};

/// E-mail and how the workspace is called in it.
#[derive(Args)]
pub struct MailFlags {
    /// The deploy's own Resend API key, for a hosted deployment: it sends for every workspace and
    /// no workspace can read or change it. Leave it out on a self-hosted install, where an admin
    /// adds their own Resend account under `PUT /v1/settings/mail`. Needs `--mail-from`. Holds a
    /// secret, so `--help` does not show its value.
    #[arg(
        long = "mail-resend-key",
        env = "JIAN_RESEND_API_KEY",
        value_name = "KEY",
        hide_env_values = true,
        requires = "mail_from"
    )]
    resend_key: Option<String>,

    /// The sender of the deploy's e-mail, `name@example.com` or `Name <name@example.com>`, on a
    /// domain verified at Resend.
    #[arg(
        long = "mail-from",
        env = "JIAN_MAIL_FROM",
        value_name = "SENDER",
        value_parser = Mailbox::parse,
        requires = "resend_key"
    )]
    mail_from: Option<Mailbox>,

    /// For trying a gateway on a laptop: "sends" every e-mail by writing it, link and all, to
    /// the log. Never use it where anyone else can read the log. Ignored when a Resend key is
    /// given.
    #[arg(long = "mail-log", env = "JIAN_MAIL_LOG")]
    log_only: bool,

    /// What an e-mail calls the workspace. Workspaces have no names of their own yet.
    #[arg(
        long,
        env = "JIAN_WORKSPACE_NAME",
        default_value = "Jian",
        value_name = "NAME"
    )]
    pub workspace_name: String,
}

impl MailFlags {
    /// The deploy's mailer, if the flags gave one.
    pub fn config(&self) -> anyhow::Result<MailConfig> {
        let deploy = match (&self.resend_key, &self.mail_from) {
            (Some(key), Some(from)) => Some(DeployMail {
                mailer: Arc::new(
                    ResendMailer::new(key, DEFAULT_BASE_URL)
                        .context("--mail-resend-key is not usable")?,
                ),
                from: from.clone(),
            }),
            _ if self.log_only => Some(DeployMail {
                mailer: Arc::new(LogMailer),
                from: Mailbox::parse("Jian <dev@jian.invalid>")
                    .context("the log sender is not valid")?,
            }),
            _ => None,
        };
        Ok(MailConfig {
            deploy,
            ..MailConfig::default()
        })
    }
}

/// Writes each message to the log instead of sending it: a development stand-in for Resend.
#[derive(Debug)]
struct LogMailer;

impl Mailer for LogMailer {
    fn send<'a>(&'a self, message: &'a Message) -> BoxFuture<'a, Result<SendReceipt, MailError>> {
        Box::pin(async move {
            tracing::info!(to = %message.to, subject = %message.subject, "mail (not sent):\n{}", message.text);
            Ok(SendReceipt { message_id: None })
        })
    }
}
