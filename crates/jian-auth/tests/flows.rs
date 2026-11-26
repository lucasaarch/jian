//! The sign-in flows against a real Postgres: that every way to be refused is one error and costs
//! about one hash, what a password change and a reset do to sessions, how an invitation meets an
//! account that already exists, and that a policy without a password closes all of it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use jian_auth::{
    AcceptInvite, AddMember, Auth, AuthError, AuthPolicy, CredentialKind, LoginOutcome,
    LoginRequest, PasswordParams, Role, Session,
};
use jian_store::{Database, NewMember, StoreError, TenantCtx, TenantId, TokenHash};
use jian_testkit::TestDb;

const PASSWORD: &str = "correct horse battery staple";
const OTHER: &str = "another long passphrase";

fn auth() -> Auth {
    Auth::new(
        AuthPolicy::self_hosted(),
        PasswordParams::insecure_for_tests(),
    )
}

/// Tenant roles belong to the server that all the tests' databases share, so the name gets a
/// random tail: `alpha` in two tests at once would collide.
async fn tenant(db: &Database, name: &str) -> TenantCtx {
    let id = TenantId::parse(&format!("{name}{}", jian_testkit::unique())).unwrap();
    db.create_tenant(&id).await.unwrap();
    db.tenant(id).await.unwrap()
}

async fn sign_in(
    auth: &Auth,
    db: &Database,
    email: &str,
    password: &str,
    tenant: Option<&TenantId>,
) -> Result<Session, AuthError> {
    match auth
        .login(
            db,
            LoginRequest {
                email,
                password,
                tenant,
            },
        )
        .await?
    {
        LoginOutcome::Session(session) => Ok(session),
        _ => panic!("a step this test does not know"),
    }
}

async fn alive(db: &Database, session: &Session) -> bool {
    db.authenticate(session.token.expose())
        .await
        .unwrap()
        .is_some()
}

/// An admin with the password they chose, the way the command line makes the first one.
async fn first_admin(auth: &Auth, db: &Database, ctx: &TenantCtx, email: &str) {
    auth.add_first_admin(db, ctx, email, None, PASSWORD)
        .await
        .unwrap();
}

#[tokio::test]
async fn every_way_to_be_refused_is_the_same_error() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let (db, auth) = (&test.db, auth());
    let ctx = tenant(db, "alpha").await;
    let other = tenant(db, "beta").await;
    first_admin(&auth, db, &ctx, "pat@example.test").await;
    auth.add_member(
        db,
        &ctx,
        AddMember {
            email: "off@example.test",
            name: None,
            role: Role::Member,
            password: PASSWORD,
            invited_by: None,
        },
    )
    .await
    .unwrap();
    let off = db
        .member_by_email(&ctx, "off@example.test")
        .await
        .unwrap()
        .unwrap();
    // An account with no password at all, as the Cloud's would be.
    db.add_member(
        &ctx,
        NewMember {
            email: "link@example.test",
            name: None,
            role: Role::Member,
            invited_by: None,
            password_hash: None,
            must_change: false,
        },
    )
    .await
    .unwrap();
    db.disable_member(&ctx, &off.account_id).await.unwrap();
    let gone = auth
        .add_member(
            db,
            &ctx,
            AddMember {
                email: "gone@example.test",
                name: None,
                role: Role::Member,
                password: PASSWORD,
                invited_by: None,
            },
        )
        .await
        .unwrap();
    db.disable_account(&gone.member.account_id).await.unwrap();

    let attempts = [
        ("pat@example.test", "not the password", None),
        ("nobody@example.test", PASSWORD, None),
        ("not an address", PASSWORD, None),
        ("", "", None),
        ("link@example.test", PASSWORD, None),
        ("off@example.test", PASSWORD, None),
        ("gone@example.test", PASSWORD, None),
        // Right password, a workspace they are not in.
        ("pat@example.test", PASSWORD, Some(other.id())),
    ];
    for (email, password, tenant) in attempts {
        let error = sign_in(&auth, db, email, password, tenant)
            .await
            .unwrap_err();
        assert!(
            matches!(error, AuthError::InvalidCredentials),
            "{email}: {error:?}"
        );
    }
    // Longer than a password may be: refused the same, before any hashing.
    let long = "a".repeat(100_000);
    assert!(matches!(
        sign_in(&auth, db, "pat@example.test", &long, None).await,
        Err(AuthError::InvalidCredentials)
    ));
    // The address is read without case or margins.
    let session = sign_in(&auth, db, "  PAT@Example.test ", PASSWORD, None)
        .await
        .unwrap();
    assert_eq!(session.tenant.as_str(), ctx.id().as_str());
    assert_eq!(session.member.email, "pat@example.test");
    assert!(alive(db, &session).await);
    test.stop().await;
}

