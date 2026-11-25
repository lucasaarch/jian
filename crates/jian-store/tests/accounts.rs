//! Accounts, members, sessions and invitations against a real Postgres: that one person is one
//! account in every tenant, what each way of ending a session cuts, that an invitation works
//! once even when two race for it, and that one tenant reaches nothing of another's. The store
//! keeps hashes and never makes them, so these tests use text where a hash would be.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::time::Duration;

use jian_store::{
    AddedMember, Database, NewAccount, NewMember, Role, SendOutcome, SendStatus, StoreError,
    TenantCtx, TokenHash,
};
use support::{Server, tenant};

const TTL: Duration = Duration::from_secs(3600);
const HASH: &str = "$argon2id$stand-in-for-a-hash";

async fn migrated(server: &Server) -> Database {
    let db = server.connect().await;
    db.migrate().await.unwrap();
    db
}

async fn add(db: &Database, ctx: &TenantCtx, email: &str, role: Role) -> AddedMember {
    db.add_member(
        ctx,
        NewMember {
            email,
            name: None,
            role,
            invited_by: None,
            password_hash: Some(HASH),
            must_change: false,
        },
    )
    .await
    .unwrap()
}

async fn session(db: &Database, ctx: &TenantCtx, added: &AddedMember) -> String {
    db.start_session(ctx, &added.member.account_id, TTL)
        .await
        .unwrap()
        .token
        .expose()
        .to_owned()
}

async fn alive(db: &Database, token: &str) -> bool {
    db.authenticate(token).await.unwrap().is_some()
}

#[tokio::test]
async fn one_address_is_one_account_in_every_tenant_and_keeps_its_own_password() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;

    let first = add(&db, &a, "  Pat@Example.TEST ", Role::Admin).await;
    assert!(first.account_created);
    assert_eq!(first.member.email, "pat@example.test");
    assert_eq!(first.member.name, "pat");

    // Adding the same person to another tenant reuses the account and does not touch the
    // credentials, whatever password is offered.
    let second = db
        .add_member(
            &b,
            NewMember {
                email: "PAT@example.test",
                name: Some("Someone else"),
                role: Role::Member,
                invited_by: None,
                password_hash: Some("$argon2id$another"),
                must_change: true,
            },
        )
        .await
        .unwrap();
    assert!(!second.account_created);
    assert_eq!(second.member.account_id, first.member.account_id);
    assert_eq!(second.member.name, "pat");
    assert_eq!(second.member.role, Role::Member);
    assert!(!second.member.must_change_password);
    let credential = db
        .password_credential(&first.member.account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credential.hash.expose(), HASH);

    // Twice in the same tenant is refused.
    let again = db
        .add_member(
            &a,
            NewMember {
                email: "pat@example.test",
                name: None,
                role: Role::Member,
                invited_by: None,
                password_hash: None,
                must_change: false,
            },
        )
        .await;
    assert!(matches!(again, Err(StoreError::MemberExists)));

    let found = db
        .login_candidate(" PAT@example.test")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.tenants.len(), 2);
    assert!(
        db.login_candidate("nobody@example.test")
            .await
            .unwrap()
            .is_none()
    );
    server.stop().await;
}

#[tokio::test]
async fn only_the_first_admin_can_be_first_even_when_two_race() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let ctx = tenant(&db, "alpha").await;
    let new = |email| NewMember {
        email,
        name: None,
        role: Role::Member,
        invited_by: None,
        password_hash: Some(HASH),
        must_change: false,
    };
    let (one, two) = tokio::join!(
        db.add_first_admin(&ctx, new("one@example.test")),
        db.add_first_admin(&ctx, new("two@example.test")),
    );
    let outcomes = [one, two];
    assert_eq!(outcomes.iter().filter(|o| o.is_ok()).count(), 1);
    assert!(
        outcomes
            .iter()
            .any(|o| matches!(o, Err(StoreError::TenantHasMembers)))
    );
    // Whoever won is an admin whatever role was asked for.
    let page = db.list_members(&ctx, None, 10).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].role, Role::Admin);
    server.stop().await;
}

