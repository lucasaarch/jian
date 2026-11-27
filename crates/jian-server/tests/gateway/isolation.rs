//! Tenant A against tenant B through the gateway: every route, every client request, every topic
//! and the worker socket, run from both sides on the other's data. Fixture: `jian-testkit`.
//!
//! The rule is that anything new on the gateway gets a test here. The first test makes that hard
//! to forget: it fails, saying what to add, when a route, a client request, a topic or a worker
//! message exists that this file does not account for.

use std::time::Duration;

use futures_util::SinkExt;
use jian_protocol::auth::{InviteCreated, MembersPage};
use jian_protocol::client::{
    ClientRequest, ClientResponse, DeltaPayload, ErrorCode, Resume, Topic,
};
use jian_protocol::machine::{GatewayMessage, TaskResult, WorkerMessage};
use jian_server::{DispatchError, ROUTES};
use jian_testkit::TwoTenants;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::accounts::open_settings;
use super::shell;
use super::support::{Client, Gateway, RawWorker, http_get, http_post};

/// Not a fixed wait for something to happen: how long to watch for something that must not.
const QUIET: Duration = Duration::from_millis(300);

/// This file, to check that a name in a table below is a test that exists.
const THIS_FILE: &str = include_str!("isolation.rs");
/// The invitation tests are in their own file, and the isolation one is among them.
const ARTIFACTS_FILE: &str = include_str!("artifacts.rs");
const SHARING_FILE: &str = include_str!("artifact_sharing.rs");
const EXPORT_FILE: &str = include_str!("artifact_export.rs");
const CODEX_FILE: &str = include_str!("codex.rs");
const CONNECTORS_FILE: &str = include_str!("connectors.rs");
const INVITES_FILE: &str = include_str!("invites.rs");
const PROVIDERS_FILE: &str = include_str!("providers.rs");
const MEMORIES_FILE: &str = include_str!("memories.rs");
const PROJECTS_FILE: &str = include_str!("projects.rs");
const RUNS_FILE: &str = include_str!("runs.rs");
const MACHINES_FILE: &str = include_str!("machines.rs");
const SCHEDULES_FILE: &str = include_str!("schedules.rs");
const WAKE_FILE: &str = include_str!("wake.rs");
const SIGN_IN_FILE: &str = include_str!("sign_in.rs");
const SKILLS_FILE: &str = include_str!("skills.rs");
const THREADS_FILE: &str = include_str!("threads.rs");
const USAGE_FILE: &str = include_str!("usage.rs");
const MCP_FILE: &str = include_str!("mcp_servers.rs");

async fn start() -> (Gateway, TwoTenants) {
    super::accounts::start(open_settings()).await
}

fn is_a_test_here(name: &str) -> bool {
    let declared = format!("async fn {name}(");
    THIS_FILE.contains(&declared)
        || ARTIFACTS_FILE.contains(&declared)
        || SHARING_FILE.contains(&declared)
        || EXPORT_FILE.contains(&declared)
        || CODEX_FILE.contains(&declared)
        || CONNECTORS_FILE.contains(&declared)
        || INVITES_FILE.contains(&declared)
        || PROVIDERS_FILE.contains(&declared)
        || MEMORIES_FILE.contains(&declared)
        || PROJECTS_FILE.contains(&declared)
        || RUNS_FILE.contains(&declared)
        || MACHINES_FILE.contains(&declared)
        || SCHEDULES_FILE.contains(&declared)
        || WAKE_FILE.contains(&declared)
        || SIGN_IN_FILE.contains(&declared)
        || SKILLS_FILE.contains(&declared)
        || USAGE_FILE.contains(&declared)
        || THREADS_FILE.contains(&declared)
        || MCP_FILE.contains(&declared)
}