/// The middle of five timings of a refused sign-in.
async fn median(auth: &Auth, db: &Database, email: &str) -> Duration {
    let mut times = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        assert!(
            sign_in(auth, db, email, "not the password", None)
                .await
                .is_err()
        );
        times.push(start.elapsed());
    }
    times.sort();
    times[2]
}

#[tokio::test]
async fn an_unknown_address_costs_what_a_wrong_password_costs() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let db = &test.db;
    // The real cost, which is what makes a missing hash visible.
    let auth = Auth::new(AuthPolicy::self_hosted(), PasswordParams::default());
    let ctx = tenant(db, "alpha").await;
    first_admin(&auth, db, &ctx, "pat@example.test").await;
    db.add_member(
        &ctx,
        NewMember {
            email: "link@example.test",
            name: None,
            role: Role::Member,
            invited_by: None,
            password_hash: None,
            must_change: false,
        },
    )
    .await
    .unwrap();

    let wrong = median(&auth, db, "pat@example.test").await;
    let unknown = median(&auth, db, "nobody@example.test").await;
    let no_password = median(&auth, db, "link@example.test").await;
    for (name, time) in [("unknown", unknown), ("no password", no_password)] {
        let ratio = time.as_secs_f64() / wrong.as_secs_f64();
        assert!(
            (0.5..2.0).contains(&ratio),
            "{name} took {time:?} and a wrong password {wrong:?}"
        );
    }
    test.stop().await;
}

#[tokio::test]
async fn an_account_in_several_workspaces_must_say_which() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let (db, auth) = (&test.db, auth());
    let a = tenant(db, "alpha").await;
    let b = tenant(db, "beta").await;
    first_admin(&auth, db, &a, "pat@example.test").await;
    // Added to the second workspace by its admin, with a password that is ignored.
    first_admin(&auth, db, &b, "boss@example.test").await;
    let added = auth
        .add_member(
            db,
            &b,
            AddMember {
                email: "pat@example.test",
                name: None,
                role: Role::Member,
                password: OTHER,
                invited_by: None,
            },
        )
        .await
        .unwrap();
    assert!(!added.account_created);

    assert!(matches!(
        sign_in(&auth, db, "pat@example.test", PASSWORD, None).await,
        Err(AuthError::TenantRequired)
    ));
    // The ignored password does not work; the account's own does, in both.
    assert!(matches!(
        sign_in(&auth, db, "pat@example.test", OTHER, Some(b.id())).await,
        Err(AuthError::InvalidCredentials)
    ));
    // A wrong password never learns the account has two workspaces.
    assert!(matches!(
        sign_in(&auth, db, "pat@example.test", OTHER, None).await,
        Err(AuthError::InvalidCredentials)
    ));
    let in_a = sign_in(&auth, db, "pat@example.test", PASSWORD, Some(a.id()))
        .await
        .unwrap();
    let in_b = sign_in(&auth, db, "pat@example.test", PASSWORD, Some(b.id()))
        .await
        .unwrap();
    assert_eq!(in_a.member.role, Role::Admin);
    assert_eq!(in_b.member.role, Role::Member);
    assert_eq!(in_a.member.account_id, in_b.member.account_id);
    assert_eq!(
        db.authenticate(in_b.token.expose())
            .await
            .unwrap()
            .unwrap()
            .tenant
            .as_str(),
        b.id().as_str()
    );

    // Changing the password ends the other session, in the other workspace, and keeps this one.
    auth.change_password(
        db,
        &in_a.member.account_id,
        PASSWORD,
        OTHER,
        &TokenHash::of(in_a.token.expose()),
    )
    .await
    .unwrap();
    assert!(alive(db, &in_a).await);
    assert!(!alive(db, &in_b).await);
    assert!(
        sign_in(&auth, db, "pat@example.test", PASSWORD, Some(a.id()))
            .await
            .is_err()
    );
    assert!(
        sign_in(&auth, db, "pat@example.test", OTHER, Some(b.id()))
            .await
            .is_ok()
    );
    test.stop().await;
}

