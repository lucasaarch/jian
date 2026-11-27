//! The old `WhatsApp` and Telegram channels, as the chat accounts of the agents made from their
//! profiles.
//!
//! What comes over: the account, under its old id, with the people who were approved to talk to
//! the agent in a direct chat. The account is `needs_pairing`: the old session (`channel_auth`)
//! cannot be carried over, so a person pairs it again from the agent's page. The owner's address
//! is left empty: nothing in the old `channels` says whose number `address` is.
//!
//! The exception is a Telegram bot's token. The `secrets` domain (which runs first, and needs the
//! old master key) leaves it in the vault as `profile:<profile>:channel:<id>`; it is put in the
//! new account's session as `token`, and the hub connects an account that has one on its own.
//! Only when the account is made now: a run later never returns a token that was replaced or
//! wiped since. Without the key, or without the token, the account waits to be given one.
//!
//! What stays behind: `channel_auth` (the session), pending and blocked contacts, group
//! approvals, and the channels of kinds the core has no connection for (`whatsapp-business`,
//! `email`, `api`) or that were revoked. The chats come with the threads, in their own domain.

use jian_store::secrets::Secret;
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
            token: if channel.kind == "telegram" {
                bot_token(db, ctx, &channel.profile_id, &id).await
            } else {
                None
            },
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
        "the sessions were not carried over: pair each account again (a Telegram bot's token \
         comes over when the secrets do)",
    )))
}

/// The bot token the `secrets` domain left for the old channel, when it is one the Bot API can
/// take (the shape `POST /v1/agents/{id}/channels` also asks of it). Anything else leaves the
/// account to be given a token, with nothing said of the text.
async fn bot_token(db: &Database, ctx: &TenantCtx, profile: &str, channel: &str) -> Option<Secret> {
    let owner = format!("profile:{profile}:channel:{channel}");
    let found = match db.vault().read(ctx, &owner).await {
        Ok(found) => found?,
        Err(error) => {
            tracing::warn!(%owner, %error, "the token of an old channel could not be read");
            return None;
        }
    };
    let token = found.expose().trim();
    let fits = !token.is_empty() && token.len() <= 200 && !token.chars().any(char::is_whitespace);
    fits.then(|| Secret::new(token))
}
