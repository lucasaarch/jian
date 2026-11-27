//! The agent's tools about people.
//!
//! A person is what the agent knows about someone, never what they may reach. The tools act as
//! the agent, on its own people only. None of them links an identity to a person that exists: it
//! asks (`person_link_identity`) and the creator confirms with a code, from a channel (see
//! [`crate::receive`]) or the panel. A run for someone the agent does not know has none of them;
//! it has [`stranger_tools`], which can only answer that chat (the run's own answer) and tell the
//! creator.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_runtime::{Tool, ToolEnv, Tools};
use jian_store::{Identity, Person, PersonId, PersonRole, StoreError};
use serde_json::{Value, json};

use crate::channel_hub::{ChannelHub, creator_text};

/// The only tool of a run for someone the agent does not know.
pub const TELL_CREATOR: &str = "tell_creator";

/// What an identity of a person says about channels, for the tool descriptions that take one.
const CHANNELS_HELP: &str = "channel is whatsapp, telegram, discord, slack, teams or jian (a member's account id). On Telegram a bot can only write to someone who already sent it /start, so a Telegram person has to start the bot first.";

/// The tools of a run for a stranger: tell the creator, and nothing that reads or changes data.
#[must_use]
pub fn stranger_tools(channels: Option<ChannelHub>) -> Tools {
    Tools::new().with(Arc::new(TellCreator { channels }))
}

/// The people tools of a run that is not for a stranger.
#[must_use]
pub fn people_tools(channels: Option<ChannelHub>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(Find),
        Arc::new(Get),
        Arc::new(Create),
        Arc::new(Update),
        Arc::new(Note),
        Arc::new(Link { channels }),
    ]
}

fn text_of<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("`{key}` is required and must be a non-empty string"))
}

fn identity_of(value: &Value) -> Result<Identity, String> {
    Ok(Identity::new(
        text_of(value, "channel")?,
        text_of(value, "address")?,
    ))
}

fn role_of(input: &Value) -> Result<Option<PersonRole>, String> {
    match input.get("role").and_then(Value::as_str) {
        None => Ok(None),
        Some(word) => match PersonRole::parse(word) {
            Some(PersonRole::Known) => Ok(Some(PersonRole::Known)),
            Some(PersonRole::Blocked) => Ok(Some(PersonRole::Blocked)),
            _ => Err("`role` is known or blocked".to_owned()),
        },
    }
}

fn failed(error: &StoreError) -> String {
    match error {
        StoreError::Conflict(why) | StoreError::InvalidWorkspace(why) => (*why).to_owned(),
        _ => "that could not be done now".to_owned(),
    }
}

fn view(person: &Person) -> Value {
    json!({
        "id": person.id.as_str(),
        "name": person.name,
        "role": person.role.as_str(),
        "identities": person.identities.iter().map(|i| json!({
            "channel": i.channel, "address": i.address, "name": i.display_name,
        })).collect::<Vec<_>>(),
    })
}

fn spec(name: &str, description: &str, properties: &Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: json!({"type": "object", "properties": properties, "required": required}),
        cache: false,
    }
}

struct Find;

impl Tool for Find {
    fn name(&self) -> &'static str {
        "people_find"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "people_find",
            "Finds the people you know by part of a name or of an address (a number, a chat id). Without a query it lists them. It reads what you know about people, not what they may reach.",
            &json!({"query": {"type": "string"}}),
            &[],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let query = input.get("query").and_then(Value::as_str);
            let found = env
                .db
                .search_people(env.ctx, env.agent, query)
                .await
                .map_err(|e| failed(&e))?;
            Ok(json!(found.iter().map(view).collect::<Vec<_>>()).to_string())
        })
    }
}

struct Get;

impl Tool for Get {
    fn name(&self) -> &'static str {
        "person_get"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "person_get",
            "Reads one person you know: name, role, identities and your notes about them.",
            &json!({"id": {"type": "string"}}),
            &["id"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = PersonId::new(text_of(input, "id")?.to_owned());
            let person = env
                .db
                .person(env.ctx, env.agent, &id)
                .await
                .map_err(|e| failed(&e))?
                .ok_or("you do not know that person")?;
            let notes = env
                .db
                .person_notes(env.ctx, env.agent, &id, env.now_ms)
                .await
                .map_err(|e| failed(&e))?;
            let mut out = view(&person);
            out["notes"] = json!(notes.iter().map(|n| n.content.clone()).collect::<Vec<_>>());
            Ok(out.to_string())
        })
    }
}

struct Create;