#[tokio::test]
async fn a_password_an_admin_chose_must_be_changed_and_changing_it_checks_the_old_one() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let (db, auth) = (&test.db, auth());
    let ctx = tenant(db, "alpha").await;
    first_admin(&auth, db, &ctx, "boss@example.test").await;
    // The admin's own password is theirs: no flag.
    let boss = sign_in(&auth, db, "boss@example.test", PASSWORD, None)
        .await
        .unwrap();
    assert!(!boss.member.must_change_password);

    let admin = db
        .member_by_email(&ctx, "boss@example.test")
        .await
        .unwrap()
        .unwrap();
    let added = auth
        .add_member(
            db,
            &ctx,
            AddMember {
                email: "kim@example.test",
                name: Some("Kim"),
                role: Role::Member,
                password: PASSWORD,
                invited_by: Some(&admin.account_id),
            },
        )
        .await
        .unwrap();
    assert!(added.account_created);
    assert_eq!(added.member.invited_by, Some(admin.account_id.clone()));
    assert!(added.member.must_change_password);
    // A weak provisional password is refused and makes no account.
    assert!(matches!(
        auth.add_member(
            db,
            &ctx,
            AddMember {
                email: "weak@example.test",
                name: None,
                role: Role::Member,
                password: "short",
                invited_by: None,
            },
        )
        .await,
        Err(AuthError::InvalidPassword { .. })
    ));
    assert!(
        db.account_by_email("weak@example.test")
            .await
            .unwrap()
            .is_none()
    );
    // Twice is refused.
    assert!(matches!(
        auth.add_member(
            db,
            &ctx,
            AddMember {
                email: "KIM@example.test",
                name: None,
                role: Role::Member,
                password: PASSWORD,
                invited_by: None,
            },
        )
        .await,
        Err(AuthError::Store(StoreError::MemberExists))
    ));

    let kim = sign_in(&auth, db, "kim@example.test", PASSWORD, None)
        .await
        .unwrap();
    assert!(kim.member.must_change_password);
    let found = db.authenticate(kim.token.expose()).await.unwrap().unwrap();
    assert!(found.must_change_password);

    let keep = TokenHash::of(kim.token.expose());
    let id = &kim.member.account_id;
    assert!(matches!(
        auth.change_password(db, id, "wrong password here", OTHER, &keep)
            .await,
        Err(AuthError::WrongPassword)
    ));
    assert!(matches!(
        auth.change_password(db, id, PASSWORD, "short", &keep).await,
        Err(AuthError::InvalidPassword { .. })
    ));
    assert!(alive(db, &kim).await);
    auth.change_password(db, id, PASSWORD, OTHER, &keep)
        .await
        .unwrap();
    let after = db.authenticate(kim.token.expose()).await.unwrap().unwrap();
    assert!(!after.must_change_password);
    assert!(
        sign_in(&auth, db, "kim@example.test", PASSWORD, None)
            .await
            .is_err()
    );
    assert!(
        !sign_in(&auth, db, "kim@example.test", OTHER, None)
            .await
            .unwrap()
            .member
            .must_change_password
    );
    test.stop().await;
}

