//! Artifacts against a real Postgres: versions (an agent's is never written over, a member's
//! edit is a new one), edits by exact text, who sees one, an artifact outliving its thread, and
//! tenant isolation.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{ArtifactKind, EditError, SourceEdit, ThreadKind, Visibility};
use jian_store::{
    Agent, ArtifactActor, ArtifactAuthor, ArtifactFilter, ArtifactId, Database, NewAgent,
    NewArtifact, NewProject, NewThread, StoreError, TenantCtx, Thread, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

fn viewer(side: &Side, who: &jian_store::Member) -> Viewer {
    Viewer {
        account: who.account_id.clone(),
        admin: std::ptr::eq(who, &raw const side.admin),
    }
}

async fn agent(db: &Database, side: &Side) -> Agent {
    db.create_agent(
        &side.ctx,
        &viewer(side, &side.admin),
        &NewAgent {
            name: "helper".to_owned(),
            description: String::new(),
            instructions: String::new(),
            avatar: None,
            visibility: Visibility::Workspace,
            viewers: Vec::new(),
        },
    )
    .await
    .unwrap()
}

async fn chat(db: &Database, side: &Side, by: &Viewer, agent: &Agent) -> Thread {
    db.create_thread(
        &side.ctx,
        by,
        &NewThread {
            kind: ThreadKind::Dm,
            title: None,
            members: Vec::new(),
            agents: vec![agent.id.clone()],
        },
    )
    .await
    .unwrap()
    .unwrap()
}

fn new(kind: ArtifactKind, content: &str) -> NewArtifact {
    NewArtifact {
        kind,
        title: "Plan".to_owned(),
        content: content.to_owned(),
        thread: None,
        project: None,
    }
}

fn edit(find: &str, replace: &str) -> SourceEdit {
    SourceEdit {
        find: find.to_owned(),
        replace: replace.to_owned(),
    }
}

async fn forget_thread(db: &Database, ctx: &TenantCtx, thread: &Thread) {
    let mut tx = db.begin(ctx).await.unwrap();
    sqlx::query("DELETE FROM threads WHERE id = $1")
        .bind(thread.id.as_str())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn versions_are_kept_and_an_agents_is_never_written_over() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let ctx = &side.ctx;
    let member = viewer(side, &side.member);
    let helper = agent(db, side).await;
    let thread = chat(db, side, &member, &helper).await;
    let run = ArtifactActor::Run {
        thread: &thread.id,
        agent: &helper.id,
    };

    let (artifact, first) = db
        .create_artifact(
            ctx,
            run,
            &new(ArtifactKind::Markdown, "# Plan\nstep one\nstep two"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifact.version, 1);
    assert_eq!(artifact.thread.as_ref(), Some(&thread.id));
    assert_eq!(
        artifact.created_by,
        ArtifactAuthor::Agent(helper.id.clone())
    );
    assert_eq!(first.author, ArtifactAuthor::Agent(helper.id.clone()));
    let id = &artifact.id;

    // An edit is a new version; a find that is not exact once is refused with nothing written.
    let second = db
        .edit_artifact(ctx, run, id, &[edit("step one", "step 1")])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (second.version, second.content.as_str()),
        (2, "# Plan\nstep 1\nstep two")
    );
    match db.edit_artifact(ctx, run, id, &[edit("step", "x")]).await {
        Err(StoreError::Edit(EditError::Ambiguous { places: 2, .. })) => {}
        other => panic!("{other:?}"),
    }
    match db
        .edit_artifact(ctx, run, id, &[edit("step 1", "a"), edit("nope", "b")])
        .await
    {
        Err(StoreError::Edit(EditError::Missing { which: 2, of: 2 })) => {}
        other => panic!("{other:?}"),
    }
    let too_big = "x".repeat(jian_core::MAX_ARTIFACT_CHARS);
    assert!(matches!(
        db.edit_artifact(ctx, run, id, &[edit("# Plan", &too_big)])
            .await,
        Err(StoreError::InvalidWorkspace(_))
    ));
    assert_eq!(
        db.artifact_versions(ctx, run, id)
            .await
            .unwrap()
            .unwrap()
            .len(),
        2
    );

    // A member's save is a version by the member; the same text is no change at all.
    let mine = db
        .save_artifact(ctx, &member, id, "# Plan\nmine", Some("stretch-0001"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mine.version, 3);
    assert_eq!(mine.author, ArtifactAuthor::Member(member.account.clone()));
    let same = db
        .save_artifact(ctx, &member, id, "# Plan\nmine", Some("stretch-0001"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(same.version, 3);
    // The same stretch rewrites its own version while it is the latest.
    let typed = db
        .save_artifact(
            ctx,
            &member,
            id,
            "# Plan\nmine, longer",
            Some("stretch-0001"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (typed.version, typed.content.as_str()),
        (3, "# Plan\nmine, longer")
    );
    // Another key is another stretch, and no key never joins one.
    let other = db
        .save_artifact(ctx, &member, id, "# Plan\nother", Some("stretch-0002"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(other.version, 4);
    let bare = db
        .save_artifact(ctx, &member, id, "# Plan\nbare", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bare.version, 5);

    // The agent's version 2 is where it was, and a save with a key never rewrites an agent's
    // latest: it lands on top.
    let agents_turn = db
        .edit_artifact(ctx, run, id, &[edit("bare", "agent")])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(agents_turn.version, 6);
    let over = db
        .save_artifact(
            ctx,
            &member,
            id,
            "# Plan\nmember again",
            Some("stretch-0002"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(over.version, 7);
    let kept = db
        .artifact_version(ctx, run, id, Some(6))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.content, "# Plan\nagent");
    let old = db
        .artifact_version(ctx, run, id, Some(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old.content, "# Plan\nstep one\nstep two");
    let infos = db.artifact_versions(ctx, run, id).await.unwrap().unwrap();
    assert_eq!(
        infos.iter().map(|v| v.version).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6, 7]
    );
    assert_eq!(db.artifact(ctx, run, id).await.unwrap().unwrap().version, 7);
    assert_eq!(
        db.artifact_version(ctx, run, id, Some(99)).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn a_react_component_keeps_what_it_declares_as_tweaks() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let ctx = &side.ctx;
    let member = viewer(side, &side.member);
    let code = "export const tweaks = { title: \"Hi\", size: { type: \"number\", default: 16 } };\nexport default function A({ title }) { return <h1>{title}</h1>; }";

    let (react, version) = db
        .create_artifact(
            ctx,
            ArtifactActor::Member(&member),
            &new(ArtifactKind::React, code),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        version.tweaks.as_deref(),
        Some("{ title: \"Hi\", size: { type: \"number\", default: 16 } }")
    );
    let changed = db
        .save_artifact(
            ctx,
            &member,
            &react.id,
            &code.replace("\"Hi\"", "\"Yo\""),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(changed.tweaks.unwrap().contains("\"Yo\""));
    let (_, plain) = db
        .create_artifact(
            ctx,
            ArtifactActor::Member(&member),
            &new(ArtifactKind::Markdown, code),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(plain.tweaks, None, "only a component declares tweaks");
}

#[tokio::test]
async fn deleting_the_thread_keeps_the_artifact_without_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let ctx = &side.ctx;
    let (admin, member, peer) = (
        viewer(side, &side.admin),
        viewer(side, &side.member),
        viewer(side, &side.peer),
    );
    let helper = agent(db, side).await;
    let thread = chat(db, side, &member, &helper).await;
    let mut shared = NewProject::named("Shared");
    shared.visibility = Visibility::Workspace;
    let project = db.create_project(ctx, &member, &shared).await.unwrap();
    db.set_thread_project(ctx, &member, &thread.id, Some(&project.id))
        .await
        .unwrap();

    let mut made = new(ArtifactKind::Html, "<p>hi</p>");
    made.thread = Some(thread.id.clone());
    let (in_project, _) = db
        .create_artifact(ctx, ArtifactActor::Member(&member), &made)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(in_project.project.as_ref(), Some(&project.id));
    // The thread's project: kept by the artifact.
    db.set_thread_project(ctx, &member, &thread.id, None)
        .await
        .unwrap();
    let (loose, _) = db
        .create_artifact(ctx, ArtifactActor::Member(&member), &made)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loose.project, None);
    assert_eq!(
        db.artifact(ctx, ArtifactActor::Member(&peer), &loose.id)
            .await
            .unwrap(),
        None
    );

    forget_thread(db, ctx, &thread).await;

    let kept = db
        .artifact(ctx, ArtifactActor::Member(&peer), &in_project.id)
        .await
        .unwrap()
        .expect("the project still shows it");
    assert_eq!(
        (kept.thread, kept.project.as_ref()),
        (None, Some(&project.id))
    );
    // With no thread and no project it is its maker's, and an admin's; nobody else's.
    let loose_id = &loose.id;
    assert!(sees(db, ctx, ArtifactActor::Member(&member), loose_id).await);
    assert!(sees(db, ctx, ArtifactActor::Member(&admin), loose_id).await);
    assert!(!sees(db, ctx, ArtifactActor::Member(&peer), loose_id).await);

    // Seeing it through the project does not let a peer delete what a member made.
    assert!(matches!(
        db.delete_artifact(ctx, &peer, &in_project.id).await,
        Err(StoreError::Denied(_))
    ));
}

#[tokio::test]
async fn who_sees_an_artifact_is_who_sees_its_thread_or_its_project() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let ctx = &side.ctx;
    let (member, peer) = (viewer(side, &side.member), viewer(side, &side.peer));
    let helper = agent(db, side).await;
    let mine = chat(db, side, &member, &helper).await;
    let theirs = chat(db, side, &peer, &helper).await;
    let mut private = NewProject::named("Mine");
    private.visibility = Visibility::Private;
    let private = db.create_project(ctx, &member, &private).await.unwrap();

    // A member names only a thread they are in and a project they see.
    let mut elsewhere = new(ArtifactKind::Markdown, "x");
    elsewhere.thread = Some(theirs.id.clone());
    assert_eq!(
        db.create_artifact(ctx, ArtifactActor::Member(&member), &elsewhere)
            .await
            .unwrap(),
        None
    );
    let mut hidden = new(ArtifactKind::Markdown, "x");
    hidden.project = Some(private.id.clone());
    assert_eq!(
        db.create_artifact(ctx, ArtifactActor::Member(&peer), &hidden)
            .await
            .unwrap(),
        None
    );

    let run_mine = ArtifactActor::Run {
        thread: &mine.id,
        agent: &helper.id,
    };
    let run_theirs = ArtifactActor::Run {
        thread: &theirs.id,
        agent: &helper.id,
    };
    let (in_thread, _) = db
        .create_artifact(ctx, run_mine, &new(ArtifactKind::Markdown, "mine"))
        .await
        .unwrap()
        .unwrap();
    let (in_project, _) = db
        .create_artifact(ctx, ArtifactActor::Member(&member), &hidden)
        .await
        .unwrap()
        .unwrap();
    let id = &in_thread.id;

    assert!(sees(db, ctx, ArtifactActor::Member(&member), id).await);
    assert!(!sees(db, ctx, ArtifactActor::Member(&peer), id).await);
    assert!(sees(db, ctx, ArtifactActor::Member(&member), &in_project.id).await);
    assert!(!sees(db, ctx, ArtifactActor::Member(&peer), &in_project.id).await);
    // Every call says the same: the peer's reads, edits and deletes find nothing, and change
    // nothing.
    let peer_actor = ArtifactActor::Member(&peer);
    assert_eq!(
        db.artifact_version(ctx, peer_actor, id, None)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.artifact_versions(ctx, peer_actor, id).await.unwrap(),
        None
    );
    assert_eq!(
        db.edit_artifact(ctx, peer_actor, id, &[edit("mine", "x")])
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        db.save_artifact(ctx, &peer, id, "x", None).await.unwrap(),
        None
    );
    assert_eq!(db.rename_artifact(ctx, &peer, id, "x").await.unwrap(), None);
    assert_eq!(db.pin_artifact(ctx, &peer, id, true).await.unwrap(), None);
    assert_eq!(db.duplicate_artifact(ctx, &peer, id).await.unwrap(), None);
    assert!(!db.delete_artifact(ctx, &peer, id).await.unwrap());
    let seen = db
        .list_artifacts(ctx, peer_actor, &ArtifactFilter::default(), None, 50)
        .await
        .unwrap();
    assert!(seen.items.is_empty());

    // A run sees its own thread and its project, never another thread's artifact.
    assert!(sees(db, ctx, run_mine, id).await);
    assert!(!sees(db, ctx, run_theirs, id).await);
    assert_eq!(
        db.edit_artifact(ctx, run_theirs, id, &[edit("mine", "x")])
            .await
            .unwrap(),
        None
    );
    db.set_thread_project(ctx, &member, &mine.id, Some(&private.id))
        .await
        .unwrap();
    assert!(
        sees(db, ctx, run_mine, &in_project.id).await,
        "its thread's project"
    );

    // The member's own list, by thread and by project.
    let by_thread = db
        .list_artifacts(
            ctx,
            ArtifactActor::Member(&member),
            &ArtifactFilter {
                thread: Some(mine.id.clone()),
                ..ArtifactFilter::default()
            },
            None,
            50,
        )
        .await
        .unwrap();
    assert_eq!(by_thread.items.len(), 1);
    let by_project = db
        .list_artifacts(
            ctx,
            ArtifactActor::Member(&member),
            &ArtifactFilter {
                project: Some(private.id.clone()),
                ..ArtifactFilter::default()
            },
            None,
            50,
        )
        .await
        .unwrap();
    assert_eq!(by_project.items.len(), 1);
    assert_eq!(by_project.items[0].id, in_project.id);
}

#[tokio::test]
async fn pin_folder_copy_and_delete() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (db, side) = (&test.db, &tenants.a);
    let ctx = &side.ctx;
    let (admin, member, peer) = (
        viewer(side, &side.admin),
        viewer(side, &side.member),
        viewer(side, &side.peer),
    );
    let helper = agent(db, side).await;
    let thread = chat(db, side, &member, &helper).await;
    let mut made = new(ArtifactKind::Sheet, "a,b\n1,2");
    made.thread = Some(thread.id.clone());
    let actor = ArtifactActor::Member(&member);
    let (artifact, _) = db
        .create_artifact(ctx, actor, &made)
        .await
        .unwrap()
        .unwrap();

    let folder = db
        .create_artifact_folder(ctx, &member, "Reports")
        .await
        .unwrap();
    let moved = db
        .move_artifact(ctx, &member, &artifact.id, Some(&folder.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.folder.as_ref(), Some(&folder.id));
    assert!(matches!(
        db.move_artifact(
            ctx,
            &member,
            &artifact.id,
            Some(&jian_store::ArtifactFolderId::new("afo_never"))
        )
        .await,
        Err(StoreError::InvalidWorkspace(_))
    ));
    assert!(
        db.pin_artifact(ctx, &member, &artifact.id, true)
            .await
            .unwrap()
            .unwrap()
            .pinned
    );
    let renamed = db
        .rename_artifact(ctx, &member, &artifact.id, "  Budget  ")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.title, "Budget");
    assert!(matches!(
        db.rename_artifact(ctx, &member, &artifact.id, " ").await,
        Err(StoreError::InvalidWorkspace(_))
    ));

    let (copy, copied) = db
        .duplicate_artifact(ctx, &member, &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((copy.title.as_str(), copy.version), ("Budget (copy)", 1));
    assert_eq!(copied.content, "a,b\n1,2");
    assert!(
        !copy.pinned && copy.folder.is_none(),
        "a copy starts unfiled and unpinned"
    );

    // A folder's maker or an admin changes it; deleting it leaves the artifact, unfiled.
    assert!(matches!(
        db.delete_artifact_folder(ctx, &peer, &folder.id).await,
        Err(StoreError::Denied(_))
    ));
    assert!(
        db.delete_artifact_folder(ctx, &admin, &folder.id)
            .await
            .unwrap()
    );
    let unfiled = db
        .artifact(ctx, actor, &artifact.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unfiled.folder, None);

    // A member's artifact is deleted by that member or an admin, with its versions.
    let in_thread = ArtifactActor::Run {
        thread: &thread.id,
        agent: &helper.id,
    };
    assert!(db.delete_artifact(ctx, &member, &copy.id).await.unwrap());
    assert_eq!(db.artifact(ctx, actor, &copy.id).await.unwrap(), None);
    assert_eq!(
        db.artifact_versions(ctx, in_thread, &copy.id)
            .await
            .unwrap(),
        None
    );
    assert!(db.delete_artifact(ctx, &admin, &artifact.id).await.is_ok());
    assert!(
        !db.delete_artifact(ctx, &admin, &artifact.id).await.unwrap(),
        "already gone"
    );
}

#[tokio::test]
async fn tenant_b_sees_and_changes_nothing_of_tenant_a() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    for (actor, victim) in tenants.crossings() {
        let owner = viewer(victim, &victim.member);
        let helper = agent(db, victim).await;
        let thread = chat(db, victim, &owner, &helper).await;
        let run = ArtifactActor::Run {
            thread: &thread.id,
            agent: &helper.id,
        };
        let (artifact, _) = db
            .create_artifact(
                &victim.ctx,
                run,
                &new(ArtifactKind::Markdown, "secret plan"),
            )
            .await
            .unwrap()
            .unwrap();
        let folder = db
            .create_artifact_folder(&victim.ctx, &owner, "Private stuff")
            .await
            .unwrap();

        // The other tenant's admin, with the very ids of this one.
        let intruder = viewer(actor, &actor.admin);
        let by = ArtifactActor::Member(&intruder);
        let ctx = &actor.ctx;
        let id = &artifact.id;
        assert_eq!(db.artifact(ctx, by, id).await.unwrap(), None);
        assert_eq!(db.artifact_version(ctx, by, id, None).await.unwrap(), None);
        assert_eq!(db.artifact_versions(ctx, by, id).await.unwrap(), None);
        assert_eq!(
            db.edit_artifact(ctx, by, id, &[edit("secret", "x")])
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            db.save_artifact(ctx, &intruder, id, "x", None)
                .await
                .unwrap(),
            None
        );
        assert!(!db.delete_artifact(ctx, &intruder, id).await.unwrap());
        assert!(
            db.list_artifacts(ctx, by, &ArtifactFilter::default(), None, 50)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            db.list_artifact_folders(ctx)
                .await
                .unwrap()
                .iter()
                .all(|f| f.id != folder.id)
        );
        assert_eq!(db.artifact_folder(ctx, &folder.id).await.unwrap(), None);
        assert!(
            !db.delete_artifact_folder(ctx, &intruder, &folder.id)
                .await
                .unwrap()
        );
        // It cannot be made in the other tenant's thread either.
        let mut into = new(ArtifactKind::Markdown, "x");
        into.thread = Some(thread.id.clone());
        assert_eq!(db.create_artifact(ctx, by, &into).await.unwrap(), None);

        let still = db
            .artifact_version(&victim.ctx, run, id, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((still.version, still.content.as_str()), (1, "secret plan"));
        assert!(
            db.list_artifact_folders(&victim.ctx)
                .await
                .unwrap()
                .iter()
                .any(|f| f.id == folder.id)
        );
    }
}

async fn sees(db: &Database, ctx: &TenantCtx, actor: ArtifactActor<'_>, id: &ArtifactId) -> bool {
    db.artifact(ctx, actor, id).await.unwrap().is_some()
}