#[tokio::test]
async fn a_session_opens_one_tenant_and_stops_with_its_member_or_account() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let in_a = add(&db, &a, "pat@example.test", Role::Admin).await;
    let in_b = add(&db, &b, "pat@example.test", Role::Member).await;
    let other = add(&db, &a, "kim@example.test", Role::Member).await;
    let token_a = session(&db, &a, &in_a).await;
    let token_b = session(&db, &b, &in_b).await;
    let token_other = session(&db, &a, &other).await;

    let found = db.authenticate(&token_a).await.unwrap().unwrap();
    assert_eq!(found.tenant, *a.id());
    assert_eq!(found.role, Some(Role::Admin));
    assert_eq!(found.account_id, Some(in_a.member.account_id.clone()));
    assert!(!found.must_change_password);
    assert_eq!(
        db.authenticate(&token_b).await.unwrap().unwrap().role,
        Some(Role::Member)
    );

    // Disabling the member cuts their sessions in this tenant and only there.
    let disabled = db
        .disable_member(&a, &in_a.member.account_id)
        .await
        .unwrap()
        .unwrap();
    assert!(disabled.disabled);
    assert!(!alive(&db, &token_a).await);
    assert!(alive(&db, &token_b).await);
    assert!(alive(&db, &token_other).await);
    // Twice is not an error, and a tenant cannot disable a stranger.
    assert!(
        db.disable_member(&a, &in_a.member.account_id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        db.disable_member(&a, &in_b.member.account_id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        db.disable_member(&b, &other.member.account_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(alive(&db, &token_other).await);

    // A session started after the member was disabled is no session.
    let late = session(&db, &a, &in_a).await;
    assert!(!alive(&db, &late).await);

    // Disabling the account cuts every tenant.
    db.disable_account(&in_b.member.account_id)
        .await
        .unwrap()
        .unwrap();
    assert!(!alive(&db, &token_b).await);
    let candidate = db
        .login_candidate("pat@example.test")
        .await
        .unwrap()
        .unwrap();
    assert!(candidate.account.disabled);

    // Logging out ends that session alone.
    db.end_session(&TokenHash::of(&token_other)).await.unwrap();
    assert!(!alive(&db, &token_other).await);
    server.stop().await;
}

#[tokio::test]
async fn a_session_ends_when_its_time_does() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let ctx = tenant(&db, "alpha").await;
    let member = add(&db, &ctx, "pat@example.test", Role::Member).await;
    let short = db
        .start_session(&ctx, &member.member.account_id, Duration::from_millis(200))
        .await
        .unwrap();
    assert!(alive(&db, short.token.expose()).await);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!alive(&db, short.token.expose()).await);
    assert!(
        !db.token_is_active(&TokenHash::of(short.token.expose()))
            .await
            .unwrap()
    );
    server.stop().await;
}

#[tokio::test]
async fn changing_a_password_ends_the_other_sessions_in_every_tenant() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let in_a = add(&db, &a, "pat@example.test", Role::Member).await;
    let in_b = add(&db, &b, "pat@example.test", Role::Member).await;
    let stranger = add(&db, &a, "kim@example.test", Role::Member).await;
    let mine = session(&db, &a, &in_a).await;
    let elsewhere = session(&db, &b, &in_b).await;
    let theirs = session(&db, &a, &stranger).await;
    let account = &in_a.member.account_id;

    let old = db.password_credential(account).await.unwrap().unwrap();
    // Somebody else's session is not the one to keep, and a stale "old" loses.
    let stale = jian_store::secrets::Secret::new("$argon2id$not-the-current-one".to_owned());
    assert!(
        !db.replace_password(account, &stale, "$argon2id$new", &TokenHash::of(&mine))
            .await
            .unwrap()
    );
    assert!(alive(&db, &elsewhere).await);

    assert!(
        db.replace_password(account, &old.hash, "$argon2id$new", &TokenHash::of(&mine))
            .await
            .unwrap()
    );
    assert!(alive(&db, &mine).await);
    assert!(!alive(&db, &elsewhere).await);
    assert!(alive(&db, &theirs).await);
    let now = db.password_credential(account).await.unwrap().unwrap();
    assert_eq!(now.hash.expose(), "$argon2id$new");
    assert!(!now.must_change);
    server.stop().await;
}

#[tokio::test]
async fn an_admin_resets_only_a_password_that_is_only_used_in_their_tenant() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let alone = add(&db, &a, "alone@example.test", Role::Member).await;
    let shared = add(&db, &a, "shared@example.test", Role::Member).await;
    add(&db, &b, "shared@example.test", Role::Member).await;
    let token = session(&db, &a, &alone).await;

    // A member of another tenant is "no such member", and a shared account is refused.
    assert!(
        db.reset_password(&b, &alone.member.account_id, "$argon2id$reset")
            .await
            .unwrap()
            .is_none()
    );
    assert!(alive(&db, &token).await);
    let refused = db
        .reset_password(&a, &shared.member.account_id, "$argon2id$reset")
        .await;
    assert!(matches!(refused, Err(StoreError::AccountInOtherTenants)));
    let kept = db
        .password_credential(&shared.member.account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.hash.expose(), HASH);

    let reset = db
        .reset_password(&a, &alone.member.account_id, "$argon2id$reset")
        .await
        .unwrap()
        .unwrap();
    assert!(reset.must_change_password);
    assert!(!alive(&db, &token).await);
    // A session started now carries the flag.
    let after = session(&db, &a, &alone).await;
    assert!(
        db.authenticate(&after)
            .await
            .unwrap()
            .unwrap()
            .must_change_password
    );
    server.stop().await;
}

