//! What `github_git` hands git, built from checked input alone.
//!
//! Clone, fetch, pull and push of a repository the installation reaches, on the machine where the
//! agent works. This module only makes text: the command line and the environment of one git
//! process. It runs nothing (the host does, on the run's machine) and keeps no state.
//!
//! The token never touches the machine's disk or the command line. It goes as `GIT_CONFIG_*`
//! environment variables of that one process: a Basic `Authorization` header for the one origin,
//! no credential helper (a login stored on the machine is not tried instead), and every URL the
//! checkout's `origin` is known by rewritten to the HTTPS one for this command alone, which also
//! beats an `insteadOf` of the machine's own that sends GitHub to SSH. Nothing is written to
//! `.git/config`, and the remote URL stays as it was. The command line holds only checked names:
//! no option can come from the agent, and everything a shell could read specially is refused.
//!
//! The command line is plain enough to be read the same by `/bin/sh` and by PowerShell, so one
//! text serves every machine the agent may be on.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use crate::config::{DEFAULT_API_BASE, is_name};
use crate::error::GithubError;
use crate::input;

/// What the agent asked git to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// A new checkout.
    Clone {
        /// Only the last commits, when set.
        depth: Option<u32>,
        /// The branch to check out.
        branch: Option<String>,
    },
    /// Fetch `origin`.
    Fetch {
        /// That branch only.
        branch: Option<String>,
    },
    /// Pull `origin`: fast-forward only unless `rebase`.
    Pull {
        /// That branch only.
        branch: Option<String>,
        /// Rebase instead of fast-forward.
        rebase: bool,
    },
    /// Push a branch, with a lease when `force`.
    Push {
        /// The branch.
        branch: String,
        /// Overwrite the remote branch only if it is where this checkout last saw it.
        force: bool,
    },
    /// Push a tag; one GitHub already has never moves.
    PushTag {
        /// The tag.
        tag: String,
    },
}

/// A checked call of the tool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// `owner/name`.
    pub repo: String,
    /// The checkout, as the agent wrote it; the repository's name when it did not say.
    pub path: String,
    /// What to do.
    pub action: Action,
}

/// One git process to run, and the values to keep out of what it prints.
#[derive(Clone)]
pub struct Plan {
    /// The command line.
    pub script: String,
    /// The environment of that command alone: it holds the token.
    pub env: BTreeMap<String, String>,
    /// Every form the token takes, for [`redact`].
    pub secrets: Vec<String>,
}

impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plan")
            .field("script", &self.script)
            .finish_non_exhaustive()
    }
}

fn bad(why: &str) -> GithubError {
    GithubError::Input(why.to_owned())
}

/// A ref name as git accepts it, never starting with `-`.
#[allow(
    clippy::case_sensitive_file_extension_comparisons,
    reason = "git refuses `.lock` in lower case only; this is not a file name"
)]
fn ref_name(text: &str, what: &str) -> Result<String, GithubError> {
    let ok = !text.is_empty()
        && text.len() <= 200
        && !text.starts_with(['-', '/', '.'])
        && !text.ends_with(['/', '.'])
        && !text.contains("..")
        && !text.contains("//")
        && !text.contains("@{")
        && !text.ends_with(".lock")
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'+' | b'-'));
    if ok {
        Ok(text.to_owned())
    } else {
        Err(GithubError::Input(format!("not a {what} name git accepts")))
    }
}

/// A path the command line can carry without a shell reading anything in it.
fn checkout_path(text: &str) -> Result<String, GithubError> {
    let ok = !text.is_empty()
        && text.len() <= 4096
        && !text.starts_with(['-', '~'])
        && text.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b' ' | b'.' | b'_' | b'-' | b'/' | b'\\' | b':' | b'+' | b'@' | b','
                )
        });
    if ok {
        Ok(text.to_owned())
    } else {
        Err(bad(
            "use a plain path: letters, digits, spaces and . _ - / \\ : + @ ,",
        ))
    }
}

