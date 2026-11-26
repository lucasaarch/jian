//! The tools that make and change artifacts: `create_artifact`, `update_artifact` and
//! `read_artifact`. None needs the run's machine; the run stays light.
//!
//! A run acts for its thread ([`ArtifactActor::Run`]): what it makes is linked to that thread and
//! to the thread's project, and it reads and edits only the artifacts of those two. The model
//! never names a thread or a project, so it cannot reach another conversation's work. Only
//! `read_artifact` reads without changing anything, so a run that may only suggest has it and
//! not the other two.
//!
//! The tools tell the run's listener as they go ([`ArtifactEvent`]): `Writing` when the call is
//! in hand and before it is saved, then what was saved. The model's stream hands a tool call over
//! whole, so there is one `Writing` per call, not one per piece of the source.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::{ArtifactKind, MAX_SOURCE_EDITS, SourceEdit};
use jian_llm::ToolSpec;
use jian_store::{Artifact, ArtifactActor, ArtifactId, ArtifactVersion, NewArtifact};
use serde_json::{Value, json};

use crate::run::RunEvent;
use crate::tool::{Tool, ToolEnv};

/// The names of the three tools.
pub const ARTIFACT_TOOLS: [&str; 3] = ["create_artifact", "update_artifact", "read_artifact"];

/// What an artifact tool tells the run's listener.
#[derive(Clone, Debug)]
pub enum ArtifactEvent {
    /// The agent is writing an artifact: the call is complete and about to be saved.
    Writing {
        /// The model's id for the call.
        call_id: String,
        /// What it is drawn as.
        kind: String,
        /// Its title.
        title: String,
        /// How long the source is, in characters.
        chars: usize,
    },
    /// The artifact was made, with its first version.
    Created(Artifact),
    /// The artifact got a new version.
    Version {
        /// The artifact now.
        artifact: Artifact,
        /// The version that was written.
        version: ArtifactVersion,
    },
}

pub(crate) fn artifact_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Create), Arc::new(Update), Arc::new(Read)]
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: schema,
        cache: false,
    }
}

fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{key}` is required and must be a string"))
}

fn actor<'a>(env: &'a ToolEnv<'a>) -> ArtifactActor<'a> {
    ArtifactActor::Run {
        thread: env.thread,
        agent: env.agent,
    }
}

fn announce<'a>(env: &'a ToolEnv<'a>, event: ArtifactEvent) -> BoxFuture<'a, ()> {
    env.events.emit(RunEvent::Artifact(event))
}

struct Create;

impl Tool for Create {
    fn name(&self) -> &'static str {
        "create_artifact"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "create_artifact",
            "Makes an artifact beside the conversation: a page, component, document, diagram, \
             sheet or slides the person can open, edit and keep. `content` is its whole source. \
             Change it afterwards with `update_artifact`.",
            json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ArtifactKind::ALL.map(ArtifactKind::as_str),
                        "description": "html: a page; react: a component; markdown: a document; \
                            mermaid: a diagram; deck: slides as JSON; sheet: a table; diagram: a drawing."
                    },
                    "title": { "type": "string", "description": "A short name, at most 120 characters." },
                    "content": { "type": "string", "description": "The whole source." }
                },
                "required": ["kind", "title", "content"]
            }),
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
            let kind = ArtifactKind::parse(text(input, "kind")?).ok_or(
                "`kind` is html, react, markdown, mermaid, deck, sheet or diagram".to_owned(),
            )?;
            let title = text(input, "title")?;
            let content = text(input, "content")?;
            announce(
                env,
                ArtifactEvent::Writing {
                    call_id: env.call_id.to_owned(),
                    kind: kind.as_str().to_owned(),
                    title: title.to_owned(),
                    chars: content.chars().count(),
                },
            )
            .await;
            let (artifact, version) = env
                .db
                .create_artifact(
                    env.ctx,
                    actor(env),
                    &NewArtifact {
                        kind,
                        title: title.to_owned(),
                        content: content.to_owned(),
                        thread: None,
                        project: None,
                    },
                )
                .await
                .map_err(|e| e.to_string())?
                .ok_or("the artifact could not be made in this conversation")?;
            announce(env, ArtifactEvent::Created(artifact.clone())).await;
            Ok(format!(
                "made the artifact `{}` \"{}\" (version {})",
                artifact.id, artifact.title, version.version
            ))
        })
    }
}

struct Update;

impl Tool for Update {
    fn name(&self) -> &'static str {
        "update_artifact"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "update_artifact",
            "Changes an artifact of this conversation or its project by exact-text edits, as a \
             new version. Each `find` must occur exactly once in the text the edits before it \
             left; if one does not, nothing is changed. Read the artifact first if you do not \
             have its latest source.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "edits": {
                        "type": "array",
                        "maxItems": MAX_SOURCE_EDITS,
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": { "type": "string" },
                                "replace": { "type": "string" }
                            },
                            "required": ["find", "replace"]
                        }
                    }
                },
                "required": ["id", "edits"]
            }),
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
            let id = ArtifactId::new(text(input, "id")?.to_owned());
            let edits = edits_of(input)?;
            let Some(before) = env
                .db
                .artifact(env.ctx, actor(env), &id)
                .await
                .map_err(|e| e.to_string())?
            else {
                return Err(not_found(&id));
            };
            announce(
                env,
                ArtifactEvent::Writing {
                    call_id: env.call_id.to_owned(),
                    kind: before.kind.as_str().to_owned(),
                    title: before.title.clone(),
                    chars: edits.iter().map(|e| e.replace.chars().count()).sum(),
                },
            )
            .await;
            let version = env
                .db
                .edit_artifact(env.ctx, actor(env), &id, &edits)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| not_found(&id))?;
            if let Some(artifact) = env
                .db
                .artifact(env.ctx, actor(env), &id)
                .await
                .map_err(|e| e.to_string())?
            {
                let event = ArtifactEvent::Version {
                    artifact,
                    version: version.clone(),
                };
                announce(env, event).await;
            }
            Ok(format!(
                "changed the artifact `{id}`: it is now version {}",
                version.version
            ))
        })
    }
}

struct Read;

impl Tool for Read {
    fn name(&self) -> &'static str {
        "read_artifact"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "read_artifact",
            "Reads the source of an artifact of this conversation or its project: the latest \
             version, or the one named.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "version": { "type": "integer", "description": "From 1; the latest by default." }
                },
                "required": ["id"]
            }),
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
            let id = ArtifactId::new(text(input, "id")?.to_owned());
            let version = input
                .get("version")
                .and_then(Value::as_i64)
                .map(|v| i32::try_from(v).map_err(|_| "`version` is not a version".to_owned()))
                .transpose()?;
            let found = env
                .db
                .artifact_version(env.ctx, actor(env), &id, version)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!(
                        "`{id}` has no such version, or is not in this conversation or its project"
                    )
                })?;
            Ok(found.content)
        })
    }
}

fn not_found(id: &ArtifactId) -> String {
    format!("no artifact `{id}` in this conversation or its project")
}

fn edits_of(input: &Value) -> Result<Vec<SourceEdit>, String> {
    let list = input
        .get("edits")
        .and_then(Value::as_array)
        .ok_or("`edits` is required and must be a list")?;
    if list.len() > MAX_SOURCE_EDITS {
        return Err(format!("at most {MAX_SOURCE_EDITS} edits at once"));
    }
    list.iter()
        .enumerate()
        .map(|(at, edit)| {
            let part = |key: &str| {
                edit.get(key)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| format!("edit {} needs a text `{key}`", at + 1))
            };
            Ok(SourceEdit {
                find: part("find")?,
                replace: part("replace")?,
            })
        })
        .collect()
}
