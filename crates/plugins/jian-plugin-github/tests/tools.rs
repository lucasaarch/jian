//! The pull request and issue tools against a fake GitHub.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_plugin_api::{AccountRef, Plugin};
use jian_plugin_github::GithubPlugin;
use jian_plugin_github::account::{NewInstallation, build, owner_of};
use serde_json::{Value, json};
use support::{KEY_PKCS1, TestHost, account, context, serve};

async fn run(
    plugin: &GithubPlugin,
    host: &TestHost,
    account: &AccountRef,
    tool: &str,
    input: Value,
) -> Result<String, String> {
    let ctx = context(host, account);
    plugin.call(&ctx, tool, &input).await.map_err(|e| e.0)
}

#[tokio::test]
async fn a_pull_request_is_read_whole_with_review_text_checks_and_mergeability() {
    let (fake, base) = serve().await;
    fake.route(
        "GET /repos/acme/widgets/pulls/7",
        200,
        json!({
            "number": 7, "title": "Fix it", "state": "open", "draft": false, "mergeable": false,
            "mergeable_state": "dirty", "head": { "ref": "fix", "sha": "abc123" },
            "base": { "ref": "main", "sha": "def" }, "user": { "login": "dev" }, "body": "why"
        }),
    );
    fake.route("GET /repos/acme/widgets/pulls/7/reviews", 200, json!([
        { "user": { "login": "rev" }, "state": "CHANGES_REQUESTED", "body": "please rename x", "commit_id": "abc123" }
    ]));
    fake.route(
        "GET /repos/acme/widgets/issues/7/comments",
        200,
        json!([
            { "user": { "login": "dev" }, "body": "ping" }
        ]),
    );
    fake.route(
        "GET /repos/acme/widgets/pulls/7/comments",
        200,
        json!([
            { "user": { "login": "rev" }, "path": "a.rs", "line": 3, "body": "nit" }
        ]),
    );
    fake.route(
        "GET /repos/acme/widgets/commits/abc123/check-runs",
        200,
        json!({
            "check_runs": [{ "name": "ci", "status": "completed", "conclusion": "failure" }]
        }),
    );
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let out = run(
        &GithubPlugin,
        &host,
        &account,
        "get_pull",
        json!({ "repo": "acme/widgets", "number": 7 }),
    )
    .await
    .unwrap();
    let got: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(got["pull"]["mergeable"], false);
    assert_eq!(got["pull"]["mergeable_state"], "dirty");
    assert_eq!(got["reviews"][0]["body"], "please rename x");
    assert_eq!(got["review_comments"][0]["path"], "a.rs");
    assert_eq!(got["checks"][0]["conclusion"], "failure");
}

#[tokio::test]
async fn a_merge_that_github_refuses_says_githubs_reason() {
    let (fake, base) = serve().await;
    fake.route(
        "PUT /repos/acme/widgets/pulls/7/merge",
        405,
        json!({
            "message": "Required status check \"ci\" is expected."
        }),
    );
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let why = run(
        &GithubPlugin,
        &host,
        &account,
        "merge_pull",
        json!({ "repo": "acme/widgets", "number": 7 }),
    )
    .await
    .unwrap_err();
    assert!(why.contains("405"), "{why}");
    assert!(why.contains("Required status check"), "{why}");

    fake.route(
        "PUT /repos/acme/widgets/pulls/7/merge",
        200,
        json!({ "merged": true, "sha": "f00" }),
    );
    let done = run(
        &GithubPlugin,
        &host,
        &account,
        "merge_pull",
        json!({ "repo": "acme/widgets", "number": 7, "method": "squash" }),
    )
    .await
    .unwrap();
    assert!(done.contains("merged"), "{done}");
    let sent = &fake.requests("PUT", "/repos/acme/widgets/pulls/7/merge")[1];
    assert_eq!(sent.body["merge_method"], "squash");
}

#[tokio::test]
async fn updating_a_branch_never_reads_as_merged() {
    let (fake, base) = serve().await;
    fake.route(
        "PUT /repos/acme/widgets/pulls/7/update-branch",
        202,
        json!({ "message": "Updating pull request branch." }),
    );
    fake.route(
        "GET /repos/acme/widgets/pulls/7",
        200,
        json!({ "state": "open", "merged": false }),
    );
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let out = run(
        &GithubPlugin,
        &host,
        &account,
        "update_pull_branch",
        json!({ "repo": "acme/widgets", "number": 7 }),
    )
    .await
    .unwrap();
    assert!(out.contains("not merged"), "{out}");
}