/// Every route the router serves, and the test here that shows tenant B cannot use it on A's
/// data. Keyed by method and path; `jian_server::ROUTES` is the list it must match.
const ROUTE_TESTS: &[(&str, &str)] = &[
    ("GET /health", "health_says_nothing_about_any_tenant"),
    ("GET /v1/me", "a_token_names_only_its_own_tenant_over_http"),
    ("POST /v1/auth/login", USERS_TEST),
    ("POST /v1/auth/logout", USERS_TEST),
    ("POST /v1/auth/password", USERS_TEST),
    ("POST /v1/auth/invite/accept", USERS_TEST),
    ("POST /v1/auth/github/start", GITHUB_TEST),
    ("POST /v1/auth/github/callback", GITHUB_TEST),
    ("GET /v1/auth/github", GITHUB_TEST),
    ("DELETE /v1/auth/github", GITHUB_TEST),
    ("POST /v1/auth/github/link", GITHUB_TEST),
    ("POST /v1/auth/github/link/complete", GITHUB_TEST),
    ("POST /v1/auth/magic-link", MAGIC_LINK_TEST),
    ("POST /v1/auth/magic-link/redeem", MAGIC_LINK_TEST),
    ("GET /v1/members", USERS_TEST),
    ("POST /v1/members", USERS_TEST),
    ("POST /v1/members/{account_id}/disable", USERS_TEST),
    ("POST /v1/members/{account_id}/reset-password", USERS_TEST),
    ("GET /v1/invites", USERS_TEST),
    ("POST /v1/invites", USERS_TEST),
    ("POST /v1/invites/{id}/revoke", USERS_TEST),
    ("POST /v1/invites/{id}/link", INVITES_TEST),
    ("POST /v1/invites/{id}/resend", INVITES_TEST),
    ("GET /v1/settings/mail", INVITES_TEST),
    ("PUT /v1/settings/mail", INVITES_TEST),
    ("DELETE /v1/settings/mail", INVITES_TEST),
    ("GET /v1/providers", PROVIDERS_TEST),
    ("POST /v1/providers", PROVIDERS_TEST),
    ("POST /v1/providers/{id}/activate", PROVIDERS_TEST),
    ("POST /v1/providers/{id}/revoke", PROVIDERS_TEST),
    ("GET /v1/providers/{id}/usage", PROVIDERS_TEST),
    ("GET /v1/providers/models", PROVIDERS_TEST),
    ("POST /v1/providers/codex/start", CODEX_TEST),
    ("POST /v1/providers/codex/complete", CODEX_TEST),
    ("GET /v1/agents", THREADS_TEST),
    ("POST /v1/agents", THREADS_TEST),
    ("GET /v1/agents/{id}", THREADS_TEST),
    ("PATCH /v1/agents/{id}", THREADS_TEST),
    ("POST /v1/agents/{id}/archive", THREADS_TEST),
    ("GET /v1/agents/{id}/threads", THREADS_TEST),
    ("GET /v1/agents/{id}/memories", MEMORIES_TEST),
    ("GET /v1/agents/{id}/memories/{key}", MEMORIES_TEST),
    ("PUT /v1/agents/{id}/memories/{key}", MEMORIES_TEST),
    ("DELETE /v1/agents/{id}/memories/{key}", MEMORIES_TEST),
    ("GET /v1/connector-accounts", CONNECTORS_TEST),
    ("GET /v1/connector-accounts/{id}", CONNECTORS_TEST),
    ("PATCH /v1/connector-accounts/{id}", CONNECTORS_TEST),
    ("DELETE /v1/connector-accounts/{id}", CONNECTORS_TEST),
    ("POST /v1/mcp-servers", MCP_CREATE_TEST),
    ("POST /v1/mcp-servers/{id}/login", MCP_LOGIN_TEST),
    ("POST /v1/mcp-servers/{id}/login/finish", MCP_LOGIN_TEST),
    ("GET /v1/skills", SKILLS_TEST),
    ("POST /v1/skills", SKILLS_TEST),
    ("POST /v1/skills/import", SKILLS_TEST),
    ("GET /v1/skills/{name}", SKILLS_TEST),
    ("PUT /v1/skills/{name}", SKILLS_TEST),
    ("DELETE /v1/skills/{name}", SKILLS_TEST),
    ("GET /v1/skills/{name}/versions", SKILLS_TEST),
    ("GET /v1/agents/{id}/machine", AGENT_MACHINE_TEST),
    ("PUT /v1/agents/{id}/machine", AGENT_MACHINE_TEST),
    ("GET /v1/agents/{id}/model", AGENT_MODEL_TEST),
    ("PUT /v1/agents/{id}/model", AGENT_MODEL_TEST),
    ("POST /v1/agents/{id}/events", WAKE_TEST),
    ("GET /v1/agents/{id}/proactivity", WAKE_TEST),
    ("PUT /v1/agents/{id}/proactivity", WAKE_TEST),
    ("GET /v1/agents/{id}/skills", SKILLS_TEST),
    ("PUT /v1/agents/{id}/skills/{name}", SKILLS_TEST),
    (
        "PUT /v1/agents/{id}/memories/{key}/links/{other}",
        MEMORIES_TEST,
    ),
    (
        "DELETE /v1/agents/{id}/memories/{key}/links/{other}",
        MEMORIES_TEST,
    ),
    ("GET /v1/artifacts", ARTIFACTS_TEST),
    ("POST /v1/artifacts", ARTIFACTS_TEST),
    ("GET /v1/artifacts/{id}", ARTIFACTS_TEST),
    ("PATCH /v1/artifacts/{id}", ARTIFACTS_TEST),
    ("DELETE /v1/artifacts/{id}", ARTIFACTS_TEST),
    ("GET /v1/artifacts/{id}/versions", ARTIFACTS_TEST),
    ("PUT /v1/artifacts/{id}/content", ARTIFACTS_TEST),
    ("POST /v1/artifacts/{id}/edits", ARTIFACTS_TEST),
    ("POST /v1/artifacts/{id}/duplicate", ARTIFACTS_TEST),
    ("GET /v1/artifacts/{id}/share", SHARING_TEST),
    ("PUT /v1/artifacts/{id}/visibility", SHARING_TEST),
    ("PUT /v1/artifacts/{id}/password", SHARING_TEST),
    ("POST /v1/artifacts/{id}/link", SHARING_TEST),
    ("GET /v1/artifacts/{id}/export", EXPORT_TEST),
    ("GET /v1/public/artifacts/{token}", SHARING_TEST),
    ("GET /v1/public/artifacts/{token}/export", EXPORT_TEST),
    ("POST /v1/public/artifacts/{token}/unlock", SHARING_TEST),
    ("GET /v1/artifact-folders", ARTIFACTS_TEST),
    ("POST /v1/artifact-folders", ARTIFACTS_TEST),
    ("PATCH /v1/artifact-folders/{id}", ARTIFACTS_TEST),
    ("DELETE /v1/artifact-folders/{id}", ARTIFACTS_TEST),
    ("GET /v1/projects", MEMORIES_TEST),
    ("POST /v1/projects", MEMORIES_TEST),
    ("GET /v1/projects/{id}", MEMORIES_TEST),
    ("PATCH /v1/projects/{id}", MEMORIES_TEST),
    ("DELETE /v1/projects/{id}", MEMORIES_TEST),
    ("GET /v1/projects/{id}/threads", PROJECTS_TEST),
    ("GET /v1/projects/{id}/repositories", PROJECTS_TEST),
    ("POST /v1/projects/{id}/repositories", PROJECTS_TEST),
    (
        "DELETE /v1/projects/{id}/repositories/{repository_id}",
        PROJECTS_TEST,
    ),
    ("GET /v1/projects/{id}/files", PROJECTS_TEST),
    ("POST /v1/projects/{id}/files", PROJECTS_TEST),
    ("GET /v1/projects/{id}/files/{file_id}", PROJECTS_TEST),
    ("DELETE /v1/projects/{id}/files/{file_id}", PROJECTS_TEST),
    ("GET /v1/threads/{id}/project", MEMORIES_TEST),
    ("PUT /v1/threads/{id}/project", MEMORIES_TEST),
    ("GET /v1/agents/{id}/schedules", SCHEDULES_TEST),
    ("POST /v1/agents/{id}/schedules", SCHEDULES_TEST),
    ("GET /v1/agents/{id}/schedules/{scheduleId}", SCHEDULES_TEST),
    (
        "PATCH /v1/agents/{id}/schedules/{scheduleId}",
        SCHEDULES_TEST,
    ),
    (
        "DELETE /v1/agents/{id}/schedules/{scheduleId}",
        SCHEDULES_TEST,
    ),
    ("GET /v1/agents/{id}/inbox", SCHEDULES_TEST),
    ("GET /v1/usage", USAGE_TEST),
    ("GET /v1/grants", THREADS_TEST),
    ("POST /v1/grants", THREADS_TEST),
    ("POST /v1/grants/revoke", THREADS_TEST),
    ("GET /v1/threads", THREADS_TEST),
    ("POST /v1/threads", THREADS_TEST),
    ("GET /v1/threads/{id}", THREADS_TEST),
    ("GET /v1/threads/{id}/participants", THREADS_TEST),
    ("POST /v1/threads/{id}/participants", THREADS_TEST),
    (
        "DELETE /v1/threads/{id}/participants/{kind}/{who}",
        THREADS_TEST,
    ),
    ("GET /v1/threads/{id}/messages", THREADS_TEST),
    ("POST /v1/threads/{id}/messages", THREADS_TEST),
    ("PATCH /v1/threads/{id}/messages/{message_id}", THREADS_TEST),
    (
        "DELETE /v1/threads/{id}/messages/{message_id}",
        THREADS_TEST,
    ),
    ("GET /v1/threads/{id}/runs", RUNS_TEST),
    ("POST /v1/threads/{id}/runs", RUNS_TEST),
    ("POST /v1/threads/{id}/runs/{run_id}/stop", RUNS_TEST),
    (
        "GET /v1/threads/{id}/agents/{agent_id}/objective",
        OBJECTIVE_TEST,
    ),
    (
        "PUT /v1/threads/{id}/agents/{agent_id}/objective",
        OBJECTIVE_TEST,
    ),
    (
        "DELETE /v1/threads/{id}/agents/{agent_id}/objective",
        OBJECTIVE_TEST,
    ),
    ("GET /v1/threads/{id}/subagents", SUBAGENTS_TEST),
    (
        "POST /v1/threads/{id}/subagents/{child_id}/stop",
        SUBAGENTS_TEST,
    ),
    (
        "GET /v1/machines/connect",
        "a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks",
    ),
    (
        "GET /v1/ws",
        "client_requests_aimed_at_the_other_tenant_find_nothing",
    ),
];

