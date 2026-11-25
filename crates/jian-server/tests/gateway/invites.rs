//! Invitations by e-mail and by link: one invitation per address whose token is replaced, never
//! added to; the job that sends it; and whose Resend account sends it. No test calls the real API:
//! the mailer is a recorder, or a local server that plays Resend.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post as route_post;
use futures_util::future::BoxFuture;
use jian_mail::{MailError, Mailbox, Mailer, Message, SendReceipt};
use jian_protocol::auth::{ErrorBody, InviteCreated, InviteSendStatus, InviteSummary, InvitesPage};
use jian_server::{
    DeployMail, INVITE_SEND_KIND, InviteSender, JobRegistry, MailConfig, PublicUrl, Settings,
};
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_get, http_post, http_request};

/// A mailer that records what it was asked to send and fails as scripted.
#[derive(Debug, Default)]
struct Outbox {
    sent: Mutex<Vec<Message>>,
    failures: Mutex<VecDeque<MailError>>,
}

impl Outbox {
    fn failing(failures: impl IntoIterator<Item = MailError>) -> Arc<Self> {
        Arc::new(Self {
            sent: Mutex::default(),
            failures: Mutex::new(failures.into_iter().collect()),
        })
    }

    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }

    fn last(&self) -> Message {
        self.sent.lock().unwrap().last().unwrap().clone()
    }
}

impl Mailer for Outbox {
    fn send<'a>(&'a self, message: &'a Message) -> BoxFuture<'a, Result<SendReceipt, MailError>> {
        self.sent.lock().unwrap().push(message.clone());
        let failure = self.failures.lock().unwrap().pop_front();
        Box::pin(async move {
            match failure {
                Some(error) => Err(error),
                None => Ok(SendReceipt {
                    message_id: Some("msg_1".to_owned()),
                }),
            }
        })
    }
}

fn settings(public: bool, outbox: Option<&Arc<Outbox>>) -> Settings {
    Settings {
        public_url: public.then(|| PublicUrl::parse("https://jian.example.test").unwrap()),
        mail: MailConfig {
            deploy: outbox.map(|outbox| DeployMail {
                mailer: outbox.clone(),
                from: Mailbox::parse("Jian <invites@example.test>").unwrap(),
            }),
            ..MailConfig::default()
        },
        ..open_settings()
    }
}

fn registry(settings: &Settings) -> JobRegistry {
    JobRegistry::new().register(INVITE_SEND_KIND, Arc::new(InviteSender::new(settings)))
}

/// The token in the link of an e-mail.
fn token_of(message: &Message) -> String {
    let (_, rest) = message.text.split_once("/invite#token=").unwrap();
    assert!(message.html.contains("/invite#token="));
    rest.split_whitespace().next().unwrap().to_owned()
}

fn error_of(body: &str) -> String {
    serde_json::from_str::<ErrorBody>(body).unwrap().error
}

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (u16, String) {
    http_request(
        gateway.addr,
        method,
        path,
        Some(token),
        Some(&body.to_string()),
    )
    .await
}

async fn invite(gateway: &Gateway, admin: &str, email: &str, send: Option<bool>) -> (u16, String) {
    let mut body = json!({ "email": email, "role": "member" });
    if let Some(send) = send {
        body["send"] = json!(send);
    }
    http_post(gateway.addr, "/v1/invites", Some(admin), &body).await
}

async fn listed(gateway: &Gateway, admin: &str) -> Vec<InviteSummary> {
    let (status, body) = http_get(gateway.addr, "/v1/invites", Some(admin)).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<InvitesPage>(&body).unwrap().items
}

