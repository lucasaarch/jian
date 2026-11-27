//! The flags that set up sign-in with GitHub.

use anyhow::Context as _;
use clap::Args;
use jian_auth::{GITHUB_API_URL, GITHUB_OAUTH_URL, GithubApp};
use jian_server::PublicUrl;
use jian_store::secrets::Secret;

/// The GitHub OAuth App people sign in with. Both the id and the secret, or neither. Signing in
/// with it also needs `github` in `--auth-methods` and `--public-url`, whose `/login/github` is the
/// App's callback.
#[derive(Args)]
pub struct GithubFlags {
    /// The OAuth App's client id (an OAuth App, not a GitHub App).
    #[arg(
        long = "github-client-id",
        id = "github_client_id",
        env = "JIAN_GITHUB_CLIENT_ID",
        value_name = "ID",
        requires = "github_client_secret"
    )]
    client_id: Option<String>,

    /// The OAuth App's client secret. Held in memory and sent only to GitHub's token endpoint;
    /// `--help` does not show its value.
    #[arg(
        long = "github-client-secret",
        id = "github_client_secret",
        env = "JIAN_GITHUB_CLIENT_SECRET",
        value_name = "SECRET",
        hide_env_values = true,
        requires = "github_client_id"
    )]
    client_secret: Option<String>,

    /// Where GitHub's OAuth pages are. Only for GitHub Enterprise or a test server.
    #[arg(long = "github-oauth-url", env = "JIAN_GITHUB_OAUTH_URL", value_name = "URL", default_value = GITHUB_OAUTH_URL)]
    oauth_url: String,

    /// Where GitHub's API is. Only for GitHub Enterprise or a test server.
    #[arg(long = "github-api-url", env = "JIAN_GITHUB_API_URL", value_name = "URL", default_value = GITHUB_API_URL)]
    api_url: String,
}

impl GithubFlags {
    /// The OAuth App, when the flags gave one.
    pub fn app(&self, public: Option<&PublicUrl>) -> anyhow::Result<Option<GithubApp>> {
        let (Some(id), Some(secret)) = (&self.client_id, &self.client_secret) else {
            return Ok(None);
        };
        let public = public.context("--github-client-id needs --public-url for its callback")?;
        let app = GithubApp::new(id, Secret::new(secret.clone()), public.github_callback())
            .context("the GitHub OAuth App is not usable")?
            .with_urls(&self.oauth_url, &self.api_url);
        Ok(Some(app))
    }
}