/// The test that shows tenant B reaches no mail account and cannot replace or resend the token of
/// tenant A's invitation, and that A's job sends with A's own account.
const INVITES_TEST: &str =
    "an_invitation_is_sent_with_its_own_workspaces_mail_account_and_nobody_elses";

/// The test that shows tenant B reaches no artifact or artifact folder of tenant A.
const ARTIFACTS_TEST: &str = "artifacts_and_folders_of_the_other_tenant_are_out_of_reach";

/// The test that shows tenant B can neither share, protect nor open a link of tenant A's artifact,
/// and that a link opens only the artifact of its own workspace.
const SHARING_TEST: &str = "links_and_passwords_of_artifacts_stay_inside_their_own_tenant";

/// The test that shows tenant B can download no artifact of tenant A, by id or by link.
const EXPORT_TEST: &str = "exports_of_artifacts_stay_inside_their_own_tenant";

/// The test that shows tenant B reaches no memory, project or thread-project link of tenant A.
const MEMORIES_TEST: &str = "memories_and_projects_of_the_other_tenant_are_out_of_reach";

/// The test that shows tenant B reaches no skill of tenant A's library, nor its agents' skills.
/// The test that shows tenant B reads and changes no model of tenant A's agents.
/// The test that shows tenant B reads and changes no machine choice of tenant A's agents, and
/// cannot point one at its own machine.
const AGENT_MACHINE_TEST: &str =
    "an_agents_machine_is_chosen_by_its_manager_and_is_out_of_reach_of_another_tenant";
