//! Users, sessions, passwords and invitations against a real Postgres. Password hashing runs
//! at its cheapest here (`PasswordParams::insecure_for_tests`, set by `TestDb`), which is the
//! only difference from production: the code paths are the same.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use jian_store::{
    Database, Login, LoginOutcome, NewUser, Role, StoreError, TenantCtx, TenantId, TokenHash,
    TokenKind, User, generate_token,
};
use jian_testkit::TestDb;

const TTL: Duration = Duration::from_secs(3600);
const PASSWORD: &str = "a long enough password";

async fn start() -> (TestDb, TenantCtx) {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let id = TenantId::parse("people").unwrap();
    test.db.create_tenant(&id).await.unwrap();
    let ctx = test.db.tenant(id).await.unwrap();
    (test, ctx)
}

async fn add(db: &Database, ctx: &TenantCtx, email: &str, role: Role) -> User {
    db.add_user(
        ctx,
        NewUser {
            email,
            name: "Someone",
            role,
            password: Some(PASSWORD),
            must_change_password: false,
        },
    )
    .await
    .unwrap()
}

async fn login(db: &Database, ctx: &TenantCtx, email: &str, password: &str) -> Option<Login> {
    match db.login(ctx, email, password, TTL).await.unwrap() {
        LoginOutcome::Granted(login) => Some(login),
        LoginOutcome::Refused => None,
    }
}

async fn active(db: &Database, token: &str) -> bool {
    db.authenticate(token).await.unwrap().is_some()
}

#[tokio::test]
async fn an_address_is_stored_trimmed_and_lower_case_and_is_unique_in_that_form() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let user = add(db, &ctx, "  Ana.Silva@Example.TEST ", Role::Member).await;
    assert_eq!(user.email, "ana.silva@example.test");
    let taken = db
        .add_user(
            &ctx,
            NewUser {
                email: "ANA.SILVA@example.test",
                name: "Another",
                role: Role::Member,
                password: None,
                must_change_password: false,
            },
        )
        .await;
    assert!(matches!(taken, Err(StoreError::EmailTaken)));
    // Signing in takes the same liberties, and finds the same person.
    let login = login(db, &ctx, " ANA.silva@example.test", PASSWORD).await;
    assert_eq!(login.unwrap().user.id, user.id);
    for bad in [
        "",
        "no-at-sign",
        "@no-name.test",
        "no-domain@",
        "a b@c.test",
        "a@b@c.test",
    ] {
        let refused = db
            .add_user(
                &ctx,
                NewUser {
                    email: bad,
                    name: "x",
                    role: Role::Member,
                    password: None,
                    must_change_password: false,
                },
            )
            .await;
        assert!(matches!(refused, Err(StoreError::InvalidEmail)), "{bad:?}");
    }
    test.stop().await;
}

#[tokio::test]
async fn a_password_must_be_long_enough_and_not_absurdly_long() {
    let (test, ctx) = start().await;
    let db = &test.db;
    for password in ["short", &"é".repeat(11), &"x".repeat(257)] {
        let refused = db
            .add_user(
                &ctx,
                NewUser {
                    email: "p@example.test",
                    name: "P",
                    role: Role::Member,
                    password: Some(password),
                    must_change_password: false,
                },
            )
            .await;
        assert!(
            matches!(refused, Err(StoreError::InvalidPassword { .. })),
            "{}",
            password.len()
        );
    }
    // Twelve characters, however many bytes they take.
    add(db, &ctx, "ok@example.test", Role::Member).await;
    let multibyte = "é".repeat(12);
    db.add_user(
        &ctx,
        NewUser {
            email: "bytes@example.test",
            name: "B",
            role: Role::Member,
            password: Some(&multibyte),
            must_change_password: false,
        },
    )
    .await
    .unwrap();
    test.stop().await;
}

