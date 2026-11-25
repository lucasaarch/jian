//! People signing in with a password, over HTTP and the client socket: what a refusal gives away,
//! how guessing is slowed, when a session ends, and who may manage members and invitations.
//! Tenant against tenant is in `isolation.rs`.
//!
//! Argon2 runs at the cheapest cost (`PasswordParams::insecure_for_tests`), which is for tests
//! only. Time moves with the gateway's manual clock where a test needs a lockout to pass, and no
//! test waits for one.

use std::time::Duration;

use jian_auth::{AddMember, Auth, AuthPolicy, PasswordParams};
use jian_protocol::auth::{
    AddMemberResponse, ErrorBody, InviteCreated, InvitesPage, LoginResponse, Me, MemberRole,
    MembersPage,
};
use jian_protocol::client::CLOSE_TOKEN_REVOKED;
use jian_server::{Limit, Settings};
use jian_store::Role;
use jian_testkit::{PASSWORD, Side, TwoTenants};
use serde_json::{Value, json};

use super::support::{Client, Gateway, closed_with, dial, http_get, http_post};

/// A limit nobody reaches by accident.
const WIDE: Limit = Limit {
    burst: 1000,
    per_second: 100.0,
};

/// A password sign-in with the cheap argon2 and limits wide enough that a test is not locked out
/// by accident.
pub fn open_settings() -> Settings {
    Settings {
        auth: Auth::new(
            AuthPolicy::self_hosted(),
            PasswordParams::insecure_for_tests(),
        ),
        login_per_address: WIDE,
        login_per_email: WIDE,
        login_per_email_and_address: WIDE,
        ..Settings::default()
    }
}

pub async fn start(settings: Settings) -> (Gateway, TwoTenants) {
    let gateway = Gateway::start(settings).await;
    let tenants = TwoTenants::seed(&gateway.db).await;
    (gateway, tenants)
}

async fn login(gateway: &Gateway, email: &str, password: &str) -> (u16, String) {
    http_post(
        gateway.addr,
        "/v1/auth/login",
        None,
        &json!({ "email": email, "password": password }),
    )
    .await
}