const AGENT_MODEL_TEST: &str = "an_agents_model_is_out_of_reach_of_another_tenant";
const CONNECTORS_TEST: &str = "connector_accounts_of_the_other_tenant_are_out_of_reach";
const SKILLS_TEST: &str = "skills_of_the_other_tenant_are_out_of_reach";
/// The test that shows a server tenant A adds is not listed for tenant B.
const MCP_CREATE_TEST: &str = "a_server_that_answers_is_kept_renamed_and_never_shows_its_headers";
/// The test that shows tenant B gets a 404 when it tries to sign in to tenant A's server.
const MCP_LOGIN_TEST: &str =
    "an_oauth_server_is_kept_unsigned_then_signed_in_with_the_state_it_was_given";

/// The test that shows tenant B reaches no file or repository of tenant A's projects.
const PROJECTS_TEST: &str =
    "the_files_and_repositories_of_the_other_tenants_projects_are_out_of_reach";

/// The test that shows tenant B reaches no schedule or inbox event of tenant A.
const SCHEDULES_TEST: &str =
    "a_schedule_fires_into_its_agents_inbox_once_and_never_into_another_tenants";

/// The test that shows a workspace's usage and limits are its own and bind only it.
const USAGE_TEST: &str = "usage_is_each_workspaces_own_and_a_workspace_over_its_limit_is_refused";

/// The test that shows tenant B reaches no agent, thread or message of tenant A.
const RUNS_TEST: &str =
    "a_thread_has_one_active_run_per_agent_and_only_its_members_start_and_stop_it";
/// The test that shows tenant B and a member outside the thread reach no objective of tenant A.
const OBJECTIVE_TEST: &str = "an_objective_is_seen_by_its_thread_and_set_only_by_its_members";
/// The test that shows tenant B and a member outside the thread reach no subagent of tenant A.
const SUBAGENTS_TEST: &str = "a_threads_subagents_are_seen_by_it_and_stopped_only_by_its_members";
const THREADS_TEST: &str = "agents_threads_and_messages_of_the_other_tenant_are_out_of_reach";

/// The test that shows tenant B reaches no model provider account of tenant A, and no key.
const PROVIDERS_TEST: &str = "provider_accounts_of_the_other_tenant_are_out_of_reach";

/// The test that shows a ChatGPT sign-in of tenant A cannot be finished by tenant B.
const CODEX_TEST: &str = "a_chatgpt_sign_in_belongs_to_the_workspace_that_started_it";

/// The test that shows tenant B reaches no member, session or invitation of tenant A.
const USERS_TEST: &str = "users_and_sessions_of_the_other_tenant_are_out_of_reach";

/// The test that shows a GitHub sign-in opens no workspace its account is not a member of, and a
/// state belongs to the account that began it.
const GITHUB_TEST: &str = "github_never_lets_in_a_stranger_or_another_workspace";

/// The test that shows a sign-in link opens only the workspace and member it was made for.
const MAGIC_LINK_TEST: &str = "a_magic_link_opens_only_the_workspace_and_member_it_was_made_for";