#[tokio::test]
async fn the_first_admin_comes_once_and_a_reset_is_refused_for_a_shared_account() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let (db, auth) = (&test.db, auth());
    let a = tenant(db, "alpha").await;
    let b = tenant(db, "beta").await;
    first_admin(&auth, db, &a, "boss@example.test").await;
    assert!(matches!(
        auth.add_first_admin(db, &a, "late@example.test", None, PASSWORD)
            .await,
        Err(AuthError::Store(StoreError::TenantHasMembers))
    ));
    let kim = auth
        .add_member(
            db,
            &a,
            AddMember {
                email: "kim@example.test",
                name: None,
                role: Role::Member,
                password: PASSWORD,
                invited_by: None,
            },
        )
        .await
        .unwrap();
    let kim_id = kim.member.account_id;
    let before = sign_in(&auth, db, "kim@example.test", PASSWORD, None)
        .await
        .unwrap();

    // Rejected passwords change nothing.
    assert!(matches!(
        auth.reset_password(db, &a, &kim_id, "short").await,
        Err(AuthError::InvalidPassword { .. })
    ));
    assert!(alive(db, &before).await);
    // Another workspace's admin cannot reach them.
    assert!(
        auth.reset_password(db, &b, &kim_id, OTHER)
            .await
            .unwrap()
            .is_none()
    );

    let reset = auth
        .reset_password(db, &a, &kim_id, OTHER)
        .await
        .unwrap()
        .unwrap();
    assert!(reset.must_change_password);
    assert!(!alive(db, &before).await);
    assert!(
        sign_in(&auth, db, "kim@example.test", PASSWORD, None)
            .await
            .is_err()
    );
    assert!(
        sign_in(&auth, db, "kim@example.test", OTHER, None)
            .await
            .unwrap()
            .member
            .must_change_password
    );

    // Once the person is in another workspace too, the admin of the first can no longer reset.
    first_admin(&auth, db, &b, "other-boss@example.test").await;
    auth.add_member(
        db,
        &b,
        AddMember {
            email: "kim@example.test",
            name: None,
            role: Role::Member,
            password: PASSWORD,
            invited_by: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        auth.reset_password(db, &a, &kim_id, PASSWORD).await,
        Err(AuthError::Store(StoreError::AccountInOtherTenants))
    ));
    assert!(
        sign_in(&auth, db, "kim@example.test", OTHER, Some(a.id()))
            .await
            .is_ok()
    );
    test.stop().await;
}

#[tokio::test]
async fn an_invitation_makes_an_account_or_proves_the_one_that_exists() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let (db, auth) = (&test.db, auth());
    let a = tenant(db, "alpha").await;
    let b = tenant(db, "beta").await;
    first_admin(&auth, db, &a, "pat@example.test").await;
    let accept = |token: &'static str, password: &'static str| AcceptInvite {
        token,
        password,
        name: None,
    };

    // A new address: it chooses its password, which must be a password.
    let invite = auth
        .invite(db, &a, "New@Example.test", Role::Member, None)
        .await
        .unwrap();
    let token = invite.token.expose().to_owned();
    let leaked: &'static str = Box::leak(token.clone().into_boxed_str());
    assert!(matches!(
        auth.accept_invite(db, accept(leaked, "short")).await,
        Err(AuthError::InvalidPassword { .. })
    ));
    let session = auth.accept_invite(db, accept(leaked, OTHER)).await.unwrap();
    assert_eq!(session.member.email, "new@example.test");
    assert_eq!(session.tenant.as_str(), a.id().as_str());
    assert!(!session.member.must_change_password);
    assert!(alive(db, &session).await);
    assert!(
        sign_in(&auth, db, "new@example.test", OTHER, None)
            .await
            .is_ok()
    );
    // It worked once.
    assert!(matches!(
        auth.accept_invite(db, accept(leaked, OTHER)).await,
        Err(AuthError::InvalidInvite)
    ));

    // An address with an account: the invitation needs that account's password and sets none.
    let invite = auth
        .invite(db, &b, "pat@example.test", Role::Admin, None)
        .await
        .unwrap();
    let leaked: &'static str = Box::leak(invite.token.expose().to_owned().into_boxed_str());
    assert!(matches!(
        auth.accept_invite(db, accept(leaked, "not the password"))
            .await,
        Err(AuthError::InvalidCredentials)
    ));
    // The refusal did not spend it.
    assert_eq!(db.list_invites(&b).await.unwrap().len(), 1);
    let session = auth
        .accept_invite(db, accept(leaked, PASSWORD))
        .await
        .unwrap();
    assert_eq!(session.tenant.as_str(), b.id().as_str());
    assert_eq!(session.member.role, Role::Admin);
    // Still the password the account had.
    assert!(
        sign_in(&auth, db, "pat@example.test", PASSWORD, Some(b.id()))
            .await
            .is_ok()
    );

    // Nonsense and a made-up token are the same refusal; the new invitation replaces the old.
    for token in ["", "nothing", &"x".repeat(5000)] {
        let token: &'static str = Box::leak(token.to_owned().into_boxed_str());
        assert!(matches!(
            auth.accept_invite(db, accept(token, OTHER)).await,
            Err(AuthError::InvalidInvite)
        ));
    }
    let old = auth
        .invite(db, &a, "later@example.test", Role::Member, None)
        .await
        .unwrap();
    let new = auth
        .invite(db, &a, "later@example.test", Role::Member, None)
        .await
        .unwrap();
    let old: &'static str = Box::leak(old.token.expose().to_owned().into_boxed_str());
    assert!(matches!(
        auth.accept_invite(db, accept(old, OTHER)).await,
        Err(AuthError::InvalidInvite)
    ));
    let new: &'static str = Box::leak(new.token.expose().to_owned().into_boxed_str());
    assert!(auth.accept_invite(db, accept(new, OTHER)).await.is_ok());
    test.stop().await;
}

