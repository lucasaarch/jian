//! Who may open an artifact and its link, against a real Postgres: four visibilities, a link every
//! artifact has on a server (found by the hash of its token in the platform, checked in the
//! tenant), a password only for `external`, a new link that kills the old, and no reach across
//! workspaces.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::ArtifactKind;
use jian_store::{
    AccountId, Artifact, ArtifactActor, ArtifactVisibility, Database, NewArtifact, StoreError,
    TenantCtx, Viewer, hash_artifact_password,
};
use jian_testkit::{Side, TestDb, TwoTenants};

fn viewer(who: &jian_store::Member, admin: bool) -> Viewer {
    Viewer {
        account: who.account_id.clone(),
        admin,
    }
}

async fn made(db: &Database, ctx: &TenantCtx, by: &Viewer, text: &str) -> Artifact {
    db.create_artifact(
        ctx,
        ArtifactActor::Member(by),
        &NewArtifact {
            kind: ArtifactKind::Markdown,
            title: "Plan".to_owned(),
            content: text.to_owned(),
            thread: None,
            project: None,
        },
    )
    .await
    .unwrap()
    .unwrap()
    .0
}

/// What the tenant's own row holds as the link and the password.
async fn columns(db: &Database, side: &Side, id: &str) -> (Option<String>, Option<String>) {
    let mut tx = db.begin(&side.ctx).await.unwrap();
    sqlx::query_as("SELECT link_hash, password_hash FROM artifacts WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .unwrap()
}

async fn token_of(db: &Database, side: &Side, by: &Viewer, artifact: &Artifact) -> String {
    db.artifact_share(&side.ctx, ArtifactActor::Member(by), &artifact.id)
        .await
        .unwrap()
        .unwrap()
        .token
        .expect("a server's artifact has a link")
        .expose()
        .to_owned()
}

async fn sees(db: &Database, side: &Side, by: &Viewer, artifact: &Artifact) -> bool {
    db.artifact(&side.ctx, ArtifactActor::Member(by), &artifact.id)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn every_artifact_has_a_link_found_by_its_hash_and_a_new_one_replaces_the_old() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let member = viewer(&side.member, false);
    let artifact = made(db, &side.ctx, &member, "hello").await;
    assert_eq!(artifact.visibility, ArtifactVisibility::Owner);
    assert!(!artifact.has_password);
    assert_eq!(artifact.owner.as_ref(), Some(&side.member.account_id));

    // The token is there from the start; the tenant keeps its hash, never the token.
    let token = token_of(db, side, &member, &artifact).await;
    assert_eq!(token.len(), 43);
    let (stored, _) = columns(db, side, artifact.id.as_str()).await;
    let stored = stored.unwrap();
    assert_eq!(stored.len(), 64);
    assert!(!stored.contains(&token));
    // Asking again gives the same link (Copy Link).
    assert_eq!(token_of(db, side, &member, &artifact).await, token);

    let link = db.public_artifact_link(&token).await.unwrap().unwrap();
    assert_eq!(link.tenant.id(), &side.id);
    assert_eq!(link.artifact, artifact.id);
    assert_eq!(link.visibility, ArtifactVisibility::Owner);
    let page = db.public_artifact(&link).await.unwrap().unwrap();
    assert_eq!(
        (page.title.as_str(), page.content.as_str(), page.version),
        ("Plan", "hello", 1)
    );

    // What is malformed or unknown is no link; so is a token cut short.
    for bad in ["", "short", &"a".repeat(43), &token[..42]] {
        assert!(
            db.public_artifact_link(bad).await.unwrap().is_none(),
            "{bad}"
        );
    }

    // A new link: the old token is a 404 at once, and the new one is what Copy Link gives.
    db.rotate_artifact_link(&side.ctx, ArtifactActor::Member(&member), &artifact.id)
        .await
        .unwrap()
        .unwrap();
    let second = token_of(db, side, &member, &artifact).await;
    assert_ne!(second, token);
    assert!(db.public_artifact_link(&token).await.unwrap().is_none());
    assert!(db.public_artifact_link(&second).await.unwrap().is_some());

    // A copy has a link of its own; deleting the artifact ends its link.
    let (copy, _) = db
        .duplicate_artifact(&side.ctx, &member, &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(token_of(db, side, &member, &copy).await, second);
    assert!(
        db.delete_artifact(&side.ctx, &member, &artifact.id)
            .await
            .unwrap()
    );
    assert!(db.public_artifact_link(&second).await.unwrap().is_none());
    test.stop().await;
}

#[tokio::test]
async fn visibility_decides_who_sees_it_and_an_admin_sees_no_more() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let (owner, peer, admin) = (
        viewer(&side.member, false),
        viewer(&side.peer, false),
        viewer(&side.admin, true),
    );
    let artifact = made(db, &side.ctx, &owner, "x").await;
    let set = |level, members: Option<Vec<AccountId>>| {
        let (db, ctx, id) = (db, &side.ctx, &artifact.id);
        let owner = &owner;
        async move {
            db.set_artifact_visibility(
                ctx,
                ArtifactActor::Member(owner),
                id,
                level,
                members.as_deref(),
            )
            .await
        }
    };

    // `owner` (the default): nobody else, not even an admin.
    assert!(sees(db, side, &owner, &artifact).await);
    assert!(!sees(db, side, &peer, &artifact).await);
    assert!(!sees(db, side, &admin, &artifact).await);

    // `members`: the owner and whoever is listed; a stranger to the workspace cannot be.
    let listed = set(
        ArtifactVisibility::Members,
        Some(vec![side.peer.account_id.clone()]),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(listed.visibility, ArtifactVisibility::Members);
    assert!(sees(db, side, &peer, &artifact).await);
    assert!(!sees(db, side, &admin, &artifact).await);
    let share = db
        .artifact_share(&side.ctx, ArtifactActor::Member(&peer), &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(share.members, vec![side.peer.account_id.clone()]);
    let outsider = tenants.b.member.account_id.clone();
    assert!(matches!(
        set(ArtifactVisibility::Members, Some(vec![outsider])).await,
        Err(StoreError::InvalidWorkspace(_))
    ));

    // The ones who only see it may not change who opens it, whatever their role.
    for who in [&peer, &admin] {
        let denied = db
            .set_artifact_visibility(
                &side.ctx,
                ArtifactActor::Member(who),
                &artifact.id,
                ArtifactVisibility::Workspace,
                None,
            )
            .await;
        // The admin does not even see it: not found, not denied.
        match (who.admin, denied) {
            (false, Err(StoreError::Denied(_))) | (true, Ok(None)) => {}
            (_, other) => panic!("{other:?}"),
        }
    }

    // `workspace` and `external`: every member. Going back to `owner` closes it again.
    for level in [ArtifactVisibility::Workspace, ArtifactVisibility::External] {
        set(level, None).await.unwrap().unwrap();
        assert!(sees(db, side, &peer, &artifact).await);
        assert!(sees(db, side, &admin, &artifact).await);
    }
    set(ArtifactVisibility::Owner, None).await.unwrap().unwrap();
    assert!(!sees(db, side, &peer, &artifact).await);
    assert!(!sees(db, side, &admin, &artifact).await);
    // The list of members does not survive another level.
    set(ArtifactVisibility::Members, None)
        .await
        .unwrap()
        .unwrap();
    assert!(!sees(db, side, &peer, &artifact).await);

    // The other workspace's members reach nothing of it.
    let stranger = viewer(&tenants.b.admin, true);
    assert!(
        db.artifact(
            &tenants.b.ctx,
            ArtifactActor::Member(&stranger),
            &artifact.id
        )
        .await
        .unwrap()
        .is_none()
    );
    test.stop().await;
}

#[tokio::test]
async fn a_password_is_only_for_external_and_leaving_it_deletes_the_password() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let owner = viewer(&side.member, false);
    let me = ArtifactActor::Member(&owner);
    let artifact = made(db, &side.ctx, &owner, "x").await;
    let hash = hash_artifact_password("hunter22").await.unwrap();

    // Not external: no password, and what is not a hash is refused.
    assert!(matches!(
        db.set_artifact_password(&side.ctx, me, &artifact.id, Some(&hash))
            .await,
        Err(StoreError::Conflict(_))
    ));
    db.set_artifact_visibility(
        &side.ctx,
        me,
        &artifact.id,
        ArtifactVisibility::External,
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        db.set_artifact_password(&side.ctx, me, &artifact.id, Some("plain"))
            .await
            .is_err()
    );
    let protected = db
        .set_artifact_password(&side.ctx, me, &artifact.id, Some(&hash))
        .await
        .unwrap()
        .unwrap();
    assert!(protected.has_password);
    let token = token_of(db, side, &owner, &artifact).await;
    let link = db.public_artifact_link(&token).await.unwrap().unwrap();
    assert_eq!(link.visibility, ArtifactVisibility::External);
    assert_eq!(link.password_hash.as_deref(), Some(hash.as_str()));

    // Leaving `external` takes the password with it, and coming back does not restore it.
    db.set_artifact_visibility(
        &side.ctx,
        me,
        &artifact.id,
        ArtifactVisibility::Workspace,
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        columns(db, side, artifact.id.as_str()).await.1,
        None,
        "the password is gone"
    );
    let back = db
        .set_artifact_visibility(
            &side.ctx,
            me,
            &artifact.id,
            ArtifactVisibility::External,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!back.has_password);
    // The link is the same through all of it.
    assert_eq!(token_of(db, side, &owner, &artifact).await, token);

    test.stop().await;
}

#[tokio::test]
async fn where_there_are_no_links_there_is_no_token_and_no_external() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR"))
        .await
        .with_artifact_links(false);
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let owner = viewer(&side.member, false);
    let me = ArtifactActor::Member(&owner);
    let artifact = made(db, &side.ctx, &owner, "x").await;
    assert_eq!(columns(db, side, artifact.id.as_str()).await.0, None);
    let share = db
        .artifact_share(&side.ctx, me, &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert!(share.token.is_none());
    assert!(matches!(
        db.set_artifact_visibility(
            &side.ctx,
            me,
            &artifact.id,
            ArtifactVisibility::External,
            None
        )
        .await,
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        db.rotate_artifact_link(&side.ctx, me, &artifact.id).await,
        Err(StoreError::Conflict(_))
    ));
    // The other levels work as ever.
    db.set_artifact_visibility(
        &side.ctx,
        me,
        &artifact.id,
        ArtifactVisibility::Workspace,
        None,
    )
    .await
    .unwrap()
    .unwrap();
    test.stop().await;
}
