//! The skill library against a real Postgres: the limit and the one-name rule under concurrency,
//! versions, who may change a skill, what an agent switched on, and that tenant B reaches
//! nothing of tenant A's.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{
    AgentId, Database, MAX_LIBRARY_SKILLS, NewAgent, Skill, SkillDraft, SkillSource, SkillText,
    StoreError, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

fn text(instructions: &str) -> SkillText {
    SkillText {
        description: "Use when it fits.".to_owned(),
        instructions: instructions.to_owned(),
        license: None,
        requires_tools: Vec::new(),
    }
}

fn draft(name: &str, instructions: &str) -> SkillDraft {
    SkillDraft {
        name: name.to_owned(),
        text: text(instructions),
        source: SkillSource::User,
    }
}

fn viewer(side: &Side, admin: bool) -> Viewer {
    Viewer {
        account: if admin {
            side.admin.account_id.clone()
        } else {
            side.member.account_id.clone()
        },
        admin,
    }
}

async fn add(db: &Database, side: &Side, name: &str, by_admin: bool) -> Skill {
    db.create_skill(
        &side.ctx,
        &viewer(side, by_admin).account,
        &draft(name, "v1"),
    )
    .await
    .unwrap()
}

async fn agent(db: &Database, side: &Side) -> AgentId {
    db.create_agent(
        &side.ctx,
        &viewer(side, true),
        &NewAgent {
            name: "bot".to_owned(),
            description: String::new(),
            instructions: String::new(),
            avatar: None,
            visibility: Visibility::Workspace,
            viewers: Vec::new(),
        },
    )
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn the_library_holds_sixty_and_one_name_once_even_when_written_together() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let author = side.admin.account_id.clone();

    // Twenty writers of one name: exactly one wins, the rest are told it is taken.
    let same = draft("same", "x");
    let writes = (0..20).map(|_| test.db.create_skill(&side.ctx, &author, &same));
    let results = futures_util::future::join_all(writes).await;
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| matches!(e, StoreError::Conflict(_)))
    );

    // More than the limit written together: the library stops at 60.
    let drafts: Vec<SkillDraft> = (0..70).map(|n| draft(&format!("skill-{n}"), "x")).collect();
    let writes = drafts
        .iter()
        .map(|d| test.db.create_skill(&side.ctx, &author, d));
    let results = futures_util::future::join_all(writes).await;
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        MAX_LIBRARY_SKILLS - 1
    );
    assert_eq!(
        test.db.list_skills(&side.ctx).await.unwrap().len(),
        MAX_LIBRARY_SKILLS
    );
    let full = test
        .db
        .create_skill(&side.ctx, &author, &draft("one-more", "x"))
        .await;
    assert!(matches!(full, Err(StoreError::Conflict(_))), "{full:?}");
    test.stop().await;
}

#[tokio::test]
async fn bounds_are_refused_not_cut() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let author = side.admin.account_id.clone();
    for bad in [
        draft("Bad Name", "x"),
        draft("", "x"),
        draft("ok", ""),
        draft("ok", &"x".repeat(12_001)),
    ] {
        let made = test.db.create_skill(&side.ctx, &author, &bad).await;
        assert!(
            matches!(made, Err(StoreError::InvalidWorkspace(_))),
            "{}",
            bad.name
        );
    }
    let mut long = draft("ok", "x");
    long.text.description = "d".repeat(1025);
    assert!(
        test.db
            .create_skill(&side.ctx, &author, &long)
            .await
            .is_err()
    );
    let mut tools = draft("ok", "x");
    tools.text.requires_tools = vec!["rm -rf".to_owned()];
    assert!(
        test.db
            .create_skill(&side.ctx, &author, &tools)
            .await
            .is_err()
    );
    assert!(test.db.list_skills(&side.ctx).await.unwrap().is_empty());
    test.stop().await;
}