impl Request {
    /// Reads the tool's input. A push that names no branch or tag, both, or a forced tag is
    /// refused here, before any token is made for it.
    pub fn parse(input: &Value) -> Result<Self, GithubError> {
        let (owner, name) = input::repo(&json_repo(input))?;
        let path = match input::optional(input, "path") {
            Some(path) => checkout_path(path.trim())?,
            None => name.clone(),
        };
        let branch = input::optional(input, "branch")
            .map(|b| ref_name(b.trim(), "branch"))
            .transpose()?;
        let tag = input::optional(input, "tag")
            .map(|t| ref_name(t.trim(), "tag"))
            .transpose()?;
        let flag = |key: &str| input[key].as_bool() == Some(true);
        let action = match input::text(input, "action")? {
            "clone" => Action::Clone {
                depth: match input["depth"].as_u64() {
                    Some(n @ 1..=10_000) => u32::try_from(n).ok(),
                    Some(_) => return Err(bad("depth is between 1 and 10000")),
                    None => None,
                },
                branch,
            },
            "fetch" => Action::Fetch { branch },
            "pull" => Action::Pull {
                branch,
                rebase: flag("rebase"),
            },
            "push" => match (branch, tag) {
                (Some(_), Some(_)) => return Err(bad("push a branch or a tag, not both")),
                (None, None) => return Err(bad("name the branch or the tag to push")),
                (Some(branch), None) => Action::Push {
                    branch,
                    force: flag("force"),
                },
                (None, Some(_)) if flag("force") => {
                    return Err(bad(
                        "a tag is never force-pushed: a published tag never moves",
                    ));
                }
                (None, Some(tag)) => Action::PushTag { tag },
            },
            _ => return Err(bad("the action is clone, fetch, pull or push")),
        };
        Ok(Self {
            repo: format!("{owner}/{name}"),
            path,
            action,
        })
    }

    /// Whether this action starts a checkout, which has no origin to look at yet.
    #[must_use]
    pub fn is_clone(&self) -> bool {
        matches!(self.action, Action::Clone { .. })
    }
}

/// The tool's `repository` key is the plugin's `repo` everywhere else.
fn json_repo(input: &Value) -> Value {
    serde_json::json!({ "repo": input["repository"] })
}

/// Where git reaches repositories of an installation's API address: github.com for GitHub's own,
/// the server's root for an Enterprise `…/api/v3`, and the address itself otherwise (a test's).
#[must_use]
pub fn web_base(api_base: &str) -> String {
    if api_base == DEFAULT_API_BASE {
        "https://github.com".to_owned()
    } else {
        api_base
            .strip_suffix("/api/v3")
            .unwrap_or(api_base)
            .to_owned()
    }
}

fn https_url(base: &str, repo: &str) -> String {
    format!("{base}/{repo}.git")
}

/// An argument as the command line carries it: bare when plain, in double quotes otherwise (a
/// checked path never holds what quotes would not stop a shell reading).
fn quote(arg: &str) -> String {
    let plain = arg.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'.' | b'_' | b'/' | b':' | b'=' | b'-' | b'+' | b'@')
    });
    if plain {
        arg.to_owned()
    } else {
        format!("\"{arg}\"")
    }
}

fn line(args: &[String]) -> String {
    let mut text = String::from("git");
    for arg in args {
        text.push(' ');
        text.push_str(&quote(arg));
    }
    text
}

/// The command that reads the raw URLs of `origin`, before any `insteadOf` of the machine's own
/// rewrites them. It carries no credential.
#[must_use]
pub fn origin_script(path: &str) -> String {
    line(&[
        "-C".to_owned(),
        path.to_owned(),
        "config".to_owned(),
        "--get-regexp".to_owned(),
        // Unanchored on purpose, so no character in it means anything to a shell; `origin_urls`
        // keeps the two keys that are URLs.
        "remote.origin.".to_owned(),
    ])
}

