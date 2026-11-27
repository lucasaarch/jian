//! What a plugin may ask of Jian, and the context it asks through.

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::account::{AccountId, AccountRef};
use crate::error::{HostError, PluginError};
use crate::plugin::Permission;
use crate::secret::Secret;

/// An outbound request. The host sends it with the workspace's one HTTP client.
#[derive(Clone, Debug)]
pub struct HttpRequest {
    /// `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
    pub method: String,
    /// An `http` or `https` address.
    pub url: String,
    /// Headers, as name and value. A token goes here; it is not logged.
    pub headers: Vec<(String, String)>,
    /// The body, if any.
    pub body: Option<Vec<u8>>,
}

/// What came back.
#[derive(Clone, Debug)]
pub struct HttpResponse {
    /// The status code.
    pub status: u16,
    /// Headers, names in lowercase.
    pub headers: Vec<(String, String)>,
    /// The body, cut at the host's limit.
    pub body: Vec<u8>,
}

/// An event for the agents' box. A wake picks it up like any other event of the agent.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentEvent {
    /// What it is, in the plugin's words (`issue.opened`). The host prefixes it with the plugin's
    /// id, so two plugins do not share a kind.
    pub kind: String,
    /// What the agent reads of it. Never a secret.
    pub payload: Value,
    /// A key that makes the same event count once, even if the service sends it twice.
    pub key: Option<String>,
}

/// What [`PluginHost::update_secret`] runs under the secret's lock: the current secret in, the new
/// one out, or why it could not be made (text without a secret in it).
pub type SecretChange<'a> =
    Box<dyn FnOnce(Secret) -> BoxFuture<'a, Result<Secret, String>> + Send + 'a>;

/// What the host gives a plugin. `jian-server` implements it, bound to one tenant; a plugin
/// never sees the store, the runtime or another tenant.
///
/// Every method takes the account it acts for, and the host answers only for the accounts of the
/// run it was made for.
pub trait PluginHost: Send + Sync {
    /// The account's secret from the vault, or `None` when none is stored.
    fn secret<'a>(
        &'a self,
        account: &'a AccountId,
    ) -> BoxFuture<'a, Result<Option<Secret>, HostError>>;

    /// Replaces the account's secret with what `change` makes of the current one, all under a
    /// lock the host holds for that secret: two calls at once (two requests that both find an
    /// OAuth token expired) take turns, and the second `change` sees the first's result. The
    /// answer is `false`, without calling `change`, when the account has no secret. If `change`
    /// fails the secret stays as it was and the error is the one `change` gave.
    fn update_secret<'a>(
        &'a self,
        account: &'a AccountId,
        change: SecretChange<'a>,
    ) -> BoxFuture<'a, Result<bool, HostError>>;

    /// Sends a request and reads the answer.
    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HostError>>;

    /// Puts `event` in the box of the agents that reach the account.
    fn emit<'a>(
        &'a self,
        account: &'a AccountId,
        event: AgentEvent,
    ) -> BoxFuture<'a, Result<(), HostError>>;
}

/// The one account a plugin call runs for, and the doors it may use: the host's, narrowed to the
/// plugin's declared permissions.
pub struct AccountContext<'a> {
    host: &'a dyn PluginHost,
    account: &'a AccountRef,
    granted: &'static [Permission],
}

impl<'a> AccountContext<'a> {
    /// A context for `account`, with the doors `granted` (the plugin's
    /// [`permissions`](crate::Plugin::permissions)).
    pub fn new(
        host: &'a dyn PluginHost,
        account: &'a AccountRef,
        granted: &'static [Permission],
    ) -> Self {
        Self {
            host,
            account,
            granted,
        }
    }

    /// The account the call is for.
    #[must_use]
    pub fn account(&self) -> &AccountRef {
        self.account
    }

    fn allow(&self, permission: Permission) -> Result<(), PluginError> {
        if self.granted.contains(&permission) {
            Ok(())
        } else {
            Err(PluginError::NotPermitted(permission))
        }
    }

    /// The account's secret. Needs [`Permission::Secret`].
    pub async fn secret(&self) -> Result<Secret, PluginError> {
        self.allow(Permission::Secret)?;
        self.host
            .secret(&self.account.id)
            .await?
            .ok_or(PluginError::NoSecret)
    }

    /// Rewrites the account's secret under the host's lock for it (see
    /// [`PluginHost::update_secret`]). Needs [`Permission::SecretWrite`]. `Ok(false)`: no secret
    /// is stored.
    pub async fn update_secret(&self, change: SecretChange<'a>) -> Result<bool, PluginError> {
        self.allow(Permission::SecretWrite)?;
        Ok(self.host.update_secret(&self.account.id, change).await?)
    }

    /// Sends an outbound request. Needs [`Permission::Http`].
    pub async fn http(&self, request: HttpRequest) -> Result<HttpResponse, PluginError> {
        self.allow(Permission::Http)?;
        Ok(self.host.http(request).await?)
    }

    /// Tells the agents that reach this account something happened. Needs
    /// [`Permission::Events`].
    pub async fn emit(&self, event: AgentEvent) -> Result<(), PluginError> {
        self.allow(Permission::Events)?;
        Ok(self.host.emit(&self.account.id, event).await?)
    }
}
