# Gateway architecture

```text
Clients / channels -> API and contracts -> services -> PostgreSQL
                                                    -> queue -> runtime -> provider / MCP
```

`apps/gateway` holds the runnable product. `packages/contracts` defines the inputs, the public outputs, the permissions and the stable operation identifiers. `packages/sdk` depends only on the generated HTTP contract. Each product keeps its own tests and build; Biome, pnpm and the git hooks are shared at the root.

Every area is a folder under `apps/gateway/src` with a service, its routes, its port and its record types; a new area is a new folder with those four pieces. Dependency runs one way: `core/` — errors, clock, store, events — knows no area, the areas depend on `core/`, `app.ts` registers each area's routes and `main.ts` assembles the process. The map of persisted records lives in `src/records.ts`, next to `src/services.ts`, in the composition layer, because listing the areas is the job of whoever composes them; in `core/` it would make `core/` import back what depends on it. A consumer is handed the port it needs, never the whole service: `agent/tools.ts` declares `ProfileAdmin`, `MemoryWriter`, `SessionReader`, `RunReader`, `PeerAgents` and `RunExecution`, never the classes that satisfy them.

Profiles, revisions, sessions, messages, memories and runs are areas of the gateway; `Vault`, `Coordination`, `Peers` and `Channels` isolate encrypted storage, history/artifacts/leases, conversation between profiles, and outside transport. The vault has no routes of its own: every secret is addressed by the thing that uses it (`provider:<id>`, `mcp:<name>`, `channel:<id>`), so removing that thing removes the secret. The HTTP layer holds no provider rules and never touches a ciphertext. `http/security.ts` centralises authentication and public errors; `http/events.ts` owns the event connections. Inside `agent/`, MCP discovery and result handling stay apart from running the agent.

Channels implement `Channel` and are chosen through an adapter registry. The shared service owns access and durable delivery; each adapter translates only its own protocol. See [Channels](channels.md).

PostgreSQL stores typed records and durable events. Indexes cover profile/type/order, JSONB filters and text search over content and keys. History pages through a record cursor and a monotonic sequence, never OFFSET. Transactions are short and take a per-profile advisory lock; no model call ever happens inside one.

Versioned migrations run in a transaction under a global lock. The first version can adopt an existing installation; a schema newer than the binary stops it from starting. Legacy profiles and snapshots are given identity and budget defaults when read. Historic revisions keep the version they were written with.

The dispatcher hands persisted runs to pg-boss; a transactional claim keeps two workers from executing the same run. A lease and a heartbeat detect a worker that is gone. Checkpoints record when a tool starts and how a step ended. Large results are referenced as artifacts; small ones are persisted with a cap and with known secrets redacted.

Tools are loaded within a run rather than offered all at once. Every definition is re-sent on every model call, so a complete set is paid for by turns that use none of it — measured at 8.5 KB of prompt for a greeting. What stays always available is what a turn is likely to need before it can ask: memory, skills, the profile's own activity, and the other agents, so a conversation between profiles still costs one call. The rest — files, commands, other sessions, long-running work, contacts, self-management — is named in one loader and arrives when the agent asks for it. MCP tools follow the same rule, by server. A group loaded stays loaded for that run and for no other.

A run is bounded twice: by how many model calls it may make, and by how many tokens it may spend. The token bound counts new input and output, never the part the provider read back from its own cache — every step carries the whole prompt again, and charging a run for re-sending what it already sent ends ordinary tool loops halfway.

An Anthropic prompt is marked so the provider reads its stable part back instead of receiving it again: the tool definitions and the instructions are identical on every step of a run and on every turn of a session, and a second mark covers the steps this run has already taken. OpenAI matches a long prefix without being told. A prefix below the model's minimum is simply not cached.

Every request to a model carries the whole prompt: the protocol keeps nothing between calls, so the saving is never in sending less of what matters but in there being less of it to send. Two things do that. Caching makes the stable part cheap to re-read. Compaction makes the conversation itself smaller: once a prepared prompt passes 85% of what the budget leaves for it, the turns before the last six are replaced by a record the agent's own model writes — the open request, what was done, the state, the decisions, the corrections and what is still open. The turns stay in the database and in the panel; only the prompt stops carrying them. The record is kept on the session, folded into on the next compaction, and the chat is told it is happening, because summarising costs a request of its own and silence for that long reads as the agent having stopped. A compaction that fails is not the run's failure: the step proceeds and the oldest blocks are dropped, as before.

The context is assembled on every step. Instructions, identity and the small catalogs are the stable part. Relevant memories, activity from other sessions and recent history are the moving part. The budget also counts the active tool schemas and the tool results. When history has to shrink, a tool call and its result are kept together. Each block is tokenized once per preparation, and a cut subtracts a cost already counted. If the mandatory turn does not fit, the run fails before the model is called.

Memories are explicit, versioned and shared across the profile; there is no weight training and no literal awareness. Sessions talk to each other through an inbox that can be read back. The agent chooses to look at history, checkpoints, artifacts and other activity through tools.

## Conversation between profiles

A turn that runs out of tool calls is not thrown away: one more request, carrying every result the turn produced and no tools at all, turns the work into an answer that says what was found and what is still unknown.

An agent waiting on a colleague waits for less than a minute. Past that the call is not lost and nobody is held: the answer is addressed to the conversation that asked and arrives there as an ordinary turn once it lands, so the agent that asked passes it on itself. A failure travels the same way.

The isolation between profiles has one declared door, and it carries data only: a profile discovers the others of the installation and speaks to one of them, but what crosses is text. Discovery returns an identifier, a name and the summary the owner wrote — never instructions, identity, skills, memories, credentials or history. Every other read stays bound to the calling profile; no tool and no route reads another profile's records.

A call becomes an ordinary run in the profile being called: its request key, its context, its lease, its checkpoints. It happens in the session that pair of agents shares — one per pair, on the callee's side, marked with `peerProfileId` and invisible to the caller — so colleagues keep continuity instead of starting over on every request. The caller waits for the run to finish and receives its output as text; a colleague that fails or stalls becomes an explicit error, never silence. Both profiles record the event (`agent.call.sent` and `agent.call.received`), which is how the owner audits who spoke to whom.

A conversation between agents ends, because every round costs money. The depth budget travels with the chain: the run a call creates keeps in `call` what has been spent and the ordered list of profiles the conversation passed through, and the callee inherits that spend instead of starting from zero. Going past the limit is a clear error. Only the agent addressed answers — the reply goes back to the caller and to nobody else — and a profile that already spoke in the chain is not called again, so nothing reopens what it closed and no cycle forms.

## Product limits

- No embeddings, semantic search or summarisation by a second model.
- No multiple organisations, and no per-participant ACL inside a profile.
- No public protocol between installations.
- No exactly-once replay guarantee for effects outside the gateway.
- No sandbox around the commands an agent runs, and no arbitrary MCP installer. Skill import is the owner's, from GitHub repositories only, and copies the text instead of following the source.
- No financial accounting in currency; token counts and limits are recorded. Input, output and the part of the input a provider served from its own cache are counted apart, because every provider prices them differently. A step that reports no usage is counted by the gateway itself and marks the whole run as estimated. None of these numbers is a bill.

Extensions must use the public contracts and preserve the authorization boundaries that exist today.