#[tokio::test]
async fn an_invitation_works_once_and_a_new_one_replaces_the_old() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;

    let first = db
        .create_invite(&a, "New@Example.test", Role::Member, None, TTL)
        .await
        .unwrap();
    assert_eq!(first.invite.email, "new@example.test");
    assert_eq!(db.list_invites(&a).await.unwrap().len(), 1);
    // Another tenant sees none of it and cannot revoke it.
    assert!(db.list_invites(&b).await.unwrap().is_empty());
    assert!(!db.revoke_invite(&b, &first.invite.id).await.unwrap());

    // Asking again revokes the first.
    let second = db
        .create_invite(&a, "new@example.test", Role::Admin, None, TTL)
        .await
        .unwrap();
    assert_ne!(first.invite.id, second.invite.id);
    assert_eq!(db.list_invites(&a).await.unwrap().len(), 1);
    let old = TokenHash::of(first.token.expose());
    assert!(db.live_invite(&old).await.unwrap().is_none());
    let new_account = || NewAccount {
        name: "New",
        password_hash: Some(HASH),
        must_change: false,
    };
    assert!(matches!(
        db.accept_invite(&old, Some(new_account())).await,
        Err(StoreError::InvalidInvite)
    ));

    // Two people with the same token: one gets in.
    let token = TokenHash::of(second.token.expose());
    let (one, two) = tokio::join!(
        db.accept_invite(&token, Some(new_account())),
        db.accept_invite(&token, Some(new_account())),
    );
    let outcomes = [one, two];
    assert_eq!(outcomes.iter().filter(|o| o.is_ok()).count(), 1);
    let won = outcomes.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(won.tenant, *a.id());
    assert_eq!(won.member.role, Role::Admin);
    assert!(won.account_created);
    assert!(db.list_invites(&a).await.unwrap().is_empty());

    // They are a member now, so inviting them again is refused.
    let member = db
        .create_invite(&a, "new@example.test", Role::Member, None, TTL)
        .await;
    assert!(matches!(member, Err(StoreError::MemberExists)));
    server.stop().await;
}

#[tokio::test]
async fn an_expired_or_revoked_invitation_is_the_same_refusal_as_an_unknown_one() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let accept = |token: &str| {
        let token = TokenHash::of(token);
        let db = &db;
        async move {
            db.accept_invite(
                &token,
                Some(NewAccount {
                    name: "New",
                    password_hash: Some(HASH),
                    must_change: false,
                }),
            )
            .await
        }
    };
    let short = db
        .create_invite(
            &a,
            "late@example.test",
            Role::Member,
            None,
            Duration::from_millis(200),
        )
        .await
        .unwrap();
    let revoked = db
        .create_invite(&a, "revoked@example.test", Role::Member, None, TTL)
        .await
        .unwrap();
    assert!(db.revoke_invite(&a, &revoked.invite.id).await.unwrap());
    tokio::time::sleep(Duration::from_millis(400)).await;
    for token in [short.token.expose(), revoked.token.expose(), "never-issued"] {
        assert!(matches!(
            accept(token).await,
            Err(StoreError::InvalidInvite)
        ));
    }
    assert!(db.list_invites(&a).await.unwrap().is_empty());
    server.stop().await;
}

#[tokio::test]
async fn accepting_with_an_existing_account_adds_the_member_and_changes_no_credential() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let home = add(&db, &a, "pat@example.test", Role::Admin).await;
    let invite = db
        .create_invite(&b, "pat@example.test", Role::Member, None, TTL)
        .await
        .unwrap();
    // Nothing to make an account of, and none needed.
    let accepted = db
        .accept_invite(&TokenHash::of(invite.token.expose()), None)
        .await
        .unwrap();
    assert!(!accepted.account_created);
    assert_eq!(accepted.member.account_id, home.member.account_id);
    let credential = db
        .password_credential(&home.member.account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credential.hash.expose(), HASH);

    // A disabled account cannot take an invitation, and the invitation is not spent.
    let kim = add(&db, &a, "kim@example.test", Role::Member).await;
    db.disable_account(&kim.member.account_id).await.unwrap();
    let for_kim = db
        .create_invite(&b, "kim@example.test", Role::Member, None, TTL)
        .await
        .unwrap();
    assert!(matches!(
        db.accept_invite(&TokenHash::of(for_kim.token.expose()), None)
            .await,
        Err(StoreError::InvalidInvite)
    ));
    assert_eq!(db.list_invites(&b).await.unwrap().len(), 1);
    server.stop().await;
}

