//! The pairing: which gateway, and the machine token it gave. The token alone names the machine
//! and its tenant, so nothing else is stored.

use anyhow::{Context as _, bail};
use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::args::TokenArgs;
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub gateway: String,
    pub token: String,
}

pub fn load() -> anyhow::Result<Config> {
    let path = paths::config_path();
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "No Jian Remote config at {}. Run install first: jian-remote install --gateway https://… --token-prompt",
            path.display()
        )
    })?;
    serde_json::from_str(&text)
        .with_context(|| format!("{} is not a Jian Remote config", path.display()))
}

/// The gateway's base URL as stored: https with no credentials, query or fragment, and no
/// trailing slash. Plain http only for a gateway on this machine.
pub fn parse_gateway(gateway: &str) -> anyhow::Result<String> {
    let url = url_of(gateway)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("The gateway URL must not carry credentials, a query or a fragment.");
    }
    jian_remote::transport::gateway_connect_url(gateway)?;
    let base = url.as_str().trim_end_matches('/');
    Ok(base.to_owned())
}

fn url_of(text: &str) -> anyhow::Result<reqwest::Url> {
    reqwest::Url::parse(text.trim()).context("Not a URL")
}

/// `--token VALUE` for the one-liner the panel shows; `--token-stdin` or `--token-prompt` keep
/// the token out of shell history.
pub fn read_token(args: &TokenArgs) -> anyhow::Result<Option<String>> {
    if let Some(token) = &args.token {
        return Ok(Some(token.trim().to_owned()));
    }
    if args.token_stdin {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .context("Could not read the token from standard input")?;
        return Ok(Some(text.trim().to_owned()));
    }
    if args.token_prompt {
        return prompt_secret("Machine token (input hidden): ").map(Some);
    }
    Ok(None)
}

fn prompt_secret(prompt: &str) -> anyhow::Result<String> {
    if !std::io::stdin().is_terminal() {
        bail!("A hidden prompt needs a terminal; use --token-stdin instead.");
    }
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let _echo = EchoOff::new();
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("Could not read the token")?;
    println!();
    Ok(line.trim().to_owned())
}

/// Terminal echo off until dropped, so the token never shows on screen; back on however the read
/// ends. Windows has no termios: there the prompt echoes, and `--token-stdin` is the way.
struct EchoOff {
    #[cfg(unix)]
    saved: Option<rustix::termios::Termios>,
}

impl EchoOff {
    fn new() -> Self {
        #[cfg(unix)]
        {
            use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};
            let stdin = std::io::stdin();
            // Not a terminal (a pipe): there is no echo to turn off.
            let Ok(saved) = tcgetattr(&stdin) else {
                return Self { saved: None };
            };
            let mut quiet = saved.clone();
            quiet.local_modes.remove(LocalModes::ECHO);
            let _ = tcsetattr(&stdin, OptionalActions::Now, &quiet);
            Self { saved: Some(saved) }
        }
        #[cfg(not(unix))]
        Self {}
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(saved) = &self.saved {
            let _ = rustix::termios::tcsetattr(
                std::io::stdin(),
                rustix::termios::OptionalActions::Now,
                saved,
            );
        }
    }
}

/// Owner-only: the token is the machine's whole credential.
pub fn save(config: &Config) -> anyhow::Result<()> {
    let dir = paths::config_dir();
    let path = paths::config_path();
    let text = serde_json::to_string_pretty(config).context("Could not encode the config")?;
    jian_remote::state::write_private(&path, &format!("{text}\n"))
        .with_context(|| format!("Could not write {}", path.display()))?;
    if cfg!(windows) {
        restrict_windows(&dir, "(OI)(CI)F")?;
        restrict_windows(&path, "F")?;
    }
    Ok(())
}

/// Windows ignores Unix modes: the ACL is cut down to the current user instead.
fn restrict_windows(path: &Path, rights: &str) -> anyhow::Result<()> {
    let account =
        std::env::var("USERNAME").context("Could not identify the current Windows user.")?;
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("{account}:{rights}")])
        .stdout(std::process::Stdio::null())
        .status()
        .context("Could not run icacls")?;
    if !status.success() {
        bail!("Could not restrict permissions on {}.", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_a_clean_gateway_base() {
        assert_eq!(
            parse_gateway("https://jian.example.com/").unwrap(),
            "https://jian.example.com"
        );
        assert_eq!(
            parse_gateway("https://example.com/jian/").unwrap(),
            "https://example.com/jian"
        );
        assert_eq!(
            parse_gateway("http://127.0.0.1:4310").unwrap(),
            "http://127.0.0.1:4310"
        );
        assert!(parse_gateway("http://jian.example.com").is_err());
        assert!(parse_gateway("https://user:pass@jian.example.com").is_err());
        assert!(parse_gateway("https://jian.example.com/?a=1").is_err());
    }
}