/// Which test here covers a client request. No wildcard arm: a new `ClientRequest` does not
/// compile until it is listed, and the listing has to name a test that exists (a sample of it
/// goes in `every_client_request_has_an_isolation_test`).
fn request_test(request: &ClientRequest) -> &'static str {
    match request {
        ClientRequest::ListMachines { .. }
        | ClientRequest::IssueMachine { .. }
        | ClientRequest::RotateMachine { .. }
        | ClientRequest::RevokeMachine { .. }
        | ClientRequest::IssueDevice { .. }
        | ClientRequest::RotateDevice { .. }
        | ClientRequest::RevokeDevice { .. } => {
            "client_requests_aimed_at_the_other_tenant_find_nothing"
        }
        ClientRequest::Subscribe { .. } | ClientRequest::Unsubscribe { .. } => {
            "a_delta_reaches_only_its_own_tenants_subscribers"
        }
    }
}

/// The same for the topics a client can follow.
fn topic_test(topic: Topic) -> &'static str {
    match topic {
        Topic::Machines => "a_delta_reaches_only_its_own_tenants_subscribers",
        Topic::Threads => "a_member_hears_only_the_threads_they_are_in",
        Topic::Projects => "only_those_who_see_a_project_hear_of_it",
        Topic::Artifacts => "only_those_who_see_an_artifact_hear_of_it",
        Topic::Skills => "a_change_to_the_library_is_heard_by_every_member",
    }
}

/// The same for what a worker says. Only `Result` carries something another tenant could aim at
/// (a task id); the others are read and ignored by the gateway today, so a message that starts to
/// do something with an id of its own needs its entry here when it does.
fn worker_message_test(message: &WorkerMessage) -> &'static str {
    match message {
        WorkerMessage::Hello(_) | WorkerMessage::Result(_) => {
            "a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks"
        }
        WorkerMessage::Output(_)
        | WorkerMessage::ForwardState(_)
        | WorkerMessage::ChannelOpen { .. }
        | WorkerMessage::ChannelClose { .. }
        | WorkerMessage::UiState { .. }
        | WorkerMessage::Ping { .. }
        | WorkerMessage::Pong { .. } => "ignored by the gateway: nothing to cross",
    }
}

#[tokio::test]
async fn every_route_request_and_topic_has_an_isolation_test() {
    // The list of routes is kept by hand next to the router (axum cannot list them), so this
    // pins both ways: no route without a test here, no test here for a route that is gone.
    for route in ROUTES {
        assert!(
            ROUTE_TESTS.iter().any(|(key, _)| route.starts_with(key)),
            "the route `{route}` has no isolation test: add one in \
             crates/jian-server/tests/gateway/isolation.rs and list it in ROUTE_TESTS"
        );
    }
    let (gateway, _tenants) = start().await;
    for (key, test) in ROUTE_TESTS {
        assert!(
            ROUTES.iter().any(|route| route.starts_with(key)),
            "ROUTE_TESTS lists `{key}`, which jian_server::ROUTES does not"
        );
        assert!(is_a_test_here(test), "`{test}` is not a test in this file");
        // And the route is really served: a path ROUTES names that the router lacks is a 404.
        let path = key.split(' ').nth(1).unwrap();
        // A link that is not there is a 404 with a JSON body; a route the router lacks has none.
        let (status, body) = http_get(gateway.addr, path, None).await;
        assert!(
            status != 404 || body.contains("not_found"),
            "{key}: {status} {body}"
        );
    }

    let samples = [
        ClientRequest::ListMachines {
            cursor: None,
            limit: None,
        },
        ClientRequest::IssueMachine { name: "x".into() },
        ClientRequest::RotateMachine { id: "x".into() },
        ClientRequest::RevokeMachine { id: "x".into() },
        ClientRequest::IssueDevice { name: "x".into() },
        ClientRequest::RotateDevice { id: "x".into() },
        ClientRequest::RevokeDevice { id: "x".into() },
        ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: None,
        },
        ClientRequest::Unsubscribe {
            topic: Topic::Machines,
        },
    ];
    for request in &samples {
        let test = request_test(request);
        assert!(
            is_a_test_here(test),
            "{request:?}: `{test}` is not a test in this file"
        );
    }
    assert!(is_a_test_here(topic_test(Topic::Machines)));
    assert!(is_a_test_here(topic_test(Topic::Threads)));
    assert!(is_a_test_here(topic_test(Topic::Projects)));
    assert!(is_a_test_here(topic_test(Topic::Artifacts)));
    assert!(is_a_test_here(topic_test(Topic::Skills)));
    // Compiling this is the check: a new worker message must be listed in `worker_message_test`.
    let _: fn(&WorkerMessage) -> &'static str = worker_message_test;
    gateway.stop().await;
}