/// Waits until the invitation says how its e-mail ended.
async fn settled(gateway: &Gateway, admin: &str, id: &str) -> InviteSummary {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let found = listed(gateway, admin)
            .await
            .into_iter()
            .find(|i| i.id == id);
        if let Some(found) = found
            && matches!(
                found.send_status,
                InviteSendStatus::Sent | InviteSendStatus::Failed
            )
        {
            return found;
        }
        assert!(Instant::now() < until, "the e-mail was never settled");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn accept(gateway: &Gateway, token: &str) -> (u16, String) {
    let body = json!({ "token": token, "password": "chosen by the person", "name": "Invited" });
    http_post(gateway.addr, "/v1/auth/invite/accept", None, &body).await
}

async fn stop(gateway: Gateway, runner: jian_server::JobRunner) {
    runner
        .shutdown(Instant::now() + Duration::from_secs(5))
        .await;
    gateway.stop().await;
}

#[tokio::test]
async fn an_email_carries_a_token_that_the_next_link_or_resend_replaces() {
    let outbox = Outbox::failing([]);
    let settings = settings(true, Some(&outbox));
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let admin = &tenants.a.admin_session;

    // With a mailer and a public URL, inviting sends: the answer holds no token, the job makes it.
    let (status, body) = invite(&gateway, admin, "new@example.test", None).await;
    assert_eq!(status, 201, "{body}");
    let created: InviteCreated = serde_json::from_str(&body).unwrap();
    assert_eq!((created.token, created.link), (None, None));
    assert_eq!(created.invite.send_status, InviteSendStatus::Pending);
    let id = created.invite.id;
    let done = settled(&gateway, admin, &id).await;
    assert_eq!(done.send_status, InviteSendStatus::Sent);
    assert!(done.sent_at.is_some() && done.send_error.is_none());
    assert_eq!(done.provider_message_id.as_deref(), Some("msg_1"));
    assert_eq!(outbox.count(), 1);
    assert_eq!(outbox.last().to, "new@example.test");
    let first = token_of(&outbox.last());

    // The queue's row names the invitation and carries no token.
    let jobs = jian_testkit::job_rows(&gateway.url, INVITE_SEND_KIND).await;
    assert_eq!(jobs.len(), 1);
    let (state, attempts, payload) = &jobs[0];
    assert_eq!((state.as_str(), *attempts), ("done", 1));
    assert_eq!(
        serde_json::from_str::<Value>(payload).unwrap(),
        json!({ "inviteId": id })
    );
    assert!(!payload.contains(&first));

    // Sending it again replaces the token in the same invitation: the old one is dead at once.
    let resent = call(
        &gateway,
        "POST",
        &format!("/v1/invites/{id}/resend"),
        admin,
        json!({}),
    )
    .await;
    assert_eq!(resent.0, 202, "{}", resent.1);
    until_count(&outbox, 2).await;
    settled(&gateway, admin, &id).await;
    let second = token_of(&outbox.last());
    assert_ne!(first, second);
    let (status, body) = accept(&gateway, &first).await;
    assert_eq!((status, error_of(&body).as_str()), (400, "invalid_invite"));
    let items = listed(&gateway, admin).await;
    assert_eq!(items.len(), 1, "one invitation per address");
    assert_eq!(items[0].id, id);

    // Copying the link replaces it again, and hands the new one over once.
    let (status, body) = call(
        &gateway,
        "POST",
        &format!("/v1/invites/{id}/link"),
        admin,
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let copied: InviteCreated = serde_json::from_str(&body).unwrap();
    let third = copied.token.unwrap();
    assert_eq!(
        copied.link.as_deref(),
        Some(format!("https://jian.example.test/invite#token={third}").as_str())
    );
    assert_eq!(copied.invite.id, id);
    assert_eq!(accept(&gateway, &second).await.0, 400);
    let (status, body) = accept(&gateway, &third).await;
    assert_eq!(status, 200, "{body}");
    // Used: neither listed nor sendable.
    assert!(listed(&gateway, admin).await.is_empty());
    let after = call(
        &gateway,
        "POST",
        &format!("/v1/invites/{id}/resend"),
        admin,
        json!({}),
    )
    .await;
    assert_eq!(after.0, 404);
    assert_eq!(outbox.count(), 2);
    stop(gateway, runner).await;
}

async fn until_count(outbox: &Outbox, count: usize) {
    let until = Instant::now() + Duration::from_secs(15);
    while outbox.count() < count {
        assert!(Instant::now() < until, "the mailer was not asked again");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test]
async fn a_refusal_that_waiting_cannot_fix_fails_once_and_a_temporary_one_is_retried() {
    let refused =
        MailError::Permanent("Resend answered 403: the domain is not verified".to_owned());
    let busy = || MailError::Temporary("Resend answered 503".to_owned());
    let outbox = Outbox::failing([refused, busy(), busy()]);
    let settings = settings(true, Some(&outbox));
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let admin = &tenants.a.admin_session;

    // Permanent: `failed` with the reason, one call, and the job is over (not dead, not retried).
    let created: InviteCreated =
        serde_json::from_str(&invite(&gateway, admin, "one@example.test", None).await.1).unwrap();
    let failed = settled(&gateway, admin, &created.invite.id).await;
    assert_eq!(failed.send_status, InviteSendStatus::Failed);
    assert!(failed.send_error.unwrap().contains("not verified"));
    assert_eq!(outbox.count(), 1);
    let jobs = jian_testkit::job_rows(&gateway.url, INVITE_SEND_KIND).await;
    assert_eq!((jobs[0].0.as_str(), jobs[0].1), ("done", 1));

    // Temporary twice, then through: the queue tried again by itself, and the error is cleared.
    let created: InviteCreated =
        serde_json::from_str(&invite(&gateway, admin, "two@example.test", None).await.1).unwrap();
    let sent = settled(&gateway, admin, &created.invite.id).await;
    assert_eq!(sent.send_status, InviteSendStatus::Sent);
    assert!(sent.send_error.is_none());
    assert_eq!(outbox.count(), 4);
    let jobs = jian_testkit::job_rows(&gateway.url, INVITE_SEND_KIND).await;
    assert_eq!((jobs[1].0.as_str(), jobs[1].1), ("done", 3));
    // Only the last attempt's link works: each attempt replaced the token.
    let token = token_of(&outbox.last());
    assert_eq!(accept(&gateway, &token).await.0, 200);
    stop(gateway, runner).await;

    // Out of attempts: `failed`, and the job is kept as dead.
    let outbox = Outbox::failing((0..5).map(|_| busy()));
    let settings = self::settings(true, Some(&outbox));
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let admin = &tenants.a.admin_session;
    let created: InviteCreated =
        serde_json::from_str(&invite(&gateway, admin, "three@example.test", None).await.1).unwrap();
    let failed = settled(&gateway, admin, &created.invite.id).await;
    assert_eq!(failed.send_status, InviteSendStatus::Failed);
    assert_eq!(outbox.count(), 5);
    let jobs = jian_testkit::job_rows(&gateway.url, INVITE_SEND_KIND).await;
    assert_eq!((jobs[0].0.as_str(), jobs[0].1), ("dead", 5));
    stop(gateway, runner).await;
}

#[tokio::test]
async fn without_a_mailer_or_a_public_url_the_invitation_is_a_link_or_a_clear_refusal() {
    let outbox = Outbox::failing([]);
    // A public URL and no mailer: a link, and no e-mail to ask for.
    let (gateway, tenants) = start(settings(true, None)).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = invite(&gateway, admin, "link@example.test", None).await;
    assert_eq!(status, 201, "{body}");
    let created: InviteCreated = serde_json::from_str(&body).unwrap();
    assert_eq!(created.invite.send_status, InviteSendStatus::None);
    let token = created.token.unwrap();
    assert_eq!(
        created.link.unwrap(),
        format!("https://jian.example.test/invite#token={token}")
    );
    let (status, body) = invite(&gateway, admin, "link2@example.test", Some(true)).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "mail_not_configured")
    );
    let resent = call(
        &gateway,
        "POST",
        &format!("/v1/invites/{}/resend", created.invite.id),
        admin,
        json!({}),
    )
    .await;
    assert_eq!(
        (resent.0, error_of(&resent.1).as_str()),
        (409, "mail_not_configured")
    );
    assert_eq!(accept(&gateway, &token).await.0, 200);
    gateway.stop().await;

    // A mailer and no public URL: no link can be made, so sending and copying say why; a plain
    // invitation still works as a token.
    let (gateway, tenants) = start(settings(false, Some(&outbox))).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = invite(&gateway, admin, "send@example.test", Some(true)).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "public_url_missing")
    );
    let (status, body) = invite(&gateway, admin, "token@example.test", None).await;
    assert_eq!(status, 201, "{body}");
    let created: InviteCreated = serde_json::from_str(&body).unwrap();
    assert!(created.link.is_none());
    assert_eq!(created.invite.send_status, InviteSendStatus::None);
    let link = call(
        &gateway,
        "POST",
        &format!("/v1/invites/{}/link", created.invite.id),
        admin,
        json!({}),
    )
    .await;
    assert_eq!(
        (link.0, error_of(&link.1).as_str()),
        (409, "public_url_missing")
    );
    assert_eq!(accept(&gateway, &created.token.unwrap()).await.0, 200);
    assert_eq!(outbox.count(), 0);
    gateway.stop().await;
}