#[tokio::test]
async fn only_the_right_password_of_an_enabled_user_signs_in() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let user = add(db, &ctx, "ana@example.test", Role::Admin).await;
    let invited = db
        .invite_user(&ctx, "new@example.test", "New", Role::Member, TTL)
        .await
        .unwrap();

    assert!(
        login(db, &ctx, "ana@example.test", "the wrong password")
            .await
            .is_none()
    );
    assert!(
        login(db, &ctx, "nobody@example.test", PASSWORD)
            .await
            .is_none()
    );
    assert!(login(db, &ctx, "not an address", PASSWORD).await.is_none());
    // Invited and not yet accepted: nothing to check a password against.
    assert!(
        login(db, &ctx, "new@example.test", PASSWORD)
            .await
            .is_none()
    );
    assert_eq!(invited.user.has_password, false);
    // Too long to be anyone's password: refused without hashing.
    assert!(
        login(db, &ctx, "ana@example.test", &"x".repeat(300))
            .await
            .is_none()
    );

    let granted = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    assert_eq!(granted.user.id, user.id);
    assert!(granted.token.expose().starts_with("js_"));
    assert_eq!(format!("{:?}", granted.token), "Secret(<redacted>)");

    let session = db
        .authenticate(granted.token.expose())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.user_id.as_ref(), Some(&user.id));
    assert_eq!(session.role, Some(Role::Admin));
    assert_eq!(session.tenant.as_str(), "people");
    assert!(!session.must_change_password);

    db.disable_user(&ctx, &user.id).await.unwrap().unwrap();
    assert!(
        login(db, &ctx, "ana@example.test", PASSWORD)
            .await
            .is_none()
    );
    test.stop().await;
}

#[tokio::test]
async fn disabling_a_user_ends_their_sessions_at_once_and_leaves_others_alone() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let ana = add(db, &ctx, "ana@example.test", Role::Member).await;
    add(db, &ctx, "bia@example.test", Role::Member).await;
    let first = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    let second = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    let bia = login(db, &ctx, "bia@example.test", PASSWORD).await.unwrap();

    let disabled = db.disable_user(&ctx, &ana.id).await.unwrap().unwrap();
    assert!(disabled.disabled);
    assert!(!active(db, first.token.expose()).await);
    assert!(!active(db, second.token.expose()).await);
    assert!(active(db, bia.token.expose()).await);
    // Again is not an error, and an unknown user is `None`.
    assert!(
        db.disable_user(&ctx, &ana.id)
            .await
            .unwrap()
            .unwrap()
            .disabled
    );
    assert!(
        db.disable_user(&ctx, &"usr_nobody".into_id())
            .await
            .unwrap()
            .is_none()
    );
    test.stop().await;
}

trait IntoId {
    fn into_id(self) -> jian_store::UserId;
}

impl IntoId for &str {
    fn into_id(self) -> jian_store::UserId {
        jian_store::UserId::new(self)
    }
}

#[tokio::test]
async fn a_session_expires_and_signing_out_ends_only_that_session() {
    let (test, ctx) = start().await;
    let db = &test.db;
    add(db, &ctx, "ana@example.test", Role::Member).await;
    let short = db
        .login(&ctx, "ana@example.test", PASSWORD, Duration::ZERO)
        .await
        .unwrap();
    let LoginOutcome::Granted(short) = short else {
        panic!("refused");
    };
    assert!(!active(db, short.token.expose()).await);
    assert!(
        !db.token_is_active(&TokenHash::of(short.token.expose()))
            .await
            .unwrap()
    );

    let one = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    let two = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    db.end_session(&TokenHash::of(one.token.expose()))
        .await
        .unwrap();
    assert!(!active(db, one.token.expose()).await);
    assert!(active(db, two.token.expose()).await);

    // Another kind of token is not ended by asking to end a session.
    let (_, machine_token) = db.issue_machine(&ctx, "box").await.unwrap();
    db.end_session(&TokenHash::of(machine_token.expose()))
        .await
        .unwrap();
    assert!(active(db, machine_token.expose()).await);
    test.stop().await;
}