/// The URLs in what [`origin_script`] printed.
#[must_use]
pub fn origin_urls(output: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for line in output.lines() {
        let mut parts = line.trim().splitn(2, char::is_whitespace);
        let (Some(key), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        let url = url.trim().to_owned();
        if matches!(key, "remote.origin.url" | "remote.origin.pushurl") && !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

/// Whether `url` names `repo`: over HTTPS at the installation's origin, or over SSH at github.com,
/// with or without `.git`. GitHub ignores case, and so does this.
#[must_use]
pub fn names_repository(url: &str, repo: &str, https: &str) -> bool {
    let name = repo.to_ascii_lowercase();
    let strip = |text: &str| {
        let text = text.trim().trim_end_matches('/').to_ascii_lowercase();
        text.strip_suffix(".git")
            .map_or(text.clone(), str::to_owned)
    };
    let plain = strip(url);
    [
        strip(https),
        format!("https://github.com/{name}"),
        format!("git@github.com:{name}"),
        format!("ssh://git@github.com/{name}"),
        format!("ssh://git@github.com:22/{name}"),
    ]
    .contains(&plain)
}

/// Why a checkout may not be lent a token: its origin is another repository, or it has none.
pub fn check_origin(request: &Request, base: &str, urls: &[String]) -> Result<(), GithubError> {
    let https = https_url(base, &request.repo);
    if urls.is_empty() {
        return Err(GithubError::Input(format!(
            "the checkout at {} has no origin remote; set origin to {https} with git first",
            request.path
        )));
    }
    let elsewhere: Vec<&str> = urls
        .iter()
        .map(String::as_str)
        .filter(|url| !names_repository(url, &request.repo, &https))
        .collect();
    if elsewhere.is_empty() {
        Ok(())
    } else {
        Err(GithubError::Input(format!(
            "the origin of {} is {}, not {}; name the repository this checkout comes from",
            request.path,
            elsewhere.join(", "),
            request.repo
        )))
    }
}

/// The command and the environment for `request`, with `token` lent to it. `urls` are the ones
/// the checkout's origin is known by (empty for a clone).
#[must_use]
pub fn plan(request: &Request, base: &str, token: &str, urls: &[String]) -> Plan {
    let https = https_url(base, &request.repo);
    let path = request.path.clone();
    let on = |verb: &str| vec!["-C".to_owned(), path.clone(), verb.to_owned()];
    let mut args = match &request.action {
        Action::Clone { depth, branch } => {
            let mut args = vec!["clone".to_owned()];
            if let Some(branch) = branch {
                args.extend(["--branch".to_owned(), branch.clone()]);
            }
            if let Some(depth) = depth {
                args.extend(["--depth".to_owned(), depth.to_string()]);
            }
            args.extend(["--".to_owned(), https.clone(), path.clone()]);
            args
        }
        Action::Fetch { branch } => {
            let mut args = on("fetch");
            // Submodules live elsewhere; the credential is for this repository alone.
            args.extend(["--no-recurse-submodules".to_owned(), "origin".to_owned()]);
            args.extend(branch.clone());
            args
        }
        Action::Pull { branch, rebase } => {
            let mut args = on("pull");
            args.push("--no-recurse-submodules".to_owned());
            args.push(if *rebase { "--rebase" } else { "--ff-only" }.to_owned());
            args.push("origin".to_owned());
            args.extend(branch.clone());
            args
        }
        Action::Push { branch, force } => {
            let mut args = on("push");
            // A lease, not a blind force: it refuses when the branch moved since it was fetched.
            if *force {
                args.push("--force-with-lease".to_owned());
            }
            args.extend([
                "--set-upstream".to_owned(),
                "origin".to_owned(),
                format!("refs/heads/{branch}:refs/heads/{branch}"),
            ]);
            args
        }
        Action::PushTag { tag } => {
            let mut args = on("push");
            // Under refs/tags, so a tag is never sent as a branch of the same name.
            args.extend([
                "origin".to_owned(),
                format!("refs/tags/{tag}:refs/tags/{tag}"),
            ]);
            args
        }
    };
    let script = line(&std::mem::take(&mut args));
    let (env, secrets) = credential_env(&https, token, urls);
    Plan {
        script,
        env,
        secrets,
    }
}

fn credential_env(
    https: &str,
    token: &str,
    urls: &[String],
) -> (BTreeMap<String, String>, Vec<String>) {
    // `https` is `<origin>/<owner>/<name>.git`: the header is for the origin alone.
    let origin = url::Url::parse(https)
        .map_or_else(|_| String::new(), |url| url.origin().ascii_serialization());
    let encoded = STANDARD.encode(format!("x-access-token:{token}"));
    let header = format!("AUTHORIZATION: basic {encoded}");
    let mut entries = vec![
        (format!("http.{origin}/.extraheader"), header.clone()),
        ("credential.helper".to_owned(), String::new()),
    ];
    let mut known = vec![https.to_owned()];
    known.extend(urls.iter().filter(|url| url.as_str() != https).cloned());
    for url in known {
        entries.push((format!("url.{https}.insteadOf"), url.clone()));
        entries.push((format!("url.{https}.pushInsteadOf"), url));
    }
    let mut env = BTreeMap::new();
    for (index, (key, value)) in entries.iter().enumerate() {
        env.insert(format!("GIT_CONFIG_KEY_{index}"), key.clone());
        env.insert(format!("GIT_CONFIG_VALUE_{index}"), value.clone());
    }
    env.insert("GIT_CONFIG_COUNT".to_owned(), entries.len().to_string());
    // A refused token fails at once instead of waiting on a prompt nobody can answer.
    env.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
    env.insert("GCM_INTERACTIVE".to_owned(), "never".to_owned());
    (env, vec![token.to_owned(), encoded, header])
}

/// `text` without the token in any of its forms.
#[must_use]
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut clean = text.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        clean = clean.replace(secret.as_str(), "[redacted]");
    }
    clean
}

/// What a failed git command means, in words the agent can act on.
#[must_use]
pub fn problem(output: &str, repo: &str) -> Option<String> {
    let text = output.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    let said = if has(&["repository not found", "not found"]) || text.contains("404") {
        format!(
            "GitHub says {repo} is not found to the GitHub App. The owner can grant the App access to it on GitHub."
        )
    } else if has(&[
        "authentication failed",
        "could not read username",
        "terminal prompts disabled",
        "invalid username or",
        "401",
    ]) {
        format!(
            "GitHub refused the App's token for {repo}. Try once more; if it is refused again, the owner should check the App's installation and permissions."
        )
    } else if has(&["gh006", "protected branch"]) {
        "GitHub refused the push: the branch is protected. Push another branch and open a pull request.".to_owned()
    } else if text.contains("(already exists)") {
        "GitHub already has this tag, and a published tag is never moved. Tag the next version instead.".to_owned()
    } else if text.contains("stale info") {
        "The forced push was refused: the remote branch moved since it was last fetched. Fetch, look at what changed, and decide again.".to_owned()
    } else if has(&["[rejected]", "non-fast-forward", "fetch first"]) {
        "The push was rejected: the remote branch has commits this one does not. Pull (with rebase to keep history linear), resolve any conflict, and push again. Force only when the owner asked.".to_owned()
    } else if has(&[
        "not possible to fast-forward",
        "diverging branches",
        "have diverged",
    ]) {
        "The pull stopped: the local and remote branches have diverged. Pull again with rebase, or merge with git yourself.".to_owned()
    } else if has(&["403", "permission to", "write access"]) {
        format!(
            "GitHub refused the App's access to {repo} for this. The owner can check the App's repository access and permissions."
        )
    } else if text.contains("already exists and is not an empty directory") {
        "The path already exists and is not empty. Pick another path, or fetch or pull in the checkout that is there.".to_owned()
    } else if has(&["cannot change to", "not a git repository"]) {
        "There is no git checkout at that path. Clone it first.".to_owned()
    } else {
        return None;
    };
    Some(said)
}

/// Whether `repo` is a name this module will put in a URL.
#[must_use]
pub fn is_repo(repo: &str) -> bool {
    repo.split_once('/')
        .is_some_and(|(owner, name)| is_name(owner) && is_name(name))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const TOKEN: &str = "ghs_synthetic-unit";
    const BASE: &str = "https://github.com";

    fn parse(input: &Value) -> Result<Request, GithubError> {
        Request::parse(input)
    }

    #[test]
    fn a_request_holds_only_checked_names_and_a_push_names_one_ref() {
        let ok = parse(&json!({ "action": "push", "repository": "acme/web", "branch": "fix/a-1" }));
        assert!(matches!(
            ok,
            Ok(Request {
                action: Action::Push { force: false, .. },
                ..
            })
        ));
        for bad in [
            json!({ "action": "push", "repository": "acme/web" }),
            json!({ "action": "push", "repository": "acme/web", "branch": "a", "tag": "v1" }),
            json!({ "action": "push", "repository": "acme/web", "tag": "v1", "force": true }),
            json!({ "action": "push", "repository": "acme/web", "branch": "--force" }),
            json!({ "action": "clone", "repository": "acme/web", "path": "x; rm -rf /" }),
            json!({ "action": "clone", "repository": "acme/web", "path": "$(id)" }),
            json!({ "action": "clone", "repository": "acme/web", "depth": 0 }),
            json!({ "action": "clone", "repository": "acme" }),
            json!({ "action": "rebase", "repository": "acme/web" }),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_token_is_in_the_environment_of_the_command_and_never_in_its_text() {
        let request = parse(&json!({ "action": "clone", "repository": "acme/web" })).ok();
        let Some(request) = request else {
            panic!("a clone parses");
        };
        let plan = plan(&request, BASE, TOKEN, &[]);
        assert_eq!(
            plan.script,
            "git clone -- https://github.com/acme/web.git web"
        );
        let header = plan
            .env
            .values()
            .find(|v| v.starts_with("AUTHORIZATION: basic "));
        assert!(header.is_some());
        assert!(!plan.script.contains(TOKEN));
        assert!(!format!("{plan:?}").contains(TOKEN));
        // A login stored on the machine is not tried, and nothing waits for a prompt.
        assert!(plan.env.values().any(String::is_empty));
        assert_eq!(
            plan.env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );
        // Printed by git, in any of its forms, it is masked.
        let leaked = plan.secrets.join(" and ");
        assert!(!redact(&leaked, &plan.secrets).contains(TOKEN));
    }

    #[test]
    fn a_checkout_of_another_repository_is_refused_whatever_the_url_looks_like() {
        let request = parse(&json!({ "action": "fetch", "repository": "acme/web", "path": "w" }))
            .ok()
            .unwrap_or_else(|| panic!("a fetch parses"));
        let ours = |url: &str| check_origin(&request, BASE, &[url.to_owned()]).is_ok();
        assert!(ours("https://github.com/acme/web.git"));
        assert!(ours("git@github.com:Acme/Web.git"));
        assert!(!ours("https://github.com/acme/web-other.git"));
        assert!(!ours("https://evil.example/acme/web.git"));
        assert!(!ours("https://github.com.evil.example/acme/web"));
        assert!(check_origin(&request, BASE, &[]).is_err());
        // One good URL does not excuse another on the same remote.
        let both = [
            "https://github.com/acme/web".to_owned(),
            "https://evil.example/acme/web".to_owned(),
        ];
        assert!(check_origin(&request, BASE, &both).is_err());
    }

    #[test]
    fn what_git_says_is_turned_into_what_to_do_next() {
        let said = |text: &str| problem(text, "acme/web").unwrap_or_default();
        assert!(said("remote: Repository not found.").contains("not found"));
        assert!(said("fatal: Authentication failed for").contains("refused the App's token"));
        assert!(said(" ! [rejected] main -> main (fetch first)").contains("rejected"));
        assert!(problem("something else", "acme/web").is_none());
    }
}
