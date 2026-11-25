//! The pairing: which gateway, and the machine token it gave. The token alone names the machine
//! and its tenant, so nothing else is stored.

use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::args::Args;
use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub gateway: String,
    pub token: String,
}

pub fn load() -> Result<Config, String> {
    let path = paths::config_path();
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "No Jian Remote config at {}. Run install first: jian-remote install --gateway https://… --token-prompt",
            path.display()
        )
    })?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not a Jian Remote config: {error}", path.display()))
}

/// The gateway's base URL as stored: https with no credentials, query or fragment, and no
/// trailing slash. Plain http only for a gateway on this machine.
pub fn parse_gateway(gateway: &str) -> Result<String, String> {
    let url = url_of(gateway)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The gateway URL must not carry credentials, a query or a fragment.".into());
    }
    jian_remote::transport::gateway_connect_url(gateway)?;
    let base = url.as_str().trim_end_matches('/');
    Ok(base.to_owned())
}

fn url_of(text: &str) -> Result<reqwest::Url, String> {
    reqwest::Url::parse(text.trim()).map_err(|error| format!("Not a URL: {error}"))
}

/// `--token VALUE` for the one-liner the panel shows; `--token-stdin` or `--token-prompt` keep
/// the token out of shell history.
pub fn read_token(args: &Args) -> Result<Option<String>, String> {
    if let Some(token) = args.option(&["--token"]) {
        return Ok(Some(token.trim().to_owned()));
    }
    if args.flag(&["--token-stdin"]) {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        return Ok(Some(text.trim().to_owned()));
    }
    if args.flag(&["--token-prompt"]) {
        return prompt_secret("Machine token (input hidden): ").map(Some);
    }
    Ok(None)
}

fn prompt_secret(prompt: &str) -> Result<String, String> {
    if !std::io::stdin().is_terminal() {
        return Err("A hidden prompt needs a terminal; use --token-stdin instead.".into());
    }
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let _echo = EchoOff::new();
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    println!();
    Ok(line.trim().to_owned())
}

/// Terminal echo off until dropped, so the token never shows on screen; back on however the read
/// ends. Windows has no termios: there the prompt echoes, and `--token-stdin` is the way.
struct EchoOff {
    #[cfg(unix)]
    saved: Option<libc::termios>,
}

impl EchoOff {
    fn new() -> Self {
        #[cfg(unix)]
        {
            // SAFETY: termios is plain data; tcgetattr fills it, and stdin is a terminal here.
            let mut current: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut current) } != 0 {
                return Self { saved: None };
            }
            let saved = current;
            current.c_lflag &= !libc::ECHO;
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &current) };
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
            // SAFETY: restores the settings tcgetattr read.
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, saved) };
        }
    }
}

/// Owner-only: the token is the machine's whole credential.
pub fn save(config: &Config) -> Result<(), String> {
    let dir = paths::config_dir();
    let path = paths::config_path();
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    jian_remote::state::write_private(&path, &format!("{text}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    if cfg!(windows) {
        restrict_windows(&dir, "(OI)(CI)F")?;
        restrict_windows(&path, "F")?;
    }
    Ok(())
}

/// Windows ignores Unix modes: the ACL is cut down to the current user instead.
fn restrict_windows(path: &Path, rights: &str) -> Result<(), String> {
    let account = std::env::var("USERNAME")
        .map_err(|_| "Could not identify the current Windows user.".to_owned())?;
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("{account}:{rights}")])
        .stdout(std::process::Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not restrict permissions on {}.",
            path.display()
        ))
    }
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
