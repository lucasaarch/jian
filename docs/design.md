# Jian: first gateway

Jian gives each agent profile one persistent identity shared by independent sessions.
The first deliverable is a self-hosted, single-owner HTTP backend. Channel connectors, semantic retrieval, arbitrary shell execution and automatic
continuation after an uncertain external effect are subsequent milestones.

## Design

TypeScript on Node 24+, Fastify, AI SDK, PostgreSQL and pg-boss. Native provider
adapters keep the deployment independent of a hosted AI gateway. PostgreSQL stores
versioned JSON records with indexed kind/profile/session fields. Mutations take a
transaction-scoped advisory lock per profile; model calls never hold that lock.
Different sessions can execute concurrently; a session accepts one active run.

The worker reconstructs bounded context before each model step: pinned profile
instructions, recent session messages, shared memory and current profile activity.
Cross-session history and skills are retrieved through scoped tools. The gateway
uses explicit memory writes; it does not claim automatic semantic understanding.
All sessions in a profile share one owner's trust boundary. Separate profiles are
isolated. Group chats and multi-user access require a later ACL design.

Provider API keys are encrypted in the per-profile vault and never API-returned secret values.
Administrative bearer authentication protects every endpoint except liveness.
MCP HTTP servers have explicit tool allowlists. Profile self-editing is opt-in,
versioned and cannot grant new provider credentials or management permissions.

Runs and user messages are committed together. A periodic dispatcher enqueues queued
runs using singleton keys, so a crash between commit and enqueue does not lose work.
Workers claim runs atomically; a lease protects against abandoned executions. A lost
lease marks the run interrupted, preserving completed messages and step checkpoints.
Interrupted tool calls are never automatically replayed. External effects cannot be
made exactly-once merely by queue configuration.

## Acceptance

Two sessions share explicit memory and live activity. Other profiles cannot read it.
A duplicate request key creates only one message and run. Concurrent profile edits
cannot overwrite each other silently. Model errors do not disclose credentials.
API reads and the event stream remain authenticated. Local tests use an in-memory
storage adapter and AI SDK test models; real PostgreSQL and pg-boss run in CI.