#[tokio::test]
async fn an_admins_password_forces_a_change_and_ends_every_session() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let ana = add(db, &ctx, "ana@example.test", Role::Member).await;
    let old = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();

    let provisional = "chosen by the admin";
    let reset = db
        .reset_user_password(&ctx, &ana.id, provisional)
        .await
        .unwrap()
        .unwrap();
    assert!(reset.must_change_password);
    assert!(!active(db, old.token.expose()).await);
    assert!(
        login(db, &ctx, "ana@example.test", PASSWORD)
            .await
            .is_none()
    );

    let fresh = login(db, &ctx, "ana@example.test", provisional)
        .await
        .unwrap();
    assert!(fresh.user.must_change_password);
    let session = db
        .authenticate(fresh.token.expose())
        .await
        .unwrap()
        .unwrap();
    assert!(session.must_change_password);

    let chosen = "chosen by the person";
    db.change_password(
        &ctx,
        &ana.id,
        provisional,
        chosen,
        &TokenHash::of(fresh.token.expose()),
    )
    .await
    .unwrap();
    let session = db
        .authenticate(fresh.token.expose())
        .await
        .unwrap()
        .unwrap();
    assert!(!session.must_change_password);
    assert!(
        login(db, &ctx, "ana@example.test", provisional)
            .await
            .is_none()
    );
    assert!(login(db, &ctx, "ana@example.test", chosen).await.is_some());
    test.stop().await;
}

#[tokio::test]
async fn changing_the_password_ends_the_other_sessions_and_needs_the_current_one() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let ana = add(db, &ctx, "ana@example.test", Role::Member).await;
    let bia = add(db, &ctx, "bia@example.test", Role::Member).await;
    let here = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    let elsewhere = login(db, &ctx, "ana@example.test", PASSWORD).await.unwrap();
    let hers = login(db, &ctx, "bia@example.test", PASSWORD).await.unwrap();
    let keep = TokenHash::of(here.token.expose());

    let wrong = db
        .change_password(
            &ctx,
            &ana.id,
            "not the password",
            "another long password",
            &keep,
        )
        .await;
    assert!(matches!(wrong, Err(StoreError::WrongPassword)));
    let weak = db
        .change_password(&ctx, &ana.id, PASSWORD, "short", &keep)
        .await;
    assert!(matches!(weak, Err(StoreError::InvalidPassword { .. })));
    assert!(
        active(db, elsewhere.token.expose()).await,
        "a refusal ended a session"
    );

    db.change_password(&ctx, &ana.id, PASSWORD, "another long password", &keep)
        .await
        .unwrap();
    assert!(active(db, here.token.expose()).await);
    assert!(!active(db, elsewhere.token.expose()).await);
    assert!(
        active(db, hers.token.expose()).await,
        "someone else's session"
    );
    assert!(
        login(db, &ctx, "ana@example.test", PASSWORD)
            .await
            .is_none()
    );
    assert!(
        login(db, &ctx, "ana@example.test", "another long password")
            .await
            .is_some()
    );
    // Bia's password is not Ana's to change.
    let crossed = db
        .change_password(
            &ctx,
            &bia.id,
            "another long password",
            "x long enough pass",
            &keep,
        )
        .await;
    assert!(matches!(crossed, Err(StoreError::WrongPassword)));
    test.stop().await;
}

#[tokio::test]
async fn an_invitation_works_once_and_signs_the_person_in() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let invite = db
        .invite_user(&ctx, "New@Example.test", "New", Role::Member, TTL)
        .await
        .unwrap();
    assert_eq!(invite.user.email, "new@example.test");
    assert!(invite.token.expose().starts_with("ji_"));

    // A password that is refused does not spend the invitation.
    let weak = db
        .accept_invite(&ctx, invite.token.expose(), "short", TTL)
        .await;
    assert!(matches!(weak, Err(StoreError::InvalidPassword { .. })));

    let accepted = db
        .accept_invite(&ctx, invite.token.expose(), "the chosen password", TTL)
        .await
        .unwrap();
    assert_eq!(accepted.user.id, invite.user.id);
    assert!(accepted.user.has_password && !accepted.user.must_change_password);
    assert!(active(db, accepted.token.expose()).await);

    let again = db
        .accept_invite(&ctx, invite.token.expose(), "another password here", TTL)
        .await;
    assert!(matches!(again, Err(StoreError::InvalidInvite)));
    // The first password stands.
    assert!(
        login(db, &ctx, "new@example.test", "the chosen password")
            .await
            .is_some()
    );
    // The token is a hash in the database, not the text.
    let nothing = db
        .accept_invite(&ctx, "ji_made_up", "the chosen password", TTL)
        .await;
    assert!(matches!(nothing, Err(StoreError::InvalidInvite)));
    test.stop().await;
}

