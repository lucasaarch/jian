//! The plugin API on its own: who reaches an account, what a tool is called, and which doors a
//! plugin's context opens.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, AgentId, HostError, HttpRequest,
    HttpResponse, Permission, Plugin, PluginError, PluginHost, PluginRegistry, Scope,
    ScopedAccount, Secret, ToolDef, ToolError,
};
use serde_json::{Value, json};

/// A plugin with one tool that reads and one that writes, and only the secret permission.
struct Probe;

impl Plugin for Probe {
    fn id(&self) -> &'static str {
        "probe"
    }

    fn name(&self) -> &'static str {
        "Probe"
    }

    fn kinds(&self) -> &'static [&'static str] {
        &["token"]
    }

    fn permissions(&self) -> &'static [Permission] {
        &[Permission::Secret]
    }

    fn tools(&self, _account: &AccountRef) -> Vec<ToolDef> {
        vec![
            ToolDef {
                name: "look",
                description: "reads".to_owned(),
                input_schema: json!({}),
                read_only: true,
            },
            ToolDef {
                name: "change",
                description: "writes".to_owned(),
                input_schema: json!({}),
                read_only: false,
            },
        ]
    }

    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        tool: &'a str,
        _input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            match tool {
                "http" => {
                    ctx.http(HttpRequest {
                        method: "GET".to_owned(),
                        url: "http://example.invalid/".to_owned(),
                        headers: Vec::new(),
                        body: None,
                    })
                    .await?;
                    Ok(String::new())
                }
                "emit" => {
                    ctx.emit(AgentEvent {
                        kind: "x".to_owned(),
                        payload: json!({}),
                        key: None,
                    })
                    .await?;
                    Ok(String::new())
                }
                _ => Ok(ctx.secret().await?.expose().to_owned()),
            }
        })
    }
}

/// A host that answers with one secret and records what it was asked.
#[derive(Default)]
struct FakeHost {
    asked: Mutex<Vec<String>>,
}

impl PluginHost for FakeHost {
    fn secret<'a>(
        &'a self,
        account: &'a AccountId,
    ) -> BoxFuture<'a, Result<Option<Secret>, HostError>> {
        Box::pin(async move {
            self.asked.lock().unwrap().push(format!("secret {account}"));
            Ok(Some(Secret::new("hunter2")))
        })
    }

    fn http(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HostError>> {
        Box::pin(async move {
            self.asked.lock().unwrap().push("http".to_owned());
            Err(HostError::Failed("no network in a test".to_owned()))
        })
    }

    fn emit<'a>(
        &'a self,
        account: &'a AccountId,
        _event: AgentEvent,
    ) -> BoxFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            self.asked.lock().unwrap().push(format!("emit {account}"));
            Ok(())
        })
    }
}

fn account(id: &str, plugin: &str, name: &str, scope: Scope) -> ScopedAccount {
    ScopedAccount {
        account: AccountRef {
            id: AccountId::new(id),
            plugin: plugin.to_owned(),
            kind: "token".to_owned(),
            name: name.to_owned(),
            config: json!({}),
        },
        scope,
    }
}

fn registry() -> PluginRegistry {
    PluginRegistry::new().with(Arc::new(Probe))
}

fn names(tools: &[jian_plugin_api::ResolvedTool]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name.as_str()).collect()
}

#[test]
fn a_shared_account_gives_its_tools_to_every_agent() {
    let accounts = [account("a1", "probe", "Docs", Scope::Shared)];
    for agent in ["a", "b", "c"] {
        let tools = registry().resolve(&AgentId::new(agent), &accounts);
        assert_eq!(names(&tools), ["probe__docs__look", "probe__docs__change"]);
    }
}

#[test]
fn an_account_scoped_to_agents_gives_tools_only_to_them() {
    let accounts = [account(
        "a1",
        "probe",
        "Docs",
        Scope::Agents(vec![AgentId::new("a")]),
    )];
    assert_eq!(registry().resolve(&AgentId::new("a"), &accounts).len(), 2);
    // Not in the list, under any name.
    assert!(registry().resolve(&AgentId::new("b"), &accounts).is_empty());
}