impl Tool for Create {
    fn name(&self) -> &'static str {
        "person_create"
    }

    fn spec(&self) -> ToolSpec {
        let description = format!(
            "Adds someone you know, with how to reach them, even if they never wrote to you. role is known (default) or blocked. An identity that already belongs to a person is refused: use person_link_identity to ask for it. {CHANNELS_HELP}"
        );
        spec(
            "person_create",
            &description,
            &json!({
                "name": {"type": "string"},
                "role": {"type": "string", "enum": ["known", "blocked"]},
                "identities": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"channel": {"type": "string"}, "address": {"type": "string"}},
                    "required": ["channel", "address"]
                }}
            }),
            &["name"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let identities = input
                .get("identities")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(identity_of).collect::<Result<Vec<_>, _>>())
                .transpose()?
                .unwrap_or_default();
            let role = role_of(input)?.unwrap_or(PersonRole::Known);
            let person = env
                .db
                .create_person(
                    env.ctx,
                    env.agent,
                    text_of(input, "name")?,
                    role,
                    &identities,
                    &format!("run:{}", env.run),
                )
                .await
                .map_err(|e| failed(&e))?;
            Ok(view(&person).to_string())
        })
    }
}

struct Update;

impl Tool for Update {
    fn name(&self) -> &'static str {
        "person_update"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "person_update",
            "Renames a person you know, or makes them known or blocked (a blocked person gets no answer). Your creator cannot be changed.",
            &json!({
                "id": {"type": "string"},
                "name": {"type": "string"},
                "role": {"type": "string", "enum": ["known", "blocked"]}
            }),
            &["id"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = PersonId::new(text_of(input, "id")?.to_owned());
            let name = input.get("name").and_then(Value::as_str);
            let person = env
                .db
                .update_person(env.ctx, env.agent, &id, name, role_of(input)?)
                .await
                .map_err(|e| failed(&e))?
                .ok_or("you do not know that person, or it is your creator")?;
            Ok(view(&person).to_string())
        })
    }
}

struct Note;

impl Tool for Note {
    fn name(&self) -> &'static str {
        "person_note"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "person_note",
            "Notes something about a person you know. It is one of your memories, linked to them.",
            &json!({"id": {"type": "string"}, "note": {"type": "string"}}),
            &["id", "note"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = PersonId::new(text_of(input, "id")?.to_owned());
            env.db
                .add_person_note(
                    env.ctx,
                    env.agent,
                    &id,
                    text_of(input, "note")?,
                    Some(env.thread.clone()),
                    env.now_ms,
                )
                .await
                .map_err(|e| failed(&e))?
                .ok_or("you do not know that person")?;
            Ok("noted".to_owned())
        })
    }
}

struct Link {
    channels: Option<ChannelHub>,
}

impl Tool for Link {
    fn name(&self) -> &'static str {
        "person_link_identity"
    }

    fn spec(&self) -> ToolSpec {
        let description = format!(
            "Asks to link one more identity to a person you know (they changed number, or write from another channel). It does NOT link it: the request waits for your creator, who is told and confirms it with a code. Tell whoever asked that it waits. {CHANNELS_HELP}"
        );
        spec(
            "person_link_identity",
            &description,
            &json!({
                "id": {"type": "string"},
                "channel": {"type": "string"},
                "address": {"type": "string"}
            }),
            &["id", "channel", "address"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = PersonId::new(text_of(input, "id")?.to_owned());
            let identity = identity_of(input)?;
            let asked = env
                .db
                .request_identity_link(
                    env.ctx,
                    env.agent,
                    &id,
                    &identity,
                    &format!("run:{}", env.run),
                )
                .await
                .map_err(|e| failed(&e))?
                .ok_or("you do not know that person, or you do not answer them")?;
            let request = asked.request;
            if asked.created
                && let Some(channels) = &self.channels
            {
                let text = format!(
                    "Link {} on {} to a person? Send /confirm {} or /deny {}.",
                    request.identity.address, request.identity.channel, request.code, request.code
                );
                if let Err(error) = channels.tell_creator(env.ctx, env.agent, &text).await {
                    tracing::warn!(%error, "telling the creator about an identity link failed");
                }
            }
            Ok(format!(
                "waiting for your creator to confirm (code {}); it is not linked yet",
                request.code
            ))
        })
    }
}

struct TellCreator {
    channels: Option<ChannelHub>,
}

impl Tool for TellCreator {
    fn name(&self) -> &'static str {
        TELL_CREATOR
    }

    fn spec(&self) -> ToolSpec {
        spec(
            TELL_CREATOR,
            "Sends a short message to your creator about the person writing now, who you do not know: say who they say they are and what they want. The creator is told where they write from; you do not need to say. Your own answer goes to this chat.",
            &json!({"text": {"type": "string"}}),
            &["text"],
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let said: String = text_of(input, "text")?.chars().take(500).collect();
            let channels = self
                .channels
                .as_ref()
                .ok_or("no channel is connected here")?;
            // Where they write from is read from the thread, never taken from the model.
            let (provider, chat) = channels
                .chat_of(env.ctx, env.agent, env.thread)
                .await
                .map_err(|e| failed(&e))?
                .ok_or("this is not a chat")?;
            channels
                .tell_creator(env.ctx, env.agent, &creator_text(&provider, &chat, &said))
                .await
                .map_err(|_| "the creator could not be reached now".to_owned())?;
            Ok("told".to_owned())
        })
    }
}
