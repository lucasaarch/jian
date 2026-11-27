//! What the gateway does with a Linear account on its own account (not as an agent's tool): the
//! sign-in, and the reads and writes behind starting a thread from an issue.
//!
//! Every one goes through the account's [`AccountContext`], so the vault, the permissions and the
//! HTTP client's address rules are the plugin's own, and each is bounded by [`PREPARE_TIMEOUT`].

use jian_plugin_api::{AccountContext, AccountId, Plugin};
use jian_plugin_linear::reference::{self, IssueRef};
use jian_plugin_linear::{LINEAR_ID, oauth};
use jian_store::{ConnectorAccount, Database, TenantCtx};
use serde_json::{Value, json};

use super::{PREPARE_TIMEOUT, Plugins, ServerHost, scoped};

const SLOW: &str = "Linear did not answer in time";

impl Plugins {
    fn linear_host<'a>(
        &'a self,
        db: &'a Database,
        ctx: &'a TenantCtx,
        account: &'a AccountId,
    ) -> ServerHost<'a> {
        ServerHost {
            db,
            ctx,
            plugin: LINEAR_ID,
            account,
            http: &self.http,
            allow_internal: self.allow_internal,
        }
    }

    /// Starts the sign-in of a Linear account and returns the address to send the person to.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_login_start(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        redirect_uri: &str,
    ) -> Result<String, String> {
        let account = scoped(account).account;
        let host = self.linear_host(db, ctx, &account.id);
        let context = AccountContext::new(&host, &account, jian_plugin_linear::permissions());
        tokio::time::timeout(PREPARE_TIMEOUT, oauth::start(&context, redirect_uri))
            .await
            .map_err(|_| SLOW.to_owned())?
            .map_err(|e| e.to_string())
    }

    /// Finishes the sign-in with what Linear sent back, and says which Linear workspace the
    /// account is now signed in to.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_login_finish(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        (code, state): (&str, &str),
    ) -> Result<(), String> {
        let account = scoped(account).account;
        let host = self.linear_host(db, ctx, &account.id);
        let context = AccountContext::new(&host, &account, jian_plugin_linear::permissions());
        tokio::time::timeout(PREPARE_TIMEOUT, oauth::finish(&context, code, state))
            .await
            .map_err(|_| SLOW.to_owned())?
            .map_err(|e| e.to_string())
    }

    /// The Linear workspace a signed-in account is on: what a webhook's `organizationId` names.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_organization(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
    ) -> Result<String, String> {
        let account = scoped(account).account;
        let host = self.linear_host(db, ctx, &account.id);
        let context = AccountContext::new(&host, &account, jian_plugin_linear::permissions());
        tokio::time::timeout(PREPARE_TIMEOUT, reference::organization(&context))
            .await
            .map_err(|_| SLOW.to_owned())?
            .map_err(|e| e.to_string())
    }

    /// The issue a person named (Linear's id or `ENG-12`), proved to exist through the account.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_issue(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        issue: &str,
    ) -> Result<IssueRef, String> {
        let account = scoped(account).account;
        let host = self.linear_host(db, ctx, &account.id);
        let context = AccountContext::new(&host, &account, jian_plugin_linear::permissions());
        tokio::time::timeout(PREPARE_TIMEOUT, reference::issue(&context, issue))
            .await
            .map_err(|_| SLOW.to_owned())?
            .map_err(|e| e.to_string())
    }

    /// Runs one tool of the Linear plugin as the account, for a step the gateway takes when a
    /// person asks (moving an issue, commenting on it).
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_call(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        (tool, input): (&str, &Value),
    ) -> Result<(), String> {
        let account = scoped(account).account;
        let plugin = self
            .registry
            .get(LINEAR_ID)
            .ok_or_else(|| "no plugin of this build runs Linear".to_owned())?;
        let host = self.linear_host(db, ctx, &account.id);
        let context = AccountContext::new(&host, &account, plugin.permissions());
        let plugin: &dyn Plugin = plugin.as_ref();
        tokio::time::timeout(PREPARE_TIMEOUT, plugin.call(&context, tool, input))
            .await
            .map_err(|_| SLOW.to_owned())?
            .map(drop)
            .map_err(|e| e.0)
    }

    /// Moves an issue to the team's `In Progress` state.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_start_issue(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        issue: &str,
    ) -> Result<(), String> {
        let input = json!({ "id": issue, "state": "In Progress" });
        self.linear_call(db, ctx, account, ("set_state", &input))
            .await
    }

    /// Comments `body` on an issue.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn linear_comment(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        issue: &str,
        body: &str,
    ) -> Result<(), String> {
        let input = json!({ "id": issue, "body": body });
        self.linear_call(db, ctx, account, ("comment", &input))
            .await
    }
}
