//! People signing in with a password, over HTTP and the client socket: what a refusal gives away,
//! how guessing is slowed, and when a session ends. Tenant against tenant is in `isolation.rs`.
//!
//! The database hashes with the cheapest argon2 cost (`PasswordParams::insecure_for_tests`),
//! which is for tests only. Time moves with the gateway's manual clock where a test needs a
//! lockout to pass, and no test waits for one.

use std::time::Duration;

use jian_protocol::auth::{AddUserResponse, ErrorBody, LoginResponse, Me, UserRole, UsersPage};
use jian_protocol::client::CLOSE_TOKEN_REVOKED;
use jian_server::{Limit, Settings};
use jian_store::TenantId;
use jian_testkit::{ADMIN_EMAIL, MEMBER_EMAIL, TwoTenants};
use serde_json::{Value, json};

use super::support::{Client, Gateway, closed_with, dial, http_get, http_post};

/// The tenant that signs in by password in these tests, and the other one.
pub const SIGN_IN_TENANT: &str = "isoa";
pub const OTHER_TENANT: &str = "isob";

pub fn tenant(id: &str) -> TenantId {
    TenantId::parse(id).unwrap()
}

/// A gateway that signs in tenant `isoa`, with limits wide enough that a test is not locked out
/// by accident.
pub fn open_settings() -> Settings {
    Settings {
        password_login: Some(tenant(SIGN_IN_TENANT)),
        login_per_address: Limit {
            burst: 1000,
            per_second: 100.0,
        },
        login_per_account: Limit {
            burst: 1000,
            per_second: 100.0,
        },
        ..Settings::default()
    }
}

pub async fn start(settings: Settings) -> (Gateway, TwoTenants) {
    let gateway = Gateway::start(settings).await;
    let tenants =
        TwoTenants::seed_as(&gateway.db, tenant(SIGN_IN_TENANT), tenant(OTHER_TENANT)).await;
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

async fn me(gateway: &Gateway, token: &str) -> (u16, String) {
    http_get(gateway.addr, "/v1/me", Some(token)).await
}

fn error_of(body: &str) -> String {
    serde_json::from_str::<ErrorBody>(body).unwrap().error
}

async fn post(gateway: &Gateway, path: &str, token: &str, body: Value) -> (u16, String) {
    http_post(gateway.addr, path, Some(token), &body).await
}

#[tokio::test]
async fn the_right_password_signs_in_and_the_session_is_the_user() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    // The address is matched whatever its case and spaces.
    let spelled = format!("  {}  ", ADMIN_EMAIL.to_uppercase());
    let session = signed_in(&gateway, &spelled, &side.admin_password).await;
    assert!(session.token.starts_with("js_"));
    assert_eq!(session.user.email, ADMIN_EMAIL);
    assert_eq!(session.user.role, UserRole::Admin);

    let (status, body) = me(&gateway, &session.token).await;
    assert_eq!(status, 200);
    let who: Me = serde_json::from_str(&body).unwrap();
    assert_eq!(who.kind, "session");
    assert_eq!(who.tenant, SIGN_IN_TENANT);
    assert_eq!(who.user_id.as_deref(), Some(side.admin.id.as_str()));
    assert_eq!(who.role, Some(UserRole::Admin));
    assert!(!who.must_change_password);

    // The owner's token keeps working, and belongs to nobody.
    let (_, body) = me(&gateway, &side.owner_token).await;
    let owner: Me = serde_json::from_str(&body).unwrap();
    assert_eq!((owner.kind.as_str(), owner.user_id), ("owner", None));
    gateway.stop().await;
}

#[tokio::test]
async fn every_way_to_fail_a_login_gives_the_same_answer() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    gateway
        .db
        .disable_user(&side.ctx, &side.member.id)
        .await
        .unwrap()
        .unwrap();
    let wrong = login(&gateway, ADMIN_EMAIL, "not the password at all").await;
    let unknown = login(&gateway, "nobody@isolation.test", &side.admin_password).await;
    // The password is right; the user is disabled.
    let disabled = login(&gateway, MEMBER_EMAIL, &side.member_password).await;
    let malformed = login(&gateway, "not an address", &side.admin_password).await;
    assert_eq!(wrong.0, 401);
    assert_eq!(error_of(&wrong.1), "invalid_credentials");
    for other in [&unknown, &disabled, &malformed] {
        assert_eq!(&wrong, other);
    }

    // A body that is not a login is refused before anything is checked.
    let huge = login(&gateway, ADMIN_EMAIL, &"x".repeat(20_000)).await;
    assert_eq!(huge.0, 413);
    gateway.stop().await;
}