#[tokio::test]
async fn health_says_nothing_about_any_tenant() {
    let (gateway, tenants) = start().await;
    let (status, body) = http_get(gateway.addr, "/health", None).await;
    assert_eq!(status, 200);
    for side in [&tenants.a, &tenants.b] {
        assert!(!body.contains(side.id.as_str()), "{body}");
    }
    assert_eq!(body, r#"{"status":"ok","database":"up"}"#);
    gateway.stop().await;
}

#[tokio::test]
async fn a_token_names_only_its_own_tenant_over_http() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        for token in [
            &actor.owner_token,
            &actor.machine_token,
            &actor.device_token,
        ] {
            // A tenant named in the query, as a caller might try, is not read.
            let path = format!("/v1/me?tenant={}", victim.id);
            let (status, body) = http_get(addr, &path, Some(token)).await;
            assert_eq!(status, 200);
            assert!(
                body.contains(&format!(r#""tenant":"{}""#, actor.id)),
                "{body}"
            );
            assert!(!body.contains(victim.id.as_str()), "{body}");
        }
        // A token that is not the actor's, with the actor's name in the path, opens the victim
        // and nothing more.
        let (_, body) = http_get(addr, "/v1/me", Some(&victim.owner_token)).await;
        assert!(
            body.contains(&format!(r#""tenant":"{}""#, victim.id)),
            "{body}"
        );
    }
    // Revoking A's phone cuts it off and leaves B's phone alone.
    gateway
        .db
        .revoke_device(&tenants.a.ctx, &tenants.a.device_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        http_get(addr, "/v1/me", Some(&tenants.a.device_token))
            .await
            .0,
        401
    );
    assert_eq!(
        http_get(addr, "/v1/me", Some(&tenants.b.device_token))
            .await
            .0,
        200
    );
    gateway.stop().await;
}

#[tokio::test]
async fn client_requests_aimed_at_the_other_tenant_find_nothing() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        let mut owner = Client::open(addr, &actor.owner_token).await;
        let mut phone = Client::open(addr, &actor.device_token).await;

        // Lists hold the actor's machine and never the victim's, with or without a cursor.
        for cursor in [None, Some("0".to_owned())] {
            let ClientResponse::Machines(page) = owner
                .call(ClientRequest::ListMachines {
                    cursor,
                    limit: Some(100),
                })
                .await
                .unwrap()
            else {
                panic!("expected a page");
            };
            let ids: Vec<&str> = page
                .items
                .iter()
                .map(|machine| machine.id.as_str())
                .collect();
            assert_eq!(ids, [actor.machine.id.as_str()]);
        }

        // A victim's id is "no such" to the actor, word for word what an id that never existed
        // gets: nothing tells that it exists elsewhere.
        let unknown_machine = "mch_never_existed".to_owned();
        let unknown_device = "dev_never_existed".to_owned();
        for (aimed, unknown) in [
            (
                ClientRequest::RotateMachine {
                    id: victim.machine.id.clone().into(),
                },
                ClientRequest::RotateMachine {
                    id: unknown_machine.clone().into(),
                },
            ),
            (
                ClientRequest::RevokeMachine {
                    id: victim.machine.id.clone().into(),
                },
                ClientRequest::RevokeMachine {
                    id: unknown_machine.into(),
                },
            ),
            (
                ClientRequest::RotateDevice {
                    id: victim.device.id.clone(),
                },
                ClientRequest::RotateDevice {
                    id: unknown_device.clone(),
                },
            ),
            (
                ClientRequest::RevokeDevice {
                    id: victim.device.id.clone(),
                },
                ClientRequest::RevokeDevice {
                    id: unknown_device.clone(),
                },
            ),
        ] {
            let refused = owner.call(aimed.clone()).await.unwrap_err();
            assert_eq!(refused.code, ErrorCode::NotFound, "{aimed:?}");
            assert_eq!(refused, owner.call(unknown).await.unwrap_err(), "{aimed:?}");
            // A phone's token may not do these at all, and says so before it looks at the id.
            let forbidden = phone.call(aimed.clone()).await.unwrap_err();
            assert_eq!(forbidden.code, ErrorCode::Forbidden, "{aimed:?}");
        }

        // What the actor issues is the actor's: it is in its list and not in the victim's.
        let ClientResponse::MachineToken { machine, .. } = owner
            .call(ClientRequest::IssueMachine {
                name: "made by the actor".into(),
            })
            .await
            .unwrap()
        else {
            panic!("expected a token");
        };
        assert!(
            gateway
                .db
                .machine(
                    &victim.ctx,
                    &jian_store::MachineId::new(machine.id.as_str())
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            gateway
                .db
                .machine(&actor.ctx, &jian_store::MachineId::new(machine.id.as_str()))
                .await
                .unwrap()
                .is_some()
        );

        // The victim is as it was: not revoked, not rotated, its tokens still open it.
        let kept = gateway
            .db
            .machine(&victim.ctx, &victim.machine_id())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept.revoked, victim.machine.revoked);
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.machine_token))
                .await
                .0,
            200
        );
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.device_token)).await.0,
            200
        );
    }
    gateway.stop().await;
}