/// A local server that plays Resend: what it was asked, by whom.
type Received = Arc<Mutex<Vec<(String, Value)>>>;

async fn fake_resend() -> (String, Received) {
    async fn emails(
        State(received): State<Received>,
        headers: HeaderMap,
        body: String,
    ) -> (StatusCode, String) {
        let key = headers["authorization"].to_str().unwrap().to_owned();
        received
            .lock()
            .unwrap()
            .push((key, serde_json::from_str(&body).unwrap()));
        (StatusCode::OK, r#"{"id":"re_1"}"#.to_owned())
    }
    let received = Received::default();
    let app = Router::new()
        .route("/emails", route_post(emails))
        .with_state(received.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, received)
}

#[tokio::test]
async fn an_invitation_is_sent_with_its_own_workspaces_mail_account_and_nobody_elses() {
    let (url, received) = fake_resend().await;
    let settings = Settings {
        mail: MailConfig {
            resend_base_url: url,
            ..MailConfig::default()
        },
        ..settings(true, None)
    };
    let (gateway, tenants) = start(settings.clone()).await;
    let runner = gateway.run_jobs(registry(&settings)).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let (key_a, key_b) = ("re_key_of_workspace_a_0001", "re_key_of_workspace_b_0002");
    let put = |side: &jian_testkit::Side, body: Value| {
        let session = side.admin_session.clone();
        let gateway = &gateway;
        async move { call(gateway, "PUT", "/v1/settings/mail", &session, body).await }
    };

    // Nothing is set yet, and the first save needs a key and a sender that parses.
    let (status, body) = http_get(gateway.addr, "/v1/settings/mail", Some(&a.admin_session)).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains(r#""provider":"none""#) && body.contains(r#""hasKey":false"#),
        "{body}"
    );
    assert_eq!(
        put(a, json!({ "from": "A Co <invites@a.test>" })).await.0,
        400
    );
    assert_eq!(
        put(
            a,
            json!({ "resendApiKey": key_a, "from": "not an address" })
        )
        .await
        .0,
        400
    );
    assert_eq!(
        put(
            a,
            json!({ "resendApiKey": "bad key", "from": "invites@a.test" })
        )
        .await
        .0,
        400
    );
    // A member is not an admin.
    let member = call(
        &gateway,
        "PUT",
        "/v1/settings/mail",
        &a.member_session,
        json!({ "resendApiKey": key_a, "from": "x@a.test" }),
    )
    .await;
    assert_eq!(member.0, 403);
    assert_eq!(
        http_get(gateway.addr, "/v1/settings/mail", Some(&a.member_session))
            .await
            .0,
        403
    );

    // Each workspace stores its own account; the key is never in an answer.
    for (side, key, from) in [
        (a, key_a, "A Co <invites@a.test>"),
        (b, key_b, "invites@b.test"),
    ] {
        let (status, body) = put(side, json!({ "resendApiKey": key, "from": from })).await;
        assert_eq!(status, 200, "{body}");
        assert!(!body.contains(key), "{body}");
        let (_, body) =
            http_get(gateway.addr, "/v1/settings/mail", Some(&side.admin_session)).await;
        assert!(
            body.contains(r#""hasKey":true"#) && !body.contains(key),
            "{body}"
        );
    }
    // The sender can change without sending the key again.
    let (status, body) = put(a, json!({ "from": "Team A <invites@a.test>" })).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("Team A"), "{body}");

    // Each invitation goes out with its own workspace's key and sender.
    let a_invite: InviteCreated = serde_json::from_str(
        &invite(&gateway, &a.admin_session, "to-a@example.test", None)
            .await
            .1,
    )
    .unwrap();
    let b_invite: InviteCreated = serde_json::from_str(
        &invite(&gateway, &b.admin_session, "to-b@example.test", None)
            .await
            .1,
    )
    .unwrap();
    assert_eq!(
        settled(&gateway, &a.admin_session, &a_invite.invite.id)
            .await
            .send_status,
        InviteSendStatus::Sent
    );
    assert_eq!(
        settled(&gateway, &b.admin_session, &b_invite.invite.id)
            .await
            .send_status,
        InviteSendStatus::Sent
    );
    let seen = received.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    for (key, body) in &seen {
        let (want_key, want_from) = match body["to"][0].as_str().unwrap() {
            "to-a@example.test" => (key_a, "\"Team A\" <invites@a.test>"),
            "to-b@example.test" => (key_b, "invites@b.test"),
            other => panic!("an e-mail to {other}"),
        };
        assert_eq!(key, &format!("Bearer {want_key}"));
        assert_eq!(body["from"], want_from);
    }

    // B cannot read, replace or remove A's account, or touch A's invitation by its id: the id
    // is "no such invitation", word for word what one that never existed gets.
    let aimed = a_invite.invite.id;
    for path in [
        format!("/v1/invites/{aimed}/link"),
        format!("/v1/invites/{aimed}/resend"),
        format!("/v1/invites/{aimed}/revoke"),
    ] {
        let never = path.replace(&aimed, "never_existed");
        let refused = call(&gateway, "POST", &path, &b.admin_session, json!({})).await;
        assert_eq!(refused.0, 404, "{path}: {}", refused.1);
        assert_eq!(
            refused,
            call(&gateway, "POST", &never, &b.admin_session, json!({})).await
        );
    }
    assert_eq!(
        call(
            &gateway,
            "DELETE",
            "/v1/settings/mail",
            &b.admin_session,
            json!({})
        )
        .await
        .0,
        204
    );
    let (_, body) = http_get(gateway.addr, "/v1/settings/mail", Some(&b.admin_session)).await;
    assert!(
        body.contains(r#""hasKey":false"#) && !body.contains("a.test"),
        "{body}"
    );
    let (_, body) = http_get(gateway.addr, "/v1/settings/mail", Some(&a.admin_session)).await;
    assert!(
        body.contains(r#""hasKey":true"#) && body.contains("Team A"),
        "{body}"
    );
    // A's invitation is untouched by B's attempts: its e-mailed token still opens it, as A.
    let sent_to_a = received
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| b["to"][0] == "to-a@example.test")
        .cloned()
        .unwrap()
        .1;
    let (_, rest) = sent_to_a["text"]
        .as_str()
        .unwrap()
        .split_once("/invite#token=")
        .unwrap();
    let token = rest.split_whitespace().next().unwrap();
    let (status, body) = accept(&gateway, token).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(&format!(r#""tenant":"{}""#, a.id)), "{body}");

    // B, with no account of its own any more, falls back to a link: the job of B never reads A's.
    let (status, body) = invite(&gateway, &b.admin_session, "later@example.test", Some(true)).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "mail_not_configured")
    );
    stop(gateway, runner).await;
}

#[tokio::test]
async fn a_deploys_own_account_is_shown_but_not_changed_by_a_workspace() {
    let outbox = Outbox::failing([]);
    let (gateway, tenants) = start(settings(true, Some(&outbox))).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = http_get(gateway.addr, "/v1/settings/mail", Some(admin)).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains(r#""managedByDeploy":true"#) && body.contains("invites@example.test"),
        "{body}"
    );
    let put = call(
        &gateway,
        "PUT",
        "/v1/settings/mail",
        admin,
        json!({ "resendApiKey": "re_own_key_0000000000", "from": "x@a.test" }),
    )
    .await;
    assert_eq!(
        (put.0, error_of(&put.1).as_str()),
        (409, "mail_managed_by_deploy")
    );
    let delete = call(&gateway, "DELETE", "/v1/settings/mail", admin, json!({})).await;
    assert_eq!(
        (delete.0, error_of(&delete.1).as_str()),
        (409, "mail_managed_by_deploy")
    );
    gateway.stop().await;
}
