//! Channel accounts against a real Postgres: one number sticks to an account, an unknown sender
//! stays unknown, and the import of the old Jian's accounts can repeat.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{
    AgentId, ChannelStatus, Database, LegacyChannelAccount, NewAgent, PersonRole, Sender, Viewer,
};
use jian_testkit::{Side, TestDb, TwoTenants};

fn viewer(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

async fn agent(db: &Database, side: &Side) -> AgentId {
    let new = NewAgent {
        name: "bot".to_owned(),
        description: String::new(),
        instructions: String::new(),
        avatar: None,
        visibility: Visibility::Workspace,
        viewers: Vec::new(),
    };
    db.create_agent(&side.ctx, &viewer(side), &new)
        .await
        .unwrap()
        .id
}

#[tokio::test]
async fn the_first_number_sticks_until_the_account_is_disconnected() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let bot = agent(db, &side).await;
    let made = db
        .create_channel_account(&side.ctx, &viewer(&side), &bot, "whatsapp", None)
        .await
        .unwrap();
    assert_eq!(made.status, ChannelStatus::NeedsPairing);
    // One account per agent and provider.
    assert!(
        db.create_channel_account(&side.ctx, &viewer(&side), &bot, "whatsapp", None)
            .await
            .is_err()
    );

    assert!(
        db.bind_channel_address(&side.ctx, &made.id, "111@s")
            .await
            .unwrap()
    );
    assert!(
        db.bind_channel_address(&side.ctx, &made.id, "111@s")
            .await
            .unwrap()
    );
    assert!(
        !db.bind_channel_address(&side.ctx, &made.id, "222@s")
            .await
            .unwrap()
    );
    db.clear_channel_address(&side.ctx, &made.id).await.unwrap();
    assert!(
        db.bind_channel_address(&side.ctx, &made.id, "222@s")
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn an_unknown_sender_stays_unknown_and_the_owner_number_is_the_creator() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let bot = agent(db, &side).await;
    let acct = db
        .create_channel_account(&side.ctx, &viewer(&side), &bot, "whatsapp", Some("999@s"))
        .await
        .unwrap();

    // Writing never makes anyone known: asking twice finds nobody both times.
    for _ in 0..2 {
        let found = db.resolve_sender(&side.ctx, &acct, "333@s").await.unwrap();
        assert_eq!(found, Sender::Unknown);
    }
    let Sender::Person(owner) = db.resolve_sender(&side.ctx, &acct, "999@s").await.unwrap() else {
        panic!("the owner's number is the creator");
    };
    assert_eq!(owner.role, PersonRole::Creator);
}

#[tokio::test]
async fn the_old_jians_account_comes_over_once_and_asks_to_be_paired_again() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let bot = agent(db, &side).await;
    let legacy = LegacyChannelAccount {
        legacy_id: "old-1".to_owned(),
        agent: bot.clone(),
        provider: "whatsapp".to_owned(),
        owner_address: Some("999@s".to_owned()),
        approved: vec![("444@s".to_owned(), Some("Bia".to_owned()))],
    };
    let by = &side.admin.account_id;
    assert!(
        db.import_channel_account(&side.ctx, by, &legacy)
            .await
            .unwrap()
    );
    assert!(
        !db.import_channel_account(&side.ctx, by, &legacy)
            .await
            .unwrap()
    );

    let accounts = db.channel_accounts_of(&side.ctx, &bot).await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].status, ChannelStatus::NeedsPairing);
    // The approved contact is a known person, once, even after the second import.
    let Sender::Person(bia) = db
        .resolve_sender(&side.ctx, &accounts[0], "444@s")
        .await
        .unwrap()
    else {
        panic!("the approved contact is a person");
    };
    assert_eq!((bia.role, bia.name.as_str()), (PersonRole::Known, "Bia"));
    let people = db.people_of(&side.ctx, &bot).await.unwrap();
    assert_eq!(people.len(), 2, "the creator and Bia");
}
