//! Projects against a real Postgres and a real directory: who sees a project (and that what a
//! caller does not see is "not found" on every call), a thread being in one project at most,
//! files whose bytes live on disk, the disk quota, and what a conversation in a project is told.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::{ThreadKind, Visibility};
use jian_store::{
    Agent, Database, DiskBlobs, MAX_PROJECT_FILE_BYTES, NewAgent, NewProject, NewThread, Project,
    ProjectFileId, ProjectId, ProjectPatch, Quotas, StoreError, Thread, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

#[derive(Clone, Copy)]
enum Who {
    Admin,
    Member,
    Peer,
}

fn viewer(side: &Side, who: Who) -> Viewer {
    match who {
        Who::Admin => Viewer {
            account: side.admin.account_id.clone(),
            admin: true,
        },
        Who::Member => Viewer {
            account: side.member.account_id.clone(),
            admin: false,
        },
        Who::Peer => Viewer {
            account: side.peer.account_id.clone(),
            admin: false,
        },
    }
}

async fn agent(db: &Database, side: &Side) -> Agent {
    db.create_agent(
        &side.ctx,
        &viewer(side, Who::Admin),
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

/// A direct chat of `by` alone with the agent.
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

async fn project(db: &Database, side: &Side, by: Who, visibility: Visibility) -> Project {
    let mut new = NewProject::named("Website");
    new.visibility = visibility;
    db.create_project(&side.ctx, &viewer(side, by), &new)
        .await
        .unwrap()
}

fn files_on_disk(test: &TestDb, side: &Side) -> Vec<String> {
    let dir = DiskBlobs::new(test.blobs_dir()).tenant_dir(side.ctx.id());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn what_a_caller_does_not_see_is_not_found_on_every_call() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let side = &tenants.a;
    let (admin, member, peer) = (
        viewer(side, Who::Admin),
        viewer(side, Who::Member),
        viewer(side, Who::Peer),
    );
    let a = agent(db, side).await;
    let mine = chat(db, side, &member, &a).await;
    let theirs = chat(db, side, &peer, &a).await;
    let made = project(db, side, Who::Member, Visibility::Private).await;
    let ctx = &side.ctx;
    let file = db
        .add_project_file(
            ctx,
            &member,
            &made.id,
            "notes.md",
            Some("text/markdown"),
            b"hi",
        )
        .await
        .unwrap()
        .unwrap();
    let repo = db
        .add_project_repository(ctx, &member, &made.id, "https://example.test/a/b.git", None)
        .await
        .unwrap()
        .unwrap();
    db.set_thread_project(ctx, &member, &mine.id, Some(&made.id))
        .await
        .unwrap()
        .unwrap();

    // Private: the creator sees it; another member and even an admin get "not found" from every
    // call, never "denied", which would say it exists.
    for other in [&peer, &admin] {
        assert!(db.project(ctx, other, &made.id).await.unwrap().is_none());
        assert!(
            db.list_projects(ctx, other, None, 10)
                .await
                .unwrap()
                .items
                .is_empty()
        );
        let patch = ProjectPatch {
            name: Some("Mine now".to_owned()),
            ..ProjectPatch::default()
        };
        assert!(
            db.update_project(ctx, other, &made.id, &patch)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!db.delete_project(ctx, other, &made.id).await.unwrap());
        assert!(
            db.list_project_files(ctx, other, &made.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.add_project_file(ctx, other, &made.id, "x.txt", None, b"x")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.read_project_file(ctx, other, &made.id, &file.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !db.delete_project_file(ctx, other, &made.id, &file.id)
                .await
                .unwrap()
        );
        assert!(
            db.add_project_repository(ctx, other, &made.id, "https://example.test/c.git", None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            !db.remove_project_repository(ctx, other, &made.id, &repo.id)
                .await
                .unwrap()
        );
        assert!(
            db.list_project_threads(ctx, other, &made.id, None, 10)
                .await
                .unwrap()
                .is_none()
        );
    }
    // A thread the caller is in cannot be moved into a project they do not see; one they are not
    // in is not theirs to move at all.
    assert!(
        db.set_thread_project(ctx, &peer, &theirs.id, Some(&made.id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.set_thread_project(ctx, &peer, &mine.id, None)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(files_on_disk(&test, side).len(), 1);

    // Members: the listed ones read, and only the creator or an admin who sees it changes.
    let patch = ProjectPatch {
        visibility: Some(Visibility::Members),
        viewers: Some(vec![peer.account.clone()]),
        ..ProjectPatch::default()
    };
    db.update_project(ctx, &member, &made.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert!(db.project(ctx, &peer, &made.id).await.unwrap().is_some());
    assert!(db.project(ctx, &admin, &made.id).await.unwrap().is_none());
    let read = db
        .read_project_file(ctx, &peer, &made.id, &file.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.1, b"hi");
    assert!(matches!(
        db.add_project_file(ctx, &peer, &made.id, "x.txt", None, b"x")
            .await,
        Err(StoreError::Denied(_))
    ));
    assert!(matches!(
        db.delete_project_file(ctx, &peer, &made.id, &file.id).await,
        Err(StoreError::Denied(_))
    ));
    assert!(matches!(
        db.update_project(ctx, &peer, &made.id, &ProjectPatch::default())
            .await,
        Err(StoreError::Denied(_))
    ));
    // The thread in it that the peer is not in stays the creator's.
    let listed = db
        .list_project_threads(ctx, &peer, &made.id, None, 10)
        .await
        .unwrap()
        .unwrap();
    assert!(listed.items.is_empty());

    // Workspace: everyone sees it, an admin changes it.
    let patch = ProjectPatch {
        visibility: Some(Visibility::Workspace),
        ..ProjectPatch::default()
    };
    db.update_project(ctx, &member, &made.id, &patch)
        .await
        .unwrap()
        .unwrap();
    for who in [&admin, &peer, &member] {
        assert!(db.project(ctx, who, &made.id).await.unwrap().is_some());
    }
    let renamed = ProjectPatch {
        name: Some("Site".to_owned()),
        ..ProjectPatch::default()
    };
    assert_eq!(
        db.update_project(ctx, &admin, &made.id, &renamed)
            .await
            .unwrap()
            .unwrap()
            .name,
        "Site"
    );
    // Narrowed again, the peer loses it at once.
    let patch = ProjectPatch {
        visibility: Some(Visibility::Private),
        ..ProjectPatch::default()
    };
    db.update_project(ctx, &member, &made.id, &patch)
        .await
        .unwrap()
        .unwrap();
    assert!(db.project(ctx, &peer, &made.id).await.unwrap().is_none());
    assert_eq!(
        db.project_audience(ctx, &made.id).await.unwrap(),
        std::slice::from_ref(&member.account)
    );

    // Another tenant sees none of it, by id or by list.
    let other = &tenants.b;
    let outsider = viewer(other, Who::Admin);
    assert!(
        db.project(&other.ctx, &outsider, &made.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        db.list_projects(&other.ctx, &outsider, None, 10)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    test.stop().await;
}

#[tokio::test]
async fn a_thread_enters_switches_and_leaves_and_is_never_in_two() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let side = &tenants.a;
    let ctx = &side.ctx;
    let member = viewer(side, Who::Member);
    let a = agent(db, side).await;
    let thread = chat(db, side, &member, &a).await;
    let one = project(db, side, Who::Member, Visibility::Private).await;
    let two = project(db, side, Who::Member, Visibility::Private).await;
    let in_project = |p: &ProjectId| {
        let p = p.clone();
        let member = member.clone();
        async move {
            db.list_project_threads(ctx, &member, &p, None, 10)
                .await
                .unwrap()
                .unwrap()
                .items
                .len()
        }
    };

    let moved = db
        .set_thread_project(ctx, &member, &thread.id, Some(&one.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!((moved.from, moved.to), (None, Some(one.id.clone())));
    assert_eq!(
        (in_project(&one.id).await, in_project(&two.id).await),
        (1, 0)
    );

    let moved = db
        .set_thread_project(ctx, &member, &thread.id, Some(&two.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (moved.from, moved.to),
        (Some(one.id.clone()), Some(two.id.clone()))
    );
    assert_eq!(
        (in_project(&one.id).await, in_project(&two.id).await),
        (0, 1)
    );
    let now = db.thread_project(ctx, &member, &thread.id).await.unwrap();
    assert_eq!(now.unwrap().unwrap().id, two.id);

    let moved = db
        .set_thread_project(ctx, &member, &thread.id, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((moved.from, moved.to), (Some(two.id.clone()), None));
    assert_eq!(
        (in_project(&one.id).await, in_project(&two.id).await),
        (0, 0)
    );
    assert!(
        db.thread_project(ctx, &member, &thread.id)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );

    // Deleting a project ends the link; the thread stays.
    db.set_thread_project(ctx, &member, &thread.id, Some(&one.id))
        .await
        .unwrap()
        .unwrap();
    assert!(db.delete_project(ctx, &member, &one.id).await.unwrap());
    assert!(db.thread(ctx, &member, &thread.id).await.unwrap().is_some());
    assert!(
        db.thread_project(ctx, &member, &thread.id)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    // A project that does not exist is "not found", and the thread is where it was.
    db.set_thread_project(ctx, &member, &thread.id, Some(&two.id))
        .await
        .unwrap()
        .unwrap();
    assert!(
        db.set_thread_project(ctx, &member, &thread.id, Some(&ProjectId::new("prj_never")))
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(in_project(&two.id).await, 1);
    test.stop().await;
}

#[tokio::test]
async fn a_file_keeps_its_bytes_on_disk_and_leaves_with_its_row() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let side = &tenants.a;
    let ctx = &side.ctx;
    let member = viewer(side, Who::Member);
    let made = project(db, side, Who::Member, Visibility::Private).await;

    // The bytes come back the same, and the hash is the one of "abc", computed by the store.
    let file = db
        .add_project_file(
            ctx,
            &member,
            &made.id,
            "abc.bin",
            Some("Text/Plain; charset=utf-8"),
            b"abc",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        file.sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!((file.size_bytes, file.mime.as_str()), (3, "text/plain"));
    let (row, bytes) = db
        .read_project_file(ctx, &member, &made.id, &file.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((row, bytes), (file.clone(), b"abc".to_vec()));
    assert_eq!(files_on_disk(&test, side).len(), 1);
    // A hostile media type is a plain download.
    let odd = db
        .add_project_file(
            ctx,
            &member,
            &made.id,
            "odd",
            Some("x\r\nSet-Cookie: a=b"),
            b"",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(odd.mime, "application/octet-stream");

    // A name is a label: a path in it cuts down to its last segment, and nothing lands outside
    // the tenant's directory or under that name.
    let sneaky = db
        .add_project_file(ctx, &member, &made.id, "../../../etc/passwd", None, b"x")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sneaky.name, "passwd");
    let on_disk = files_on_disk(&test, side);
    assert_eq!(on_disk.len(), 3);
    assert!(on_disk.iter().all(|n| n != "passwd" && !n.contains('.')));
    for bad in ["..", ".", "", "  ", "a\u{0}b", "dir/"] {
        assert!(
            matches!(
                db.add_project_file(ctx, &member, &made.id, bad, None, b"x")
                    .await,
                Err(StoreError::InvalidWorkspace(_))
            ),
            "{bad:?}"
        );
    }

    // Over the limit is a clear error, and nothing is written.
    let big = vec![0_u8; usize::try_from(MAX_PROJECT_FILE_BYTES).unwrap() + 1];
    match db
        .add_project_file(ctx, &member, &made.id, "big", None, &big)
        .await
    {
        Err(StoreError::FileTooLarge { max }) => assert_eq!(max, MAX_PROJECT_FILE_BYTES),
        other => panic!("{other:?}"),
    }
    assert_eq!(files_on_disk(&test, side).len(), 3);
    assert_eq!(
        db.list_project_files(ctx, &member, &made.id)
            .await
            .unwrap()
            .unwrap()
            .len(),
        3
    );

    // Another file id, or another project's, finds nothing.
    let elsewhere = project(db, side, Who::Member, Visibility::Private).await;
    assert!(
        db.read_project_file(ctx, &member, &elsewhere.id, &file.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !db.delete_project_file(ctx, &member, &made.id, &ProjectFileId::new("pfl_never"))
            .await
            .unwrap()
    );

    // Deleting a file removes its bytes from the disk; deleting the project removes the rest.
    assert!(
        db.delete_project_file(ctx, &member, &made.id, &file.id)
            .await
            .unwrap()
    );
    assert_eq!(files_on_disk(&test, side).len(), 2);
    assert!(db.delete_project(ctx, &member, &made.id).await.unwrap());
    assert!(files_on_disk(&test, side).is_empty());
    test.stop().await;
}

#[tokio::test]
async fn files_count_against_the_disk_quota() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let side = &tenants.a;
    let ctx = &side.ctx;
    let member = viewer(side, Who::Member);
    let made = project(db, side, Who::Member, Visibility::Private).await;
    let before = db.disk_bytes(ctx).await.unwrap();
    db.add_project_file(ctx, &member, &made.id, "a.bin", None, &[7_u8; 1000])
        .await
        .unwrap()
        .unwrap();
    assert!(db.disk_bytes(ctx).await.unwrap() >= before + 1000);

    // Room for little more than it has now: a small file fits, a large one is refused, and a
    // refused file leaves nothing on the disk.
    let used = db.disk_bytes(ctx).await.unwrap();
    db.set_quotas(
        ctx,
        &Quotas {
            disk_bytes: Some(used + 100_000),
            ..Quotas::default()
        },
    )
    .await
    .unwrap();
    db.add_project_file(ctx, &member, &made.id, "small", None, &[1_u8; 10])
        .await
        .unwrap()
        .unwrap();
    let on_disk = files_on_disk(&test, side).len();
    assert!(matches!(
        db.add_project_file(ctx, &member, &made.id, "large", None, &vec![1_u8; 200_000])
            .await,
        Err(StoreError::QuotaExceeded("disk"))
    ));
    assert_eq!(files_on_disk(&test, side).len(), on_disk);
    // Another tenant's quota and files are its own.
    assert!(db.disk_bytes(&tenants.b.ctx).await.unwrap() < used);
    test.stop().await;
}

#[tokio::test]
async fn a_conversation_in_a_project_is_told_its_instructions_and_files() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    let side = &tenants.a;
    let ctx = &side.ctx;
    let member = viewer(side, Who::Member);
    let a = agent(db, side).await;
    let thread = chat(db, side, &member, &a).await;
    assert!(db.project_context(ctx, &thread.id).await.unwrap().is_none());

    let mut new = NewProject::named("Site");
    new.instructions = "Use British spelling".to_owned();
    let made = db.create_project(ctx, &member, &new).await.unwrap();
    db.add_project_file(ctx, &member, &made.id, "brief.md", None, b"# Brief")
        .await
        .unwrap()
        .unwrap();
    db.add_project_repository(
        ctx,
        &member,
        &made.id,
        "https://example.test/a/site.git",
        Some("main"),
    )
    .await
    .unwrap()
    .unwrap();
    db.set_thread_project(ctx, &member, &thread.id, Some(&made.id))
        .await
        .unwrap()
        .unwrap();
    let told = db.project_context(ctx, &thread.id).await.unwrap().unwrap();
    assert_eq!(told.project.instructions, "Use British spelling");
    assert_eq!(
        told.files
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["brief.md"]
    );
    assert_eq!(
        told.project.repositories[0].default_branch.as_deref(),
        Some("main")
    );

    db.set_thread_project(ctx, &member, &thread.id, None)
        .await
        .unwrap()
        .unwrap();
    assert!(db.project_context(ctx, &thread.id).await.unwrap().is_none());
    test.stop().await;
}

#[tokio::test]
async fn without_file_storage_a_file_is_refused_and_the_rest_works() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let bare = Database::open(jian_store::DatabaseSource::External(test.url.clone()))
        .await
        .unwrap();
    let member = viewer(&side, Who::Member);
    let ctx = bare.tenant(side.id.clone()).await.unwrap();
    let made = bare
        .create_project(&ctx, &member, &NewProject::named("No files"))
        .await
        .unwrap();
    assert!(matches!(
        bare.add_project_file(&ctx, &member, &made.id, "a", None, b"a")
            .await,
        Err(StoreError::NoFileStorage)
    ));
    bare.close().await.unwrap();
    test.stop().await;
}
