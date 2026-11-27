//! Making an installation account from what a person pastes, and choosing the account that owns
//! a repository.

use jian_plugin_api::{AccountRef, Secret};
use serde_json::{Value, json};

use crate::config::{Config, Credentials, DEFAULT_API_BASE};
use crate::error::GithubError;
use crate::{GITHUB_ID, jwt};

/// What a person gives to add one installation of a GitHub App.
#[derive(Clone, Default)]
pub struct NewInstallation {
    /// The App's id.
    pub app_id: String,
    /// The installation's id.
    pub installation_id: u64,
    /// The user or organization it is installed on.
    pub login: String,
    /// The App's private key, PEM.
    pub private_key: String,
    /// The App's webhook secret, when it has a webhook.
    pub webhook_secret: Option<String>,
    /// A GitHub Enterprise address; GitHub's own when left out.
    pub api_base: Option<String>,
}

impl std::fmt::Debug for NewInstallation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewInstallation")
            .field("login", &self.login)
            .finish_non_exhaustive()
    }
}

/// The settings and the secret of the account `new` describes. The key is checked here, so a
/// wrong paste is told to the person who made it.
pub fn build(new: &NewInstallation) -> Result<(Value, Secret), GithubError> {
    let config = Config {
        app_id: new.app_id.trim().to_owned(),
        installation_id: new.installation_id,
        login: new.login.trim().to_owned(),
        api_base: new.api_base.as_deref().map_or_else(
            || DEFAULT_API_BASE.to_owned(),
            |base| base.trim().to_owned(),
        ),
    }
    .validated()?;
    if config.installation_id == 0 {
        return Err(GithubError::Config("the installation id is a number"));
    }
    jwt::check_key(&new.private_key)?;
    let secret = Credentials {
        private_key: new.private_key.clone(),
        webhook_secret: new.webhook_secret.clone().filter(|s| !s.is_empty()),
        ..Credentials::default()
    }
    .seal()?;
    let settings = json!({
        "appId": config.app_id,
        "installationId": config.installation_id,
        "login": config.login,
        "apiBase": config.api_base,
    });
    Ok((settings, secret))
}

/// The account whose installation owns `repo` (`owner/name`): the one on that owner. Several
/// installations are several accounts, each on a user or organization, so the owner of the
/// repository says which one to call. `None` when no account is on that owner, and the caller
/// says so rather than trying another's token.
pub fn owner_of<'a>(accounts: &'a [AccountRef], repo: &str) -> Option<&'a AccountRef> {
    let owner = repo.split_once('/')?.0;
    accounts.iter().find(|account| {
        account.plugin == GITHUB_ID
            && account.config["login"]
                .as_str()
                .is_some_and(|login| login.eq_ignore_ascii_case(owner))
    })
}
