//! The old `WhatsApp` and Telegram channels, as the chat accounts of the agents made from their
//! profiles.
//!
//! What comes over: the account, under its old id, with the people who were approved to talk to
//! the agent in a direct chat. The account is `needs_pairing`: the old session (`channel_auth`)
//! cannot be carried over, so a person pairs it again from the agent's page. The owner's address
//! is left empty: nothing in the old `channels` says whose number `address` is.
//!
//! What stays behind: `channel_auth` (the session), pending and blocked contacts, group
//! approvals, and the channels of kinds the core has no connection for (`whatsapp-business`,
//! `email`, `api`) or that were revoked. The chats come with the threads, in their own domain.

use jian_store::{Database, ImportResult, LegacyChannelAccount, TenantCtx};

use crate::ImportError;
use crate::conversations::owner;
use crate::outcome::Tally;
use crate::reader::LegacyReader;

const NO_TABLE: &str = "the old database has no such table";

pub(crate) async fn import(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !(reader.has_table("channels").await? && reader.has_table("contacts").await?) {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for channel in reader.channels().await? {
        let provider = match channel.kind.as_str() {
            "whatsapp" | "telegram" if channel.revoked => {
                tally.left_out("revoked channels");
                continue;
            }
            "whatsapp" | "telegram" => channel.kind.clone(),
            _ => {
                tally.left_out("channels of a kind the core cannot connect");
                continue;
            }
        };
        let id = channel.id;
        let agent = match db.agent_of_legacy(ctx, &channel.profile_id).await {
            Ok(Some(agent)) => agent,
            Ok(None) => {
                tally.failed(format!("channel {id}: its agent was not imported"));
                continue;
            }
            Err(error) => {
                tally.failed(format!("channel {id}: {error}"));
                continue;
            }
        };
        let legacy = LegacyChannelAccount {
            legacy_id: id.clone(),
            agent,
            provider,
            owner_address: None,
            approved: channel.approved,
        };
        match db.import_channel_account(ctx, &owner, &legacy).await {
            Ok(true) => tally.imported(),
            Ok(false) => tally.already_there(),
            Err(error) => {
                tracing::warn!(%id, %error, "a channel of the old Jian was not imported");
                tally.failed(format!("channel {id}: {error}"));
            }
        }
    }
    Ok(tally.finish(Some(
        "the sessions were not carried over: pair each account again",
    )))
}