#[tokio::test]
async fn a_delta_reaches_only_its_own_tenants_subscribers() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        let mut watcher = Client::open(addr, &actor.owner_token).await;
        let mut owner = Client::open(addr, &victim.owner_token).await;
        let subscribe = || ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: None,
        };
        let ClientResponse::Subscribed(baseline) = watcher.call(subscribe()).await.unwrap() else {
            panic!("expected a subscription");
        };
        let ClientResponse::Subscribed(own) = owner.call(subscribe()).await.unwrap() else {
            panic!("expected a subscription");
        };
        // The victim changes things: issues a machine and brings a worker online.
        let ClientResponse::MachineToken { machine, token } = owner
            .call(ClientRequest::IssueMachine {
                name: "made by the victim".into(),
            })
            .await
            .unwrap()
        else {
            panic!("expected a token");
        };
        let worker = RawWorker::welcomed(addr, &token, &["shell"]).await;
        // The machine is issued, then comes online.
        for _ in 0..2 {
            let DeltaPayload::Machine(seen) = owner.delta().await.payload else {
                panic!("expected a machine");
            };
            assert_eq!(seen.id.as_str(), machine.id.as_str());
        }
        assert!(
            watcher.quiet(QUIET).await,
            "a delta of {} reached a subscriber of {}",
            victim.id,
            actor.id
        );
        // Going offline is a delta too; take it here, so it cannot land in the next crossing,
        // where the actor is this victim and the delta would be its own.
        drop(worker);
        owner.delta().await;

        // A client that resumes from where its own topic stood replays none of the victim's
        // deltas, which are numbered above that: topic and numbers are the tenant's own.
        let mut late = Client::open(addr, &actor.owner_token).await;
        let ClientResponse::Subscribed(subscribed) = late
            .call(ClientRequest::Subscribe {
                topic: Topic::Machines,
                resume: Some(Resume {
                    epoch: own.epoch.clone(),
                    seq: baseline.seq,
                }),
            })
            .await
            .unwrap()
        else {
            panic!("expected a subscription");
        };
        assert_eq!(subscribed.replayed, 0);
        assert!(late.quiet(QUIET).await);
        assert!(matches!(
            watcher
                .call(ClientRequest::Unsubscribe {
                    topic: Topic::Machines
                })
                .await,
            Ok(ClientResponse::Unsubscribed)
        ));
    }
    gateway.stop().await;
}

/// The worker's side of a result, sent by hand: what a worker of another tenant would do with a
/// task id it was never given.
async fn send_result(worker: &mut RawWorker, id: &str) {
    let message = WorkerMessage::Result(TaskResult::failed(id.to_owned(), "forged"));
    worker
        .socket
        .send(Message::text(serde_json::to_string(&message).unwrap()))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    let hub = gateway.state.hub.clone();
    for (actor, victim) in tenants.crossings() {
        let mut theirs = RawWorker::welcomed(addr, &victim.machine_token, &["shell"]).await;
        let mut ours = RawWorker::welcomed(addr, &actor.machine_token, &["shell"]).await;
        let never = CancellationToken::new();

        // An order for the victim's machine, in the actor's name, finds no such machine, and the
        // actor's own machine is just as unreachable in the victim's.
        for (tenant, machine) in [
            (&actor.id, victim.machine_id()),
            (&victim.id, actor.machine_id()),
        ] {
            let refused = hub
                .dispatch(
                    tenant,
                    &machine,
                    shell("true"),
                    Duration::from_secs(1),
                    &never,
                )
                .await;
            assert_eq!(refused.unwrap_err(), DispatchError::Offline);
        }

        // The victim's task goes to the victim's worker only.
        let run = tokio::spawn({
            let (hub, tenant, machine) = (hub.clone(), victim.id.clone(), victim.machine_id());
            let never = never.clone();
            async move {
                hub.dispatch(
                    &tenant,
                    &machine,
                    shell("true"),
                    Duration::from_secs(30),
                    &never,
                )
                .await
            }
        });
        let GatewayMessage::Task(task) = theirs.next().await else {
            panic!("the victim's worker was not sent its task");
        };
        assert!(
            tokio::time::timeout(QUIET, ours.next()).await.is_err(),
            "the actor's worker was sent the victim's task"
        );

        // The actor's worker answers it with the id it overheard: the gateway acknowledges it
        // and the task stays unanswered.
        send_result(&mut ours, task.id.as_str()).await;
        assert!(matches!(
            ours.next().await,
            GatewayMessage::ResultAck { .. }
        ));
        assert!(
            !run.is_finished(),
            "a result from the wrong tenant finished the task"
        );

        // The victim's own worker still can.
        let message = WorkerMessage::Result(TaskResult {
            id: task.id.clone(),
            exit_code: Some(0),
            ..TaskResult::default()
        });
        theirs
            .socket
            .send(Message::text(serde_json::to_string(&message).unwrap()))
            .await
            .unwrap();
        let result = run.await.unwrap().unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_ne!(result.stderr, "forged");
    }
    gateway.stop().await;
}

