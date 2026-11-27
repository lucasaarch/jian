//! Channel accounts against a real Postgres: one number sticks to an account, a stranger is
//! remembered as pending, and the import of the old Jian's accounts can repeat.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_core::Visibility;
use jian_store::{
    AgentId, ChannelStatus, ContactStatus, Database, LegacyChannelAccount, NewAgent, Viewer,
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
async fn a_stranger_is_pending_once_and_a_decision_is_kept() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let db = &test.db;
    let bot = agent(db, &side).await;
    let acct = db
        .create_channel_account(&side.ctx, &viewer(&side), &bot, "whatsapp", None)
        .await
        .unwrap();

    let first = db
        .see_channel_contact(&side.ctx, &acct.id, "333@s", None)
        .await
        .unwrap();
    let again = db
        .see_channel_contact(&side.ctx, &acct.id, "333@s", Some("Ana"))
        .await
        .unwrap();
    assert!(first.first_time && !again.first_time);
    assert_eq!(again.status, ContactStatus::Pending);

    let by = &side.admin.account_id;
    let approved = ContactStatus::Approved;
    assert!(
        db.decide_channel_contact(&side.ctx, &acct.id, "333@s", approved, by)
            .await
            .unwrap()
    );
    assert!(
        !db.decide_channel_contact(&side.ctx, &acct.id, "nobody", approved, by)
            .await
            .unwrap()
    );
    let seen = db
        .see_channel_contact(&side.ctx, &acct.id, "333@s", None)
        .await
        .unwrap();
    assert_eq!(seen.status, ContactStatus::Approved);
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
    let contacts = db
        .channel_contacts(&side.ctx, &accounts[0].id)
        .await
        .unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0].status, ContactStatus::Approved);
}