#[tokio::test]
async fn an_expired_invitation_and_one_cancelled_by_a_reset_fail() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let expired = db
        .invite_user(
            &ctx,
            "late@example.test",
            "Late",
            Role::Member,
            Duration::ZERO,
        )
        .await
        .unwrap();
    let late = db
        .accept_invite(&ctx, expired.token.expose(), "the chosen password", TTL)
        .await;
    assert!(matches!(late, Err(StoreError::InvalidInvite)));

    let reset = db
        .invite_user(&ctx, "reset@example.test", "Reset", Role::Member, TTL)
        .await
        .unwrap();
    db.reset_user_password(&ctx, &reset.user.id, "chosen by the admin")
        .await
        .unwrap()
        .unwrap();
    let after = db
        .accept_invite(&ctx, reset.token.expose(), "the chosen password", TTL)
        .await;
    assert!(matches!(after, Err(StoreError::InvalidInvite)));

    let disabled = db
        .invite_user(&ctx, "gone@example.test", "Gone", Role::Member, TTL)
        .await
        .unwrap();
    db.disable_user(&ctx, &disabled.user.id)
        .await
        .unwrap()
        .unwrap();
    let gone = db
        .accept_invite(&ctx, disabled.token.expose(), "the chosen password", TTL)
        .await;
    assert!(matches!(gone, Err(StoreError::InvalidInvite)));
    test.stop().await;
}

#[tokio::test]
async fn an_invitation_taken_by_two_at_once_is_taken_by_one() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let invite = db
        .invite_user(&ctx, "race@example.test", "Race", Role::Member, TTL)
        .await
        .unwrap();
    let token = invite.token.expose();
    let (a, b) = tokio::join!(
        db.accept_invite(&ctx, token, "the first password", TTL),
        db.accept_invite(&ctx, token, "the second password", TTL),
    );
    assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1, "{a:?} {b:?}");
    test.stop().await;
}

#[tokio::test]
async fn the_first_admin_is_made_once_even_when_two_ask_at_once() {
    let (test, ctx) = start().await;
    let db = &test.db;
    let (a, b) = tokio::join!(
        db.create_first_admin(&ctx, "one@example.test", "One", Some(PASSWORD)),
        db.create_first_admin(&ctx, "two@example.test", "Two", None),
    );
    assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1, "{a:?} {b:?}");
    let refused = a.err().or(b.err()).unwrap();
    assert!(matches!(refused, StoreError::UsersExist));
    let page = db.list_users(&ctx, None, 10).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].role, Role::Admin);
    test.stop().await;
}

#[tokio::test]
async fn users_are_listed_in_pages_without_their_hashes() {
    let (test, ctx) = start().await;
    let db = &test.db;
    for n in 0..3 {
        add(db, &ctx, &format!("user{n}@example.test"), Role::Member).await;
    }
    let first = db.list_users(&ctx, None, 2).await.unwrap();
    assert_eq!(first.items.len(), 2);
    let next = first.next.unwrap();
    let rest = db.list_users(&ctx, Some(next), 2).await.unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.next, None);
    assert_eq!(rest.items[0].email, "user2@example.test");
    // A session token of a kind nobody asked for is not a user token.
    assert!(
        generate_token(TokenKind::Session)
            .unwrap()
            .expose()
            .starts_with("js_")
    );
    test.stop().await;
}
