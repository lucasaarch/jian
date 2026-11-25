//! The flags that say where e-mail comes from.

use std::sync::Arc;

use anyhow::Context as _;
use clap::Args;
use jian_mail::{DEFAULT_BASE_URL, Mailbox, ResendMailer};
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
            _ => None,
        };
        Ok(MailConfig {
            deploy,
            ..MailConfig::default()
        })
    }
}