#[tokio::test]
async fn guessing_is_locked_out_and_the_lockout_passes() {
    // The default limits: five tries for an address and one more each minute.
    let settings = Settings {
        password_login: Some(tenant(SIGN_IN_TENANT)),
        ..Settings::default()
    };
    let (gateway, tenants) = start(settings).await;
    let side = &tenants.a;
    for _ in 0..5 {
        assert_eq!(
            login(&gateway, ADMIN_EMAIL, "wrong password 1").await.0,
            401
        );
    }
    // Even the right password waits now, and it is told how long, not why.
    let locked = login(&gateway, ADMIN_EMAIL, &side.admin_password).await;
    assert_eq!(locked.0, 429);
    assert_eq!(error_of(&locked.1), "too_many_attempts");
    // Another address from the same place is not held by it.
    assert_eq!(
        login(&gateway, MEMBER_EMAIL, &side.member_password).await.0,
        200
    );
    gateway.clock.advance(Duration::from_secs(61));
    assert_eq!(
        login(&gateway, ADMIN_EMAIL, &side.admin_password).await.0,
        200
    );
    gateway.stop().await;
}

#[tokio::test]
async fn a_provisional_password_must_be_replaced_before_anything_else() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = post(
        &gateway,
        "/v1/users",
        admin,
        json!({ "email": "New.Person@Example.test", "name": "New Person",
                "role": "member", "password": "provisional-pass-1" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let added: AddUserResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(added.user.email, "new.person@example.test");
    assert!(added.invite.is_none());

    let first = signed_in(&gateway, "new.person@example.test", "provisional-pass-1").await;
    assert!(first.user.must_change_password);
    // Nothing opens but the way out, whatever the route or the socket.
    let (status, body) = http_get(gateway.addr, "/v1/users", Some(&first.token)).await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (403, "password_change_required")
    );
    assert_eq!(
        dial(gateway.addr, "/v1/ws", Some(&first.token)).await.err(),
        Some(403)
    );
    assert_eq!(me(&gateway, &first.token).await.0, 200);

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
    let (status, body) = http_get(gateway.addr, "/v1/users", Some(&first.token)).await;
    assert_eq!((status, error_of(&body).as_str()), (403, "forbidden"));
    assert_eq!(
        login(&gateway, "new.person@example.test", "provisional-pass-1")
            .await
            .0,
        401
    );
    let again = signed_in(&gateway, "new.person@example.test", "my-own-password-1").await;
    assert!(!again.user.must_change_password);
    gateway.stop().await;
}

#[tokio::test]
async fn an_invitation_gives_one_person_one_password_once() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let (status, body) = post(
        &gateway,
        "/v1/users",
        admin,
        json!({ "email": "invited@example.test", "name": "Invited", "role": "member",
                "password": null }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let added: AddUserResponse = serde_json::from_str(&body).unwrap();
    let invite = added.invite.unwrap();
    assert!(!added.user.has_password);
    assert_eq!(
        login(&gateway, "invited@example.test", "anything long enough")
            .await
            .0,
        401
    );

    let accept = |password: &'static str| {
        let body = json!({ "token": invite.token, "password": password });
        let addr = gateway.addr;
        async move { http_post(addr, "/v1/auth/invite/accept", None, &body).await }
    };
    let (status, body) = accept("chosen by the person").await;
    assert_eq!(status, 200, "{body}");
    let session: LoginResponse = serde_json::from_str(&body).unwrap();
    assert!(!session.user.must_change_password);
    assert_eq!(me(&gateway, &session.token).await.0, 200);

    // Used: the same token says nothing more than a made-up one does.
    let (status, spent) = accept("another one entirely").await;
    assert_eq!(status, 400);
    assert_eq!(error_of(&spent), "invalid_invite");
    let (_, made_up) = http_post(
        gateway.addr,
        "/v1/auth/invite/accept",
        None,
        &json!({ "token": "ji_made-up", "password": "another one entirely" }),
    )
    .await;
    assert_eq!(spent, made_up);
    signed_in(&gateway, "invited@example.test", "chosen by the person").await;
    gateway.stop().await;
}

#[tokio::test]
async fn sessions_end_on_logout_on_a_password_change_and_when_the_user_is_disabled() {
    let settings = Settings {
        recheck_interval: Duration::from_millis(100),
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let side = &tenants.a;

    // Logout ends that session only, and only a person's session can be ended this way.
    let (one, two) = (
        signed_in(&gateway, MEMBER_EMAIL, &side.member_password).await,
        signed_in(&gateway, MEMBER_EMAIL, &side.member_password).await,
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
        post(&gateway, "/v1/auth/logout", &side.owner_token, json!({}))
            .await
            .0,
        403
    );
    assert_eq!(me(&gateway, &side.owner_token).await.0, 200);

    // A password change keeps the session that made it and ends the others.
    let three = signed_in(&gateway, MEMBER_EMAIL, &side.member_password).await;
    let (status, _) = post(
        &gateway,
        "/v1/auth/password",
        &two.token,
        json!({ "current": side.member_password, "new": "a brand new password" }),
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(me(&gateway, &two.token).await.0, 200);
    assert_eq!(me(&gateway, &three.token).await.0, 401);

    // Disabling ends every session at once and cuts a socket that is open.
    let mut socket = Client::open(gateway.addr, &two.token).await;
    let path = format!("/v1/users/{}/disable", side.member.id);
    let (status, _) = post(&gateway, &path, &side.admin_session, json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(me(&gateway, &two.token).await.0, 401);
    assert_eq!(
        closed_with(&mut socket.socket).await,
        Some(CLOSE_TOKEN_REVOKED)
    );
    assert_eq!(
        login(&gateway, MEMBER_EMAIL, "a brand new password")
            .await
            .0,
        401
    );

    // An admin cannot lock themselves out.
    let own = format!("/v1/users/{}/disable", side.admin.id);
    let (status, body) = post(&gateway, &own, &side.admin_session, json!({})).await;
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
    let path = format!("/v1/users/{}/reset-password", side.member.id);
    let (status, _) = post(
        &gateway,
        &path,
        &side.admin_session,
        json!({ "password": "chosen by the admin" }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(me(&gateway, &side.member_session).await.0, 401);
    assert_eq!(
        login(&gateway, MEMBER_EMAIL, &side.member_password).await.0,
        401
    );
    let session = signed_in(&gateway, MEMBER_EMAIL, "chosen by the admin").await;
    assert!(session.user.must_change_password);
    gateway.stop().await;
}

#[tokio::test]
async fn only_an_admin_or_the_owner_manages_users() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let new = json!({ "email": "x@example.test", "name": "X", "role": "admin",
                      "password": "twelve chars long" });
    for token in [
        &side.member_session,
        &side.device_token,
        &side.machine_token,
    ] {
        let (status, body) = http_get(gateway.addr, "/v1/users", Some(token)).await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(error_of(&body), "forbidden");
        assert_eq!(post(&gateway, "/v1/users", token, new.clone()).await.0, 403);
        let path = format!("/v1/users/{}/disable", side.admin.id);
        assert_eq!(post(&gateway, &path, token, json!({})).await.0, 403);
    }
    for token in [&side.admin_session, &side.owner_token] {
        let (status, body) = http_get(gateway.addr, "/v1/users", Some(token)).await;
        assert_eq!(status, 200, "{body}");
        let page: UsersPage = serde_json::from_str(&body).unwrap();
        assert_eq!(page.items.len(), 2);
    }
    // The owner's token adds an admin: how a install that has none gets one without the command
    // line.
    assert_eq!(
        post(&gateway, "/v1/users", &side.owner_token, new).await.0,
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
        "/v1/users",
        "/v1/users/register",
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
        .list_users(&tenants.a.ctx, None, 100)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(
        gateway
            .db
            .user_by_email(&tenants.a.ctx, "me@example.test")
            .await
            .unwrap()
            .is_none()
    );
    gateway.stop().await;
}

#[tokio::test]
async fn a_gateway_without_password_login_has_no_login() {
    let gateway = Gateway::start(Settings::default()).await;
    let (owner, _) = gateway.tenant("alpha").await;
    let (status, body) = login(&gateway, "someone@example.test", "twelve chars long").await;
    assert_eq!(
        (status, error_of(&body).as_str()),
        (404, "password_login_disabled")
    );
    let (status, _) = http_post(
        gateway.addr,
        "/v1/auth/invite/accept",
        None,
        &json!({ "token": "ji_x", "password": "twelve chars long" }),
    )
    .await;
    assert_eq!(status, 404);
    // Everything else is as it was.
    assert_eq!(me(&gateway, &owner).await.0, 200);
    gateway.stop().await;
}