#[tokio::test]
async fn an_edit_is_a_version_and_the_same_text_is_not() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let admin = viewer(&side, true);
    add(db, &side, "notes", true).await;

    let same = db
        .update_skill(ctx, &admin, "notes", &text("v1"), None, None)
        .await;
    assert_eq!(same.unwrap().unwrap().version, 1);
    let v2 = db
        .update_skill(ctx, &admin, "notes", &text("v2"), None, Some(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(v2.version, 2);
    let stale = db
        .update_skill(ctx, &admin, "notes", &text("v3"), None, Some(1))
        .await;
    assert!(
        matches!(stale, Err(StoreError::VersionConflict { current: 2 })),
        "{stale:?}"
    );

    // A reimport changes where it came from, and is a version too.
    let source = SkillSource::Github {
        repo: "acme/skills".to_owned(),
        path: "notes".to_owned(),
        git_ref: "HEAD".to_owned(),
    };
    let v3 = db
        .update_skill(ctx, &admin, "notes", &text("v3"), Some(&source), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((v3.version, v3.source.clone()), (3, source));
    let versions = db.skill_versions(ctx, "notes").await.unwrap().unwrap();
    let said: Vec<(i64, &str)> = versions
        .iter()
        .map(|v| (v.version, v.text.instructions.as_str()))
        .collect();
    assert_eq!(said, [(3, "v3"), (2, "v2"), (1, "v1")]);
    assert!(db.skill_versions(ctx, "none").await.unwrap().is_none());
    assert!(
        db.update_skill(ctx, &admin, "none", &text("x"), None, None)
            .await
            .unwrap()
            .is_none()
    );
    test.stop().await;
}

#[tokio::test]
async fn only_the_creator_or_an_admin_changes_or_deletes() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let (admin, member) = (viewer(&side, true), viewer(&side, false));
    add(db, &side, "by-admin", true).await;
    add(db, &side, "by-member", false).await;

    let no = db
        .update_skill(ctx, &member, "by-admin", &text("x"), None, None)
        .await;
    assert!(matches!(no, Err(StoreError::Denied(_))), "{no:?}");
    assert!(matches!(
        db.delete_skill(ctx, &member, "by-admin").await,
        Err(StoreError::Denied(_))
    ));
    assert!(
        db.update_skill(ctx, &member, "by-member", &text("mine"), None, None)
            .await
            .is_ok()
    );
    assert!(
        db.update_skill(ctx, &admin, "by-member", &text("admin's"), None, None)
            .await
            .is_ok()
    );
    assert!(db.delete_skill(ctx, &member, "by-member").await.unwrap());
    assert!(!db.delete_skill(ctx, &member, "by-member").await.unwrap());
    test.stop().await;
}

#[tokio::test]
async fn an_agent_uses_what_was_switched_on_and_deleting_a_skill_takes_it_off() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (db, ctx) = (&test.db, &side.ctx);
    let agent = agent(db, &side).await;
    add(db, &side, "one", true).await;
    add(db, &side, "two", true).await;

    assert!(
        db.agent_skills(ctx, &agent)
            .await
            .unwrap()
            .library
            .is_empty()
    );
    assert!(db.set_agent_skill(ctx, &agent, "one", true).await.unwrap());
    assert!(db.set_agent_skill(ctx, &agent, "one", true).await.unwrap());
    assert!(
        !db.set_agent_skill(ctx, &agent, "ghost", true)
            .await
            .unwrap()
    );
    db.set_agent_builtin_skill(ctx, &agent, "about-jian", false)
        .await
        .unwrap();
    let chosen = db.agent_skills(ctx, &agent).await.unwrap();
    assert_eq!(
        chosen
            .library
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["one"]
    );
    assert_eq!(chosen.disabled_builtins, ["about-jian"]);
    db.set_agent_builtin_skill(ctx, &agent, "about-jian", true)
        .await
        .unwrap();
    assert!(
        db.agent_skills(ctx, &agent)
            .await
            .unwrap()
            .disabled_builtins
            .is_empty()
    );

    assert!(
        db.delete_skill(ctx, &viewer(&side, true), "one")
            .await
            .unwrap()
    );
    assert!(
        db.agent_skills(ctx, &agent)
            .await
            .unwrap()
            .library
            .is_empty()
    );
    test.stop().await;
}

#[tokio::test]
async fn tenant_b_reaches_nothing_of_tenant_as_library() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let db = &test.db;
    for (actor, victim) in tenants.crossings() {
        let theirs = add(db, victim, "theirs", true).await;
        let agent = agent(db, victim).await;
        assert!(
            db.set_agent_skill(&victim.ctx, &agent, "theirs", true)
                .await
                .unwrap()
        );
        let me = viewer(actor, true);

        assert!(db.skill(&actor.ctx, "theirs").await.unwrap().is_none());
        assert!(db.list_skills(&actor.ctx).await.unwrap().is_empty());
        assert!(
            db.skill_versions(&actor.ctx, "theirs")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.update_skill(&actor.ctx, &me, "theirs", &text("mine"), None, None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!db.delete_skill(&actor.ctx, &me, "theirs").await.unwrap());
        // Their agent has none of the actor's skills, and the actor's switch finds no skill.
        assert!(
            !db.set_agent_skill(&actor.ctx, &agent, "theirs", true)
                .await
                .unwrap()
        );
        assert!(
            db.agent_skills(&actor.ctx, &agent)
                .await
                .unwrap()
                .library
                .is_empty()
        );
        // The same name in the actor's library is another skill, with its own id.
        let mine = add(db, actor, "theirs", true).await;
        assert_ne!(mine.id, theirs.id);
        assert_eq!(
            db.skill(&victim.ctx, "theirs").await.unwrap().unwrap().id,
            theirs.id
        );
        db.delete_skill(&actor.ctx, &me, "theirs").await.unwrap();
        db.delete_skill(&victim.ctx, &viewer(victim, true), "theirs")
            .await
            .unwrap();
    }
    test.stop().await;
}