#[tokio::test]
async fn a_new_token_keeps_the_invitation_and_a_stale_send_never_overwrites_a_newer_one() {
    let server = Server::start().await;
    let db = migrated(&server).await;
    let a = tenant(&db, "alpha").await;
    let b = tenant(&db, "beta").await;
    let made = db
        .create_invite(&a, "new@example.test", Role::Member, None, TTL)
        .await
        .unwrap();
    let id = made.invite.id.clone();
    assert_eq!(made.invite.send_status, SendStatus::Unsent);

    // Another tenant can neither replace the token, queue a send nor record one.
    assert!(
        db.rotate_invite(&b, &id, TTL, true)
            .await
            .unwrap()
            .is_none()
    );
    assert!(db.queue_invite_send(&b, &id).await.unwrap().is_none());
    let sent = SendOutcome::Sent { message_id: None };
    assert!(!db.finish_invite_send(&b, &id, None, sent).await.unwrap());
    assert!(
        db.live_invite(&TokenHash::of(made.token.expose()))
            .await
            .unwrap()
            .is_some()
    );

    // The send waits; copying the link meanwhile replaces the token, keeps the id and cancels
    // the wait, because the e-mail it was for now carries a dead token.
    db.queue_invite_send(&a, &id).await.unwrap().unwrap();
    let copied = db.rotate_invite(&a, &id, TTL, true).await.unwrap().unwrap();
    assert_eq!(copied.invite.id, id);
    assert_eq!(copied.invite.send_status, SendStatus::Unsent);
    assert!(
        db.live_invite(&TokenHash::of(made.token.expose()))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(db.list_invites(&a).await.unwrap().len(), 1);

    // A job that rotated for its own send, then lost the race to a copy, records nothing.
    db.queue_invite_send(&a, &id).await.unwrap().unwrap();
    let mine = db
        .rotate_invite(&a, &id, TTL, false)
        .await
        .unwrap()
        .unwrap();
    let mine = TokenHash::of(mine.token.expose());
    let theirs = db
        .rotate_invite(&a, &id, TTL, false)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !db.finish_invite_send(&a, &id, Some(&mine), sent)
            .await
            .unwrap()
    );
    let listed = &db.list_invites(&a).await.unwrap()[0];
    assert_eq!(listed.send_status, SendStatus::Pending);
    // The one that holds the current token records, once; control characters and length are cut.
    let theirs = TokenHash::of(theirs.token.expose());
    let reason = format!("line one\nline two {}", "x".repeat(500));
    let failed = SendOutcome::Failed { reason: &reason };
    assert!(
        db.finish_invite_send(&a, &id, Some(&theirs), failed)
            .await
            .unwrap()
    );
    assert!(
        !db.finish_invite_send(&a, &id, Some(&theirs), sent)
            .await
            .unwrap()
    );
    let listed = &db.list_invites(&a).await.unwrap()[0];
    assert_eq!(listed.send_status, SendStatus::Failed);
    let error = listed.send_error.as_deref().unwrap();
    assert!(!error.contains('\n') && error.chars().count() == 300);
    // Queueing again clears it, and a send is recorded as sent with the provider's id.
    db.queue_invite_send(&a, &id).await.unwrap().unwrap();
    let with_id = SendOutcome::Sent {
        message_id: Some("msg_9"),
    };
    assert!(db.finish_invite_send(&a, &id, None, with_id).await.unwrap());
    let listed = &db.list_invites(&a).await.unwrap()[0];
    assert_eq!(listed.send_status, SendStatus::Sent);
    assert!(listed.send_error.is_none() && listed.sent_at.is_some());
    assert_eq!(listed.provider_message_id.as_deref(), Some("msg_9"));

    // A revoked invitation cannot be replaced, queued or recorded.
    assert!(db.revoke_invite(&a, &id).await.unwrap());
    assert!(
        db.rotate_invite(&a, &id, TTL, true)
            .await
            .unwrap()
            .is_none()
    );
    assert!(db.queue_invite_send(&a, &id).await.unwrap().is_none());
    server.stop().await;
}
