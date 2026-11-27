//! Making an installation account from what a person pastes, and choosing the account that owns
//! a repository.

use jian_plugin_api::{AccountRef, Secret};
use serde_json::{Value, json};

use crate::config::{AppConfig, Config, Credentials, DEFAULT_API_BASE};
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
    /// The agent that reviews the pull requests GitHub says were opened or pushed to.
    pub review_agent: Option<String>,
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
        review_agent: new.review_agent.clone().filter(|id| !id.is_empty()),
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
        "reviewAgent": config.review_agent,
    });
    Ok((settings, secret))
}

/// The settings and the secret of the account that holds an App registered here, before any
/// installation: the key and the webhook secret GitHub made for it.
pub fn build_app(
    app_id: &str,
    private_key: &str,
    webhook_secret: &str,
    api_base: Option<&str>,
) -> Result<(Value, Secret), GithubError> {
    let config = AppConfig::parse(&json!({
        "appId": app_id.trim(),
        "apiBase": api_base.map_or_else(|| DEFAULT_API_BASE.to_owned(), |b| b.trim().to_owned()),
    }))?;
    jwt::check_key(private_key)?;
    let secret = Credentials {
        private_key: private_key.to_owned(),
        webhook_secret: Some(webhook_secret.to_owned()).filter(|s| !s.is_empty()),
        ..Credentials::default()
    }
    .seal()?;
    Ok((
        json!({ "appId": config.app_id, "apiBase": config.api_base }),
        secret,
    ))
}

/// `current` with the webhook secret replaced and everything else, the token included, kept.
pub fn with_webhook_secret(current: &Secret, webhook_secret: &str) -> Result<Secret, GithubError> {
    let mut credentials = Credentials::read(current)?;
    credentials.webhook_secret = Some(webhook_secret.to_owned());
    credentials.seal()
}

/// The webhook secret an account's vault holds, when it has one.
pub fn webhook_secret_of(secret: &Secret) -> Option<String> {
    Credentials::read(secret)
        .ok()
        .and_then(|c| c.webhook_secret)
        .filter(|s| !s.is_empty())
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