#[tokio::test]
async fn an_invitation_that_ran_out_is_refused() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let db = &test.db;
    let auth = auth().with_invite_ttl(Duration::from_millis(200));
    let a = tenant(db, "alpha").await;
    let invite = auth
        .invite(db, &a, "late@example.test", Role::Member, None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(matches!(
        auth.accept_invite(
            db,
            AcceptInvite {
                token: invite.token.expose(),
                password: OTHER,
                name: None
            }
        )
        .await,
        Err(AuthError::InvalidInvite)
    ));
    test.stop().await;
}

#[tokio::test]
async fn a_policy_without_a_password_closes_every_password_flow() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let db = &test.db;
    let cloud = Auth::new(AuthPolicy::cloud(), PasswordParams::insecure_for_tests());
    let a = tenant(db, "alpha").await;
    first_admin(&auth(), db, &a, "pat@example.test").await;
    let member = db
        .member_by_email(&a, "pat@example.test")
        .await
        .unwrap()
        .unwrap();
    let id = &member.account_id;
    let disabled = |result: Result<(), AuthError>| {
        assert!(
            matches!(
                result,
                Err(AuthError::MethodDisabled(CredentialKind::Password))
            ),
            "{result:?}"
        );
    };
    disabled(
        sign_in(&cloud, db, "pat@example.test", PASSWORD, None)
            .await
            .map(drop),
    );
    disabled(
        cloud
            .add_first_admin(db, &a, "x@example.test", None, PASSWORD)
            .await
            .map(drop),
    );
    disabled(
        cloud
            .add_member(
                db,
                &a,
                AddMember {
                    email: "x@example.test",
                    name: None,
                    role: Role::Member,
                    password: PASSWORD,
                    invited_by: None,
                },
            )
            .await
            .map(drop),
    );
    disabled(
        cloud
            .change_password(db, id, PASSWORD, OTHER, &TokenHash::of("x"))
            .await,
    );
    disabled(cloud.reset_password(db, &a, id, OTHER).await.map(drop));
    disabled(
        cloud
            .accept_invite(
                db,
                AcceptInvite {
                    token: "x",
                    password: OTHER,
                    name: None,
                },
            )
            .await
            .map(drop),
    );
    assert!(
        db.account_by_email("x@example.test")
            .await
            .unwrap()
            .is_none()
    );
    test.stop().await;
}