/// A session that must exist: its answer.
async fn signed_in(gateway: &Gateway, email: &str, password: &str) -> LoginResponse {
    let (status, body) = login(gateway, email, password).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

/// A session of an account that belongs to several workspaces: the one asked for.
async fn signed_in_at(gateway: &Gateway, email: &str, tenant: &Side) -> LoginResponse {
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/login",
        None,
        &json!({ "email": email, "password": PASSWORD, "tenant": tenant.id.as_str() }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

async fn me(gateway: &Gateway, token: &str) -> (u16, String) {
    http_get(gateway.addr, "/v1/me", Some(token)).await
}

fn error_of(body: &str) -> String {
    serde_json::from_str::<ErrorBody>(body).unwrap().error
}

async fn post(gateway: &Gateway, path: &str, token: &str, body: Value) -> (u16, String) {
    http_post(gateway.addr, path, Some(token), &body).await
}

/// Makes the account of `from`'s admin a member of `into` as well, as an admin adding someone
/// who already has an account does.
async fn also_member_of(gateway: &Gateway, from: &Side, into: &Side, role: Role) {
    gateway
        .state
        .settings
        .auth
        .add_member(
            &gateway.db,
            &into.ctx,
            AddMember {
                email: &from.admin.email,
                name: None,
                role,
                password: "ignored for an existing account",
                invited_by: None,
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn the_right_password_signs_in_and_the_session_is_the_member() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    // The address is matched whatever its case and spaces.
    let spelled = format!("  {}  ", side.admin.email.to_uppercase());
    let session = signed_in(&gateway, &spelled, PASSWORD).await;
    assert!(session.token.starts_with("js_"));
    assert_eq!(session.tenant, side.id.as_str());
    assert_eq!(session.member.email, side.admin.email);
    assert_eq!(session.member.role, MemberRole::Admin);

    let (status, body) = me(&gateway, &session.token).await;
    assert_eq!(status, 200);
    let who: Me = serde_json::from_str(&body).unwrap();
    assert_eq!(who.kind, "session");
    assert_eq!(who.tenant, side.id.as_str());
    assert_eq!(
        who.account_id.as_deref(),
        Some(side.admin.account_id.as_str())
    );
    assert_eq!(who.role, Some(MemberRole::Admin));
    assert!(!who.must_change_password);

    // The owner's token keeps working, and belongs to nobody.
    let (_, body) = me(&gateway, &side.owner_token).await;
    let owner: Me = serde_json::from_str(&body).unwrap();
    assert_eq!((owner.kind.as_str(), owner.account_id), ("owner", None));
    gateway.stop().await;
}

#[tokio::test]
async fn every_way_to_fail_a_login_gives_the_same_answer() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    gateway
        .db
        .disable_member(&side.ctx, &side.member.account_id)
        .await
        .unwrap()
        .unwrap();
    let with = |email: &str, password: &str, tenant: Option<&str>| {
        let body = json!({ "email": email, "password": password, "tenant": tenant });
        let addr = gateway.addr;
        async move { http_post(addr, "/v1/auth/login", None, &body).await }
    };
    let wrong = with(&side.admin.email, "not the password at all", None).await;
    let unknown = with("nobody@isolation.test", PASSWORD, None).await;
    // The password is right; the member is disabled.
    let disabled = with(&side.member.email, PASSWORD, None).await;
    let malformed = with("not an address", PASSWORD, None).await;
    // The password is right; the account is not in that workspace, or there is no such one.
    let elsewhere = with(&side.admin.email, PASSWORD, Some(tenants.b.id.as_str())).await;
    let impossible = with(&side.admin.email, PASSWORD, Some("Not A Workspace!")).await;
    assert_eq!(wrong.0, 401);
    assert_eq!(error_of(&wrong.1), "invalid_credentials");
    for other in [&unknown, &disabled, &malformed, &elsewhere, &impossible] {
        assert_eq!(&wrong, other);
    }

    // A body that is not a login is refused before anything is checked.
    let huge = login(&gateway, &side.admin.email, &"x".repeat(20_000)).await;
    assert_eq!(huge.0, 413);
    gateway.stop().await;
}

#[tokio::test]
async fn guessing_is_locked_out_per_address_and_email_and_the_lockout_passes() {
    // The default limits: five tries for an email from one address, one more each minute.
    let settings = Settings {
        auth: open_settings().auth,
        ..Settings::default()
    };
    let (gateway, tenants) = start(settings).await;
    let side = &tenants.a;
    for _ in 0..5 {
        assert_eq!(
            login(&gateway, &side.admin.email, "wrong password 1")
                .await
                .0,
            401
        );
    }
    // Even the right password waits now, and it is told how long, not why.
    let locked = login(&gateway, &side.admin.email, PASSWORD).await;
    assert_eq!(locked.0, 429);
    assert_eq!(error_of(&locked.1), "too_many_attempts");
    // Another email from the same place is not held by it.
    assert_eq!(login(&gateway, &side.member.email, PASSWORD).await.0, 200);
    gateway.clock.advance(Duration::from_secs(61));
    assert_eq!(login(&gateway, &side.admin.email, PASSWORD).await.0, 200);
    gateway.stop().await;
}

#[tokio::test]
async fn guessing_spread_over_many_addresses_is_locked_out_by_email() {
    // Every test request comes from one address, so the per-address limits are wide and the
    // per-email one is small: what a guesser who changes address runs into.
    let settings = Settings {
        login_per_email: Limit {
            burst: 3,
            per_second: 1.0 / 30.0,
        },
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let side = &tenants.a;
    for _ in 0..3 {
        assert_eq!(login(&gateway, &side.admin.email, "wrong").await.0, 401);
    }
    assert_eq!(login(&gateway, &side.admin.email, PASSWORD).await.0, 429);
    assert_eq!(login(&gateway, &side.member.email, PASSWORD).await.0, 200);
    gateway.clock.advance(Duration::from_secs(31));
    assert_eq!(login(&gateway, &side.admin.email, PASSWORD).await.0, 200);
    gateway.stop().await;
}

#[tokio::test]
async fn a_provisional_password_must_be_replaced_before_anything_else() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = post(
        &gateway,
        "/v1/members",
        admin,
        json!({ "email": "New.Person@Example.test", "name": "New Person",
                "role": "member", "password": "provisional-pass-1" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let added: AddMemberResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(added.member.email, "new.person@example.test");
    assert!(added.account_created);

    let first = signed_in(&gateway, "new.person@example.test", "provisional-pass-1").await;
    assert!(first.member.must_change_password);
    // Nothing opens but the way out, whatever the route or the socket.
    let (status, body) = http_get(gateway.addr, "/v1/members", Some(&first.token)).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (403, "password_change_required")
    );
    assert_eq!(
        dial(gateway.addr, "/v1/ws", Some(&first.token)).await.err(),
        Some(403)
    );
    let (status, body) = me(&gateway, &first.token).await;
    assert_eq!(status, 200);
    assert!(
        serde_json::from_str::<Me>(&body)
            .unwrap()
            .must_change_password
    );

    let change = |current: &str, new: &str| {
        post(
            &gateway,
            "/v1/auth/password",
            &first.token,
            json!({ "current": current, "new": new }),
        )
    };
    let (status, body) = change("not the current one", "my-own-password-1").await;
    assert_eq!((status, error_of(&body).as_str()), (403, "wrong_password"));
    assert_eq!(change("provisional-pass-1", "short").await.0, 400);
    assert_eq!(
        change("provisional-pass-1", "my-own-password-1").await.0,
        204
    );

    // Now it is an ordinary member's session: free, and not an admin.
    let (status, body) = http_get(gateway.addr, "/v1/members", Some(&first.token)).await;
    assert_eq!((status, error_of(&body).as_str()), (403, "forbidden"));
    assert_eq!(
        login(&gateway, "new.person@example.test", "provisional-pass-1")
            .await
            .0,
        401
    );
    let again = signed_in(&gateway, "new.person@example.test", "my-own-password-1").await;
    assert!(!again.member.must_change_password);
    gateway.stop().await;
}

#[tokio::test]
async fn an_invitation_gives_one_person_one_account_once() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let invite = |email: &str| {
        post(
            &gateway,
            "/v1/invites",
            admin,
            json!({ "email": email, "role": "member" }),
        )
    };
    let (status, body) = invite("invited@example.test").await;
    assert_eq!(status, 201, "{body}");
    let first: InviteCreated = serde_json::from_str(&body).unwrap();
    assert_eq!(first.invite.email, "invited@example.test");
    assert_eq!(
        login(&gateway, "invited@example.test", "anything long enough")
            .await
            .0,
        401
    );

    // Inviting the same address again revokes the first token: only the newest opens.
    let second: InviteCreated =
        serde_json::from_str(&invite("invited@example.test").await.1).unwrap();
    assert_ne!(first.token, second.token);
    let (_, body) = http_get(gateway.addr, "/v1/invites", Some(admin)).await;
    let pending: InvitesPage = serde_json::from_str(&body).unwrap();
    assert_eq!(pending.items, std::slice::from_ref(&second.invite));

    let accept = |token: &str, password: &str| {
        let body = json!({ "token": token, "password": password, "name": "Invited Person" });
        let addr = gateway.addr;
        async move { http_post(addr, "/v1/auth/invite/accept", None, &body).await }
    };
    let (status, revoked) = accept(first.token.as_deref().unwrap(), "chosen by the person").await;
    assert_eq!(
        (status, error_of(&revoked).as_str()),
        (400, "invalid_invite")
    );
    let (status, body) = accept(second.token.as_deref().unwrap(), "chosen by the person").await;
    assert_eq!(status, 200, "{body}");
    let session: LoginResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(session.member.name, "Invited Person");
    assert!(!session.member.must_change_password);
    assert_eq!(me(&gateway, &session.token).await.0, 200);

    // Used, revoked or made up: the same answer, word for word.
    let (_, spent) = accept(second.token.as_deref().unwrap(), "another one entirely").await;
    let (_, made_up) = accept("ji_made-up", "another one entirely").await;
    assert_eq!(spent, revoked);
    assert_eq!(spent, made_up);
    signed_in(&gateway, "invited@example.test", "chosen by the person").await;

    // A revoked invitation is gone from the list, and the list is empty once all are spent.
    let (_, body) = http_get(gateway.addr, "/v1/invites", Some(admin)).await;
    assert!(
        serde_json::from_str::<InvitesPage>(&body)
            .unwrap()
            .items
            .is_empty()
    );
    let third: InviteCreated = serde_json::from_str(&invite("later@example.test").await.1).unwrap();
    let path = format!("/v1/invites/{}/revoke", third.invite.id);
    assert_eq!(post(&gateway, &path, admin, json!({})).await.0, 204);
    assert_eq!(post(&gateway, &path, admin, json!({})).await.0, 404);
    assert_eq!(
        accept(third.token.as_deref().unwrap(), "chosen by the person")
            .await
            .0,
        400
    );
    gateway.stop().await;
}

#[tokio::test]
async fn an_invitation_for_an_existing_account_needs_its_password_and_keeps_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);
    // Tenant B's admin invites a person who already has an account through tenant A.
    let (status, body) = post(
        &gateway,
        "/v1/invites",
        &b.admin_session,
        json!({ "email": a.member.email, "role": "admin" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let invite: InviteCreated = serde_json::from_str(&body).unwrap();
    let accept = |password: &str| {
        let body = json!({ "token": invite.token.as_deref().unwrap(), "password": password });
        let addr = gateway.addr;
        async move { http_post(addr, "/v1/auth/invite/accept", None, &body).await }
    };
    // A wrong password is a refusal like any login's, and does not spend the invitation.
    let (status, body) = accept("not the account's password").await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (401, "invalid_credentials")
    );
    let (status, body) = accept(PASSWORD).await;
    assert_eq!(status, 200, "{body}");
    let session: LoginResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(session.tenant, b.id.as_str());
    assert_eq!(session.member.role, MemberRole::Admin);

    // The password is the one it was: the invitation did not change it, in either workspace.
    signed_in_at(&gateway, &a.member.email, a).await;
    signed_in_at(&gateway, &a.member.email, b).await;
    // With two workspaces the account has to say which one, and is told so.
    let (status, body) = login(&gateway, &a.member.email, PASSWORD).await;
    assert_eq!((status, error_of(&body).as_str()), (400, "tenant_required"));
    gateway.stop().await;
}

#[tokio::test]
async fn sessions_end_on_logout_and_on_a_password_change_in_every_workspace() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);
    also_member_of(&gateway, a, b, Role::Member).await;
    let email = &a.admin.email;

    // Logout ends that session only, and only a person's session can be ended this way.
    let (one, two) = (
        signed_in_at(&gateway, email, a).await,
        signed_in_at(&gateway, email, a).await,
    );
    assert_eq!(
        post(&gateway, "/v1/auth/logout", &one.token, json!({}))
            .await
            .0,
        204
    );
    assert_eq!(me(&gateway, &one.token).await.0, 401);
    assert_eq!(me(&gateway, &two.token).await.0, 200);
    assert_eq!(
        post(&gateway, "/v1/auth/logout", &a.owner_token, json!({}))
            .await
            .0,
        403
    );
    assert_eq!(me(&gateway, &a.owner_token).await.0, 200);

    // A password change keeps the session that made it and ends the others, in the other
    // workspace too: the password is the account's, not a workspace's.
    let (three, in_b) = (
        signed_in_at(&gateway, email, a).await,
        signed_in_at(&gateway, email, b).await,
    );
    let (status, _) = post(
        &gateway,
        "/v1/auth/password",
        &two.token,
        json!({ "current": PASSWORD, "new": "a brand new password" }),
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(me(&gateway, &two.token).await.0, 200);
    assert_eq!(me(&gateway, &three.token).await.0, 401);
    assert_eq!(me(&gateway, &in_b.token).await.0, 401);
    assert_eq!(login(&gateway, email, PASSWORD).await.0, 401);
    gateway.stop().await;
}

#[tokio::test]
async fn disabling_a_member_ends_their_sessions_in_that_workspace_only() {
    let settings = Settings {
        recheck_interval: Duration::from_millis(100),
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let (a, b) = (&tenants.a, &tenants.b);
    also_member_of(&gateway, a, b, Role::Admin).await;
    let (in_a, in_b) = (
        signed_in_at(&gateway, &a.admin.email, a).await,
        signed_in_at(&gateway, &a.admin.email, b).await,
    );
    let victim_a = signed_in_at(&gateway, &a.member.email, a).await;
    let seeded = a.member_session.clone();

    // Tenant B's admin cannot disable the account of tenant A's member: B has no such member.
    let path = format!("/v1/members/{}/disable", a.member.account_id);
    assert_eq!(
        post(&gateway, &path, &b.admin_session, json!({})).await.0,
        404
    );

    // Tenant A's admin disables A's member: every session of it ends, and its socket closes.
    let mut socket = Client::open(gateway.addr, &victim_a.token).await;
    let (status, body) = post(&gateway, &path, &a.admin_session, json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(me(&gateway, &victim_a.token).await.0, 401);
    assert_eq!(me(&gateway, &seeded).await.0, 401);
    assert_eq!(
        closed_with(&mut socket.socket).await,
        Some(CLOSE_TOKEN_REVOKED)
    );
    assert_eq!(login(&gateway, &a.member.email, PASSWORD).await.0, 401);

    // The shared account disabled in B by B's admin: A's session of it stays.
    let path = format!("/v1/members/{}/disable", a.admin.account_id);
    let (status, _) = post(&gateway, &path, &b.admin_session, json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(me(&gateway, &in_b.token).await.0, 401);
    assert_eq!(me(&gateway, &in_a.token).await.0, 200);
    // A disabled membership is no membership: the account signs in to A without naming it.
    let again = signed_in(&gateway, &a.admin.email, PASSWORD).await;
    assert_eq!(again.tenant, a.id.as_str());

    // An admin cannot lock themselves out.
    let own = format!("/v1/members/{}/disable", a.admin.account_id);
    let (status, body) = post(&gateway, &own, &a.admin_session, json!({})).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "cannot_disable_yourself")
    );
    gateway.stop().await;
}

#[tokio::test]
async fn an_admin_reset_ends_the_sessions_and_asks_for_a_new_password() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let path = format!("/v1/members/{}/reset-password", side.member.account_id);
    let (status, _) = post(
        &gateway,
        &path,
        &side.admin_session,
        json!({ "password": "chosen by the admin" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(me(&gateway, &side.member_session).await.0, 401);
    assert_eq!(login(&gateway, &side.member.email, PASSWORD).await.0, 401);
    let session = signed_in(&gateway, &side.member.email, "chosen by the admin").await;
    assert!(session.member.must_change_password);
    gateway.stop().await;
}

#[tokio::test]
async fn an_admin_cannot_reset_the_password_of_an_account_in_other_workspaces() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);
    also_member_of(&gateway, a, b, Role::Member).await;
    // Tenant B's admin reaches the shared account, which is a member of B too.
    let path = format!("/v1/members/{}/reset-password", a.admin.account_id);
    let (status, body) = post(
        &gateway,
        &path,
        &b.admin_session,
        json!({ "password": "chosen by the other admin" }),
    )
    .await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (409, "account_in_other_workspaces")
    );
    // Nothing changed: the password and the sessions are as they were.
    assert_eq!(me(&gateway, &a.admin_session).await.0, 200);
    signed_in_at(&gateway, &a.admin.email, a).await;
    gateway.stop().await;
}

#[tokio::test]
async fn only_an_admin_or_the_owner_manages_members_and_invitations() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let new = json!({ "email": "x@example.test", "name": "X", "role": "admin",
                      "password": "twelve chars long" });
    let invite = json!({ "email": "y@example.test", "role": "member" });
    for token in [
        &side.member_session,
        &side.device_token,
        &side.machine_token,
    ] {
        for path in ["/v1/members", "/v1/invites"] {
            let (status, body) = http_get(gateway.addr, path, Some(token)).await;
            assert_eq!(status, 403, "{path}: {body}");
            assert_eq!(error_of(&body), "forbidden");
        }
        assert_eq!(
            post(&gateway, "/v1/members", token, new.clone()).await.0,
            403
        );
        assert_eq!(
            post(&gateway, "/v1/invites", token, invite.clone()).await.0,
            403
        );
        let id = &side.admin.account_id;
        for path in [
            format!("/v1/members/{id}/disable"),
            format!("/v1/members/{id}/reset-password"),
            "/v1/invites/anything/revoke".to_owned(),
        ] {
            let body = json!({ "password": "twelve chars long" });
            assert_eq!(post(&gateway, &path, token, body).await.0, 403, "{path}");
        }
    }
    for token in [&side.admin_session, &side.owner_token] {
        let (status, body) = http_get(gateway.addr, "/v1/members", Some(token)).await;
        assert_eq!(status, 200, "{body}");
        let page: MembersPage = serde_json::from_str(&body).unwrap();
        let ids: Vec<&str> = page.items.iter().map(|m| m.account_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                side.admin.account_id.as_str(),
                side.member.account_id.as_str(),
                side.peer.account_id.as_str()
            ]
        );
    }
    // The owner's token adds an admin: how an install that has none gets one without the
    // command line.
    assert_eq!(
        post(&gateway, "/v1/members", &side.owner_token, new)
            .await
            .0,
        201
    );
    assert_eq!(
        post(&gateway, "/v1/invites", &side.owner_token, invite)
            .await
            .0,
        201
    );
    gateway.stop().await;
}

#[tokio::test]
async fn there_is_no_way_to_sign_oneself_up() {
    let (gateway, tenants) = start(open_settings()).await;
    let body = json!({ "email": "me@example.test", "name": "Me", "role": "admin",
                       "password": "twelve chars long" });
    for path in [
        "/v1/members",
        "/v1/members/register",
        "/v1/auth/register",
        "/v1/auth/signup",
        "/v1/register",
        "/v1/signup",
    ] {
        let (status, _) = http_post(gateway.addr, path, None, &body).await;
        assert!([401, 404, 405].contains(&status), "{path}: {status}");
    }
    let page = gateway
        .db
        .list_members(&tenants.a.ctx, None, 100)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 3);
    assert!(
        gateway
            .db
            .account_by_email("me@example.test")
            .await
            .unwrap()
            .is_none()
    );
    gateway.stop().await;
}

#[tokio::test]
async fn a_gateway_without_password_sign_in_has_no_login() {
    let settings = Settings {
        auth: Auth::new(AuthPolicy::cloud(), PasswordParams::insecure_for_tests()),
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let side = &tenants.a;
    let (status, body) = login(&gateway, &side.admin.email, PASSWORD).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (404, "password_login_disabled")
    );
    for (path, body) in [
        (
            "/v1/auth/invite/accept",
            json!({ "token": "ji_x", "password": "twelve chars long" }),
        ),
        (
            "/v1/members",
            json!({ "email": "x@example.test", "role": "member", "password": "twelve chars long" }),
        ),
        (
            "/v1/invites",
            json!({ "email": "x@example.test", "role": "member" }),
        ),
    ] {
        let (status, _) = post(&gateway, path, &side.owner_token, body).await;
        assert_eq!(status, 404, "{path}");
    }
    // Everything else is as it was: a session that exists still works, and an admin still reads.
    assert_eq!(me(&gateway, &side.owner_token).await.0, 200);
    assert_eq!(me(&gateway, &side.admin_session).await.0, 200);
    let (status, _) = http_get(gateway.addr, "/v1/members", Some(&side.admin_session)).await;
    assert_eq!(status, 200);
    gateway.stop().await;
}