#[tokio::test]
async fn an_issue_is_created_with_no_parent_and_listed_without_pull_requests() {
    let (fake, base) = serve().await;
    fake.route(
        "POST /repos/acme/widgets/issues",
        201,
        json!({ "number": 5, "title": "Bug", "state": "open" }),
    );
    fake.route(
        "GET /repos/acme/widgets/issues",
        200,
        json!([
            { "number": 1, "title": "real", "state": "open" },
            { "number": 2, "title": "a pr", "state": "open", "pull_request": {} }
        ]),
    );
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    run(
        &GithubPlugin,
        &host,
        &account,
        "create_issue",
        json!({
            "repo": "acme/widgets", "title": "Bug", "body": "steps", "labels": ["bug"],
            "assignees": ["dev"], "parent": 3
        }),
    )
    .await
    .unwrap();
    let sent = &fake.requests("POST", "/repos/acme/widgets/issues")[0].body;
    let mut keys: Vec<&String> = sent.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["assignees", "body", "labels", "title"]);

    let listed = run(
        &GithubPlugin,
        &host,
        &account,
        "list_issues",
        json!({
            "repo": "acme/widgets", "labels": ["bug", "p1"], "assignee": "dev", "page": 2
        }),
    )
    .await
    .unwrap();
    assert!(
        listed.contains("real") && !listed.contains("a pr"),
        "{listed}"
    );
    let query = &fake.requests("GET", "/repos/acme/widgets/issues")[0].query;
    for part in ["labels=bug%2Cp1", "assignee=dev", "page=2", "state=open"] {
        assert!(query.contains(part), "{query}");
    }
}

#[tokio::test]
async fn a_search_by_words_stays_on_the_accounts_owner() {
    let (fake, base) = serve().await;
    fake.route(
        "GET /search/issues",
        200,
        json!({ "items": [{ "number": 4, "title": "crash" }] }),
    );
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    run(
        &GithubPlugin,
        &host,
        &account,
        "list_issues",
        json!({ "query": "crash", "state": "closed" }),
    )
    .await
    .unwrap();
    let query = &fake.requests("GET", "/search/issues")[0].query;
    assert!(
        query.contains("user%3Aacme") && query.contains("is%3Aissue") && query.contains("crash"),
        "{query}"
    );
}

#[tokio::test]
async fn a_repo_that_could_change_the_path_is_refused_before_any_request() {
    let (fake, base) = serve().await;
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    for repo in [
        "acme/../orgs",
        "acme/widgets/issues",
        "acme",
        "a b/c",
        "acme/%2e%2e",
    ] {
        let why = run(
            &GithubPlugin,
            &host,
            &account,
            "list_pulls",
            json!({ "repo": repo }),
        )
        .await
        .unwrap_err();
        assert!(why.contains("owner/name"), "{repo}: {why}");
    }
    assert!(fake.seen.lock().unwrap().is_empty());
}

#[test]
fn the_installation_on_the_repos_owner_is_the_one_chosen() {
    let accounts = vec![
        account("one", "acme", "http://x"),
        account("two", "Octo-Org", "http://x"),
    ];
    assert_eq!(owner_of(&accounts, "octo-org/app").unwrap().name, "two");
    assert_eq!(owner_of(&accounts, "acme/app").unwrap().name, "one");
    assert!(owner_of(&accounts, "stranger/app").is_none());
    assert!(owner_of(&accounts, "noslash").is_none());
}

#[test]
fn a_new_account_checks_its_key_and_keeps_it_out_of_the_settings() {
    let ok = build(&NewInstallation {
        app_id: "12345".to_owned(),
        installation_id: 9,
        login: "acme".to_owned(),
        private_key: KEY_PKCS1.to_owned(),
        webhook_secret: Some("whsec-synthetic".to_owned()),
        api_base: Some("http://127.0.0.1:1/".to_owned()),
        review_agent: None,
    })
    .unwrap();
    let settings = ok.0.to_string();
    assert!(
        !settings.contains("BEGIN") && !settings.contains("whsec"),
        "{settings}"
    );
    assert_eq!(ok.0["apiBase"], "http://127.0.0.1:1");
    let wrong = build(&NewInstallation {
        app_id: "12345".to_owned(),
        installation_id: 9,
        login: "acme".to_owned(),
        private_key: "not a key".to_owned(),
        ..NewInstallation::default()
    });
    assert!(wrong.is_err());
}
