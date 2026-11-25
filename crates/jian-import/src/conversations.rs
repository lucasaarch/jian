//! Agents, conversations and messages: the old profiles, sessions and messages, into the agents,
//! threads and messages of the core.
//!
//! These three domains belong to the owner: every agent is made by them (visible to the whole
//! workspace, as the old install had one owner and no walls) and every direct chat is theirs. So
//! each is `skipped` until the `owner` domain has put them in, and says so. The mapping of one
//! row is `jian_store`'s (`legacy_threads`); this reads the rows and counts what the store did.
//!
//! What the core cannot say yet is kept, not dropped: a message's reactions, the channel's own
//! copy of it, its tool call and its purpose go into one `legacy` part, whole. What is dropped:
//! a profile's model, identity, context policy and shell switch; a session's summary, mode,
//! objective, project, machine and protection; a contact's approval state. Sessions between two
//! agents are not imported (the core has no thread of agents with no member); the threads
//! marker counts them.

use jian_store::{
    AccountId, Database, ImportOutcome, ImportResult, ImportStatus, StoreError, TenantCtx,
};

use crate::ImportError;
use crate::outcome::{Tally, skipped};
use crate::reader::LegacyReader;

const NO_TABLE: &str = "the old database has no such table";
/// How many messages of one thread go in one transaction.
const BATCH: usize = 500;

/// The imported owner: the member the options name, once the `owner` domain is done. The inner
/// `Err` is the result of a domain that is skipped for lack of them.
pub(crate) async fn owner(
    db: &Database,
    ctx: &TenantCtx,
    email: Option<&str>,
) -> Result<Result<AccountId, ImportResult>, StoreError> {
    let markers = db.imports(ctx).await?;
    let done = markers
        .iter()
        .any(|m| m.domain == "owner" && m.status == ImportStatus::Done);
    if !done {
        return Ok(Err(skipped(
            "the owner is not imported yet: agents and conversations are made by them",
        )));
    }
    let member = match email.map(str::trim).filter(|e| !e.is_empty()) {
        Some(email) => db.member_by_email(ctx, email).await?,
        None => None,
    };
    Ok(member.map(|m| m.account_id).ok_or_else(|| {
        skipped(
            "the owner's address is not a member of this workspace, so there is no one to \
             make the agents and chats; give it with --import-owner-email",
        )
    }))
}

fn count(tally: &mut Tally, what: &str, id: &str, outcome: Result<ImportOutcome, StoreError>) {
    match outcome {
        Ok(ImportOutcome::Imported) => tally.imported(),
        Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
        Err(error) => {
            tracing::warn!(%what, %id, %error, "a row of the old Jian was not imported");
            tally.failed(format!("{what} {id}: {error}"));
        }
    }
}

pub(crate) async fn agents(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !reader.has_table("profiles").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for agent in reader.agents().await? {
        let id = agent.id.clone();
        let outcome = db.import_agent(ctx, &owner, &agent).await;
        count(&mut tally, "agent", &id, outcome);
    }
    Ok(tally.finish(None))
}

pub(crate) async fn threads(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !reader.has_table("sessions").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for thread in reader.threads().await? {
        let id = thread.id.clone();
        let outcome = db.import_thread(ctx, &owner, &thread).await;
        count(&mut tally, "thread", &id, outcome);
    }
    let between = reader.sessions_between_agents().await?;
    let note = (between > 0).then(|| {
        format!("{between} sessions between two agents were not imported (the core has no thread of agents alone)")
    });
    Ok(tally.finish(note.as_deref()))
}

pub(crate) async fn messages(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !reader.has_table("messages").await? || !reader.has_table("sessions").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for thread in reader.threads().await? {
        let all = reader.messages(&thread.id).await?;
        for chunk in all.chunks(BATCH) {
            match db.import_messages(ctx, &owner, &thread.id, chunk).await {
                Ok(answers) => {
                    for (message, answer) in chunk.iter().zip(answers) {
                        count(&mut tally, "message", &message.id, answer);
                    }
                }
                // The thread is not there (its own row failed): each message of the chunk is a
                // failure of its own, so the marker's count says how many did not come.
                Err(error) => {
                    tracing::warn!(thread = %thread.id, %error, "messages were not imported");
                    for message in chunk {
                        tally.failed(format!("message {}: {error}", message.id));
                    }
                }
            }
        }
    }
    Ok(tally.finish(None))
}