#[tokio::test]
async fn users_and_sessions_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    let empty = serde_json::json!({});
    for (actor, victim) in tenants.crossings() {
        let session = &actor.admin_session;

        // The list holds the actor's own members. Accounts are global, so the ids are what
        // tells the sides apart.
        let (status, body) = http_get(addr, "/v1/members", Some(session)).await;
        assert_eq!(status, 200, "{body}");
        let page: MembersPage = serde_json::from_str(&body).unwrap();
        let ids: Vec<&str> = page.items.iter().map(|m| m.account_id.as_str()).collect();
        // (The first crossing's accepted invitation made the second tenant a member more.)
        assert_eq!(
            ids[..2],
            [
                actor.admin.account_id.as_str(),
                actor.member.account_id.as_str()
            ]
        );
        for theirs in [&victim.admin, &victim.member] {
            assert!(!ids.contains(&theirs.account_id.as_str()));
        }

        // The victim's id is "no such member", word for word what an id that never existed gets.
        for (path, body) in [
            ("disable", empty.clone()),
            (
                "reset-password",
                serde_json::json!({ "password": "twelve chars long" }),
            ),
        ] {
            let aimed = format!("/v1/members/{}/{path}", victim.member.account_id);
            let never = format!("/v1/members/acc_never_existed/{path}");
            let refused = http_post(addr, &aimed, Some(session), &body).await;
            assert_eq!(refused.0, 404, "{path}: {}", refused.1);
            assert_eq!(refused, http_post(addr, &never, Some(session), &body).await);
        }

        // The victim is as it was: enabled, with its password and its session.
        let (_, body) = http_get(addr, "/v1/members", Some(&victim.admin_session)).await;
        let page: MembersPage = serde_json::from_str(&body).unwrap();
        let kept = page
            .items
            .iter()
            .find(|m| m.account_id == victim.member.account_id.as_str())
            .unwrap();
        assert!(!kept.disabled && !kept.must_change_password);
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.member_session))
                .await
                .0,
            200
        );

        // An invitation of the victim is not in the actor's list, and revoking it by id is
        // "no such invitation", the same as an id that never existed.
        let invited = format!("invited@{}.test", victim.id);
        let (status, body) = http_post(
            addr,
            "/v1/invites",
            Some(&victim.admin_session),
            &serde_json::json!({ "email": invited, "role": "member" }),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        let invite: InviteCreated = serde_json::from_str(&body).unwrap();
        let (_, body) = http_get(addr, "/v1/invites", Some(session)).await;
        assert!(!body.contains(&invite.invite.id), "{body}");
        let aimed = format!("/v1/invites/{}/revoke", invite.invite.id);
        let refused = http_post(addr, &aimed, Some(session), &empty).await;
        assert_eq!(refused.0, 404, "{}", refused.1);
        let never = "/v1/invites/never_existed/revoke";
        assert_eq!(refused, http_post(addr, never, Some(session), &empty).await);
        // It still opens, and for its own tenant only.
        let (status, body) = http_post(
            addr,
            "/v1/auth/invite/accept",
            None,
            &serde_json::json!({ "token": invite.token.as_deref().unwrap(), "password": "twelve chars long" }),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert!(
            body.contains(&format!(r#""tenant":"{}""#, victim.id)),
            "{body}"
        );
        let (_, body) = http_get(addr, "/v1/members", Some(session)).await;
        assert!(!body.contains(&invited), "{body}");

        // What the actor's session names is the actor's tenant, whatever the query says.
        let path = format!("/v1/me?tenant={}", victim.id);
        let (_, body) = http_get(addr, &path, Some(&actor.member_session)).await;
        assert!(
            body.contains(&format!(r#""tenant":"{}""#, actor.id)),
            "{body}"
        );
        assert!(!body.contains(victim.id.as_str()), "{body}");
    }

    // Signing in can name a workspace; one the account is not in is a wrong password, not an
    // open door.
    let (a, b) = (&tenants.a, &tenants.b);
    let credentials = |password: &str, tenant: Option<&str>| serde_json::json!({ "email": a.admin.email, "password": password, "tenant": tenant });
    let wrong = http_post(
        addr,
        "/v1/auth/login",
        None,
        &credentials("not the password at all", None),
    )
    .await;
    let aimed = http_post(
        addr,
        "/v1/auth/login",
        None,
        &credentials(jian_testkit::PASSWORD, Some(b.id.as_str())),
    )
    .await;
    assert_eq!(wrong.0, 401, "{}", wrong.1);
    assert_eq!(wrong, aimed);
    gateway.stop().await;
}

/// The test that shows tenant A's events wake no agent of tenant B, and that a webhook with
/// another workspace's token reaches nobody's box.
const WAKE_TEST: &str = "an_event_of_one_tenant_never_wakes_the_agent_of_another";
