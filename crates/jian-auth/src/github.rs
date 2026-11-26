//! Talking to GitHub as an OAuth App: where to send the person, and who GitHub says they are once
//! they come back with a code.
//!
//! GitHub's access token is used for two reads (`/user` and `/user/emails`) and dropped. It is
//! never stored, never put in an error, and the only place it lives is a [`Secret`] that prints
//! as a placeholder. What survives is the identity: GitHub's numeric user id, the login (only to
//! show) and the addresses GitHub itself marked verified.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_store::secrets::Secret;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::AuthError;

/// Where GitHub's OAuth pages are.
pub const GITHUB_OAUTH_URL: &str = "https://github.com";
/// Where GitHub's API is.
pub const GITHUB_API_URL: &str = "https://api.github.com";

/// The longest a call to GitHub may take.
const TIMEOUT: Duration = Duration::from_secs(15);

/// An OAuth App registered at GitHub (an OAuth App, not a GitHub App) and where to reach GitHub.
/// The client secret is only ever a form field of the one request that trades a code.
#[derive(Debug)]
pub struct GithubApp {
    client_id: String,
    client_secret: Secret,
    redirect_uri: String,
    oauth_url: String,
    api_url: String,
    http: reqwest::Client,
}

impl GithubApp {
    /// The App `client_id`, whose callback is `redirect_uri` (a page of the panel that hands the
    /// `code` and `state` it was given to the gateway). It talks to the real GitHub.
    pub fn new(
        client_id: impl Into<String>,
        client_secret: Secret,
        redirect_uri: impl Into<String>,
    ) -> Result<Self, AuthError> {
        // reqwest's rustls has no provider of its own here (see the workspace manifest): ring is
        // installed before the first client. An error only means one is already installed.
        drop(rustls::crypto::ring::default_provider().install_default());
        // No redirects: the secret and the code must reach only the address they were given for.
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| AuthError::GithubUnavailable("the HTTP client could not be built"))?;
        Ok(Self {
            client_id: client_id.into(),
            client_secret,
            redirect_uri: redirect_uri.into(),
            oauth_url: GITHUB_OAUTH_URL.to_owned(),
            api_url: GITHUB_API_URL.to_owned(),
            http,
        })
    }

    /// Points at other servers than GitHub's: a test's fake, or GitHub Enterprise.
    #[must_use]
    pub fn with_urls(mut self, oauth_url: &str, api_url: &str) -> Self {
        oauth_url
            .trim_end_matches('/')
            .clone_into(&mut self.oauth_url);
        api_url.trim_end_matches('/').clone_into(&mut self.api_url);
        self
    }

    /// Where to send the person: GitHub's authorize page with the PKCE challenge of `verifier`.
    pub(crate) fn authorize_url(&self, state: &str, verifier: &str) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", "read:user user:email")
            .append_pair("state", state)
            .append_pair("code_challenge", &pkce_challenge(verifier))
            .append_pair("code_challenge_method", "S256")
            .finish();
        format!("{}/login/oauth/authorize?{query}", self.oauth_url)
    }

    /// Trades the code for who the person is. The access token lives only inside this call.
    pub(crate) async fn identity(
        &self,
        code: &str,
        verifier: &str,
    ) -> Result<GithubIdentity, AuthError> {
        let token = self.exchange(code, verifier).await?;
        let user: UserAnswer = self.read(&token, "/user").await?;
        let emails: Vec<EmailAnswer> = self.read(&token, "/user/emails").await?;
        Ok(GithubIdentity {
            id: user.id.to_string(),
            login: user.login,
            verified_emails: emails
                .into_iter()
                .filter(|email| email.verified)
                .map(|email| email.email)
                .collect(),
        })
    }

    async fn exchange(&self, code: &str, verifier: &str) -> Result<Secret, AuthError> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.client_id)
            .append_pair("client_secret", self.client_secret.expose())
            .append_pair("code", code)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("code_verifier", verifier)
            .finish();
        let response = self
            .http
            .post(format!("{}/login/oauth/access_token", self.oauth_url))
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| AuthError::GithubUnavailable("no answer"))?;
        if !response.status().is_success() {
            return Err(AuthError::GithubUnavailable("an unexpected answer"));
        }
        let answer: TokenAnswer = response
            .json()
            .await
            .map_err(|_| AuthError::GithubUnavailable("an unexpected answer"))?;
        // GitHub answers 200 with `error` for a bad, used or expired code.
        match answer.access_token {
            Some(token) if !token.is_empty() => Ok(Secret::new(token)),
            _ => Err(AuthError::GithubRefused),
        }
    }

    async fn read<T: for<'de> Deserialize<'de>>(
        &self,
        token: &Secret,
        path: &str,
    ) -> Result<T, AuthError> {
        let response = self
            .http
            .get(format!("{}{path}", self.api_url))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "jian")
            .bearer_auth(token.expose())
            .send()
            .await
            .map_err(|_| AuthError::GithubUnavailable("no answer"))?;
        if !response.status().is_success() {
            return Err(AuthError::GithubUnavailable("an unexpected answer"));
        }
        response
            .json()
            .await
            .map_err(|_| AuthError::GithubUnavailable("an unexpected answer"))
    }
}

/// Who GitHub says the person is.
#[derive(Debug)]
pub(crate) struct GithubIdentity {
    /// GitHub's numeric user id, as text: the key of the credential.
    pub(crate) id: String,
    /// The login, only to show.
    pub(crate) login: String,
    /// The addresses GitHub marked verified. An unverified one is not here and is never used.
    pub(crate) verified_emails: Vec<String>,
}

// Not `Debug`: this holds the access token before it is wrapped.
#[derive(Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct UserAnswer {
    id: u64,
    login: String,
}

#[derive(Deserialize)]
struct EmailAnswer {
    email: String,
    verified: bool,
}

/// The PKCE challenge of a verifier: `BASE64URL(SHA256(verifier))` (RFC 7636, `S256`).
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_one_rfc_7636_gives_for_its_example_verifier() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_secret_is_not_in_the_debug_output() {
        let app = GithubApp::new(
            "id-1",
            Secret::new("super-secret-value"),
            "https://x.test/cb",
        )
        .unwrap();
        let shown = format!("{app:?}");
        assert!(!shown.contains("super-secret-value"), "{shown}");
        let url = app.authorize_url("st", "ver");
        assert!(url.contains("code_challenge_method=S256") && !url.contains("super-secret"));
    }
}