#[test]
fn an_unknown_plugin_or_kind_gives_nothing() {
    let mut other_kind = account("a2", "probe", "Docs", Scope::Shared);
    other_kind.account.kind = "oauth".to_owned();
    let accounts = [
        account("a1", "not-carried", "Docs", Scope::Shared),
        other_kind,
    ];
    assert!(registry().resolve(&AgentId::new("a"), &accounts).is_empty());
}

#[test]
fn two_accounts_of_a_plugin_give_tools_that_do_not_collide() {
    let accounts = [
        account("a1", "probe", "Work", Scope::Shared),
        account("a2", "probe", "work!", Scope::Shared),
        account("a3", "probe", "  ", Scope::Shared),
    ];
    let tools = registry().resolve(&AgentId::new("a"), &accounts);
    assert_eq!(
        names(&tools),
        [
            "probe__work__look",
            "probe__work__change",
            "probe__work_2__look",
            "probe__work_2__change",
            "probe__account__look",
            "probe__account__change",
        ]
    );
    assert!(tools.iter().all(|t| t.name.len() <= 64));
    assert_eq!(tools[2].account.id.as_str(), "a2");
}

#[test]
fn a_long_account_name_is_cut_so_the_tool_name_fits() {
    let accounts = [account("a1", "probe", &"x".repeat(200), Scope::Shared)];
    let tools = registry().resolve(&AgentId::new("a"), &accounts);
    assert!(tools.iter().all(|t| t.name.len() <= 64));
    assert!(tools[0].name.ends_with("__look"));
}

#[test]
fn the_first_plugin_to_claim_an_id_keeps_it() {
    struct Impostor;
    impl Plugin for Impostor {
        fn id(&self) -> &'static str {
            "probe"
        }
        fn name(&self) -> &'static str {
            "Impostor"
        }
        fn kinds(&self) -> &'static [&'static str] {
            &["token"]
        }
        fn permissions(&self) -> &'static [Permission] {
            &[]
        }
        fn tools(&self, _: &AccountRef) -> Vec<ToolDef> {
            Vec::new()
        }
        fn call<'a>(
            &'a self,
            _: &'a AccountContext<'a>,
            _: &'a str,
            _: &'a Value,
        ) -> BoxFuture<'a, Result<String, ToolError>> {
            Box::pin(async { Ok(String::new()) })
        }
    }
    let registry = registry().with(Arc::new(Impostor));
    assert_eq!(registry.get("probe").map(|p| p.name()), Some("Probe"));
    assert_eq!(registry.plugins().count(), 1);
}

#[tokio::test]
async fn a_context_opens_only_the_doors_the_plugin_declared() {
    let host = FakeHost::default();
    let scoped = account("a1", "probe", "Docs", Scope::Shared);
    let ctx = AccountContext::new(&host, &scoped.account, Probe.permissions());

    // Declared: the secret of this account, and only this one.
    assert_eq!(ctx.secret().await.unwrap().expose(), "hunter2");
    assert_eq!(*host.asked.lock().unwrap(), ["secret a1"]);

    // Not declared: refused before the host hears of it.
    assert!(matches!(
        ctx.http(HttpRequest {
            method: "GET".to_owned(),
            url: "http://example.invalid/".to_owned(),
            headers: Vec::new(),
            body: None,
        })
        .await,
        Err(PluginError::NotPermitted(Permission::Http))
    ));
    assert!(matches!(
        ctx.emit(AgentEvent {
            kind: "x".to_owned(),
            payload: json!({}),
            key: None,
        })
        .await,
        Err(PluginError::NotPermitted(Permission::Events))
    ));
    assert_eq!(host.asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_refusal_reads_as_the_tools_failure() {
    let host = FakeHost::default();
    let scoped = account("a1", "probe", "Docs", Scope::Shared);
    let ctx = AccountContext::new(&host, &scoped.account, Probe.permissions());
    let error = Probe.call(&ctx, "http", &json!({})).await.unwrap_err();
    assert!(error.to_string().contains("Http"), "{error}");
}

#[test]
fn a_secret_never_prints() {
    let secret = Secret::new("hunter2");
    assert!(!format!("{secret:?}").contains("hunter2"));
}
