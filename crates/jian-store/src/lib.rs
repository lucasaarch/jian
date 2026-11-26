//! Persistence through sqlx on Postgres: one the gateway embeds and runs itself, or an external
//! one named by a connection URL, with a schema and a role for each tenant.
//!
//! It owns the single connection pool, the embedded server's life (data directory, credentials,
//! start and stop), the migrations, and the way every query reaches a tenant's data. It does not
//! decide anything about the domain (that is `jian-core`), authenticate anyone, call a model or
//! run a command, and it reads no environment: the binary passes the data directory and the URL
//! in. `jian-runtime` and `jian-server` talk to it.
//!
//! # Tenants
//!
//! A tenant is a schema `tenant_<id>` and a role of the same name that cannot log in, owns the
//! schema and has no right anywhere else. The platform's own data (the list of tenants) is in
//! the schema `platform`, owned by the role `jian_platform`, which no tenant can reach. A shared
//! Cloud gateway has many tenants; a desktop or self-hosted install has one,
//! [`TenantId::self_hosted`].
//!
//! There is one pool, and its user is the database's owner. Every tenant transaction starts with
//! `SET LOCAL ROLE tenant_<id>` and `SET LOCAL search_path TO tenant_<id>` ([`Database::begin`]),
//! and it takes a [`TenantCtx`] to do so, which only [`Database::tenant`] makes. `LOCAL` ends both
//! with the transaction, so a pooled connection never carries one tenant's role to the next.
//!
//! # Slots
//!
//! A tenant hashes to one of 1024 slots ([`slot_of`]), and a slot is owned by at most one
//! gateway instance at a time through a lease in `platform.slot_leases` that expires
//! ([`Database::claim_slots`]). The store holds the SQL and the numbers; keeping the leases
//! renewed and stopping to serve when one is lost is `jian-server`'s. The tables are ephemeral
//! coordination state, so there is nothing of the old Jian to import into them.
//!
//! # Jobs
//!
//! The durable job queue is the table `platform.jobs` ([`Database::enqueue_job`],
//! [`Database::claim_jobs`] and the calls that answer for a job). An instance takes only the jobs
//! of the slots it owns, with `FOR UPDATE SKIP LOCKED`, and an answer counts only from the
//! instance and attempt that holds the job. A payload holds ids and never a secret. The polling
//! loop, the handlers and the drain are `jian-server`'s. Jobs of the old Node gateway's pg-boss
//! are not imported.
//!
//! # Accounts, credentials and members
//!
//! One person is one account in `platform.accounts`, outside any tenant. How they sign in is a row
//! of `platform.credentials` per way ([`CredentialKind`]; only the password has code, as an
//! argon2id hash that `jian-auth` makes and checks). Which workspaces they open, and as what
//! ([`Role`]), is a row of `platform.members`: the same account may be a member of many tenants.
//! Nobody signs themselves up here: a member is added by an admin ([`Database::add_member`]),
//! comes in by an [invitation](Database::create_invite), or is the tenant's first admin
//! ([`Database::add_first_admin`], which is also what the import of the old Jian calls).
//! [`Database::start_session`] writes the session of a person who has proved who they are: a
//! token of kind `session` in `platform.api_tokens` that expires, opens ONE tenant and ends when
//! the person signs out, changes their password, is reset or is disabled. Members and invitations
//! are filtered by the tenant of the caller's token on every statement; that filter is their
//! isolation, and the isolation tests cover it.
//!
//! # Import markers
//!
//! `platform.imports` keeps one row per tenant and domain of the import of the old Node Jian
//! ([`Database::start_import`], [`Database::finish_import`], [`Database::imports`]): where the
//! data came from, how many rows went in and how it ended. The reading and mapping are
//! `jian-import`'s; the store only keeps the place, so a run that stopped halfway is found by
//! the next one.
//!
//! # Agents, threads and messages
//!
//! The workspace of people and agents ([`Database::create_agent`], [`Database::create_thread`],
//! [`Database::post_message`]). Who sees an agent and who sees a thread is each decided in one
//! place (see the `agents` and `threads` modules' notes), and what a caller may not see is
//! `None`, never an error that says it exists. Only a [`Viewer`] built from a member's token
//! reaches these calls. A message written to a thread with an agent in it reaches the
//! [`ThreadObserver`]; a group message also writes the agents' events (the `agent_events` module)
//! in its own transaction.
//!
//! # Migrations and schema versions
//!
//! [`Database::migrate`] brings the platform and then every tenant to the last migration, a few
//! tenants at a time ([`MigrateOptions::concurrency`], 4 by default), each in its own transaction:
//! one that fails is left as it was, named in the [`MigrationReport`], and does not stop the rest.
//! One connection holds the advisory lock for the whole run and the tenants use others, so two
//! gateways still take turns. The report also says which version each schema is at, and which
//! are behind or ahead of the build ([`Database::schema_versions`] reads the same without
//! migrating).
//!
//! [`Database::tenant`] and [`Database::begin`] refuse a tenant that is not at the version the
//! build expects, behind or ahead, with [`StoreError::SchemaBehind`] or
//! [`StoreError::SchemaAhead`]. The check is remembered per tenant, so a request pays for it once
//! after each `migrate`, not on every call.
//!
//! # Secrets
//!
//! Provider keys, OAuth tokens and channel credentials live in each tenant's `secrets` table,
//! only as AES-256-GCM envelopes ([`secrets`]). A tenant has one random data key, kept in
//! `platform.tenant_keys` wrapped by a master key; the master key sits behind
//! [`secrets::MasterKeys`], and [`Database::with_master_keys`] gives the database one. A dump of
//! the database holds ciphertext and wrapped keys, nothing readable. Rotating the master key
//! ([`Database::rotate_master_keys`]) rewraps the data keys and leaves every secret as it is.
//!
//! The library reads no environment. The `jian` binary builds a [`secrets::LocalKeyring`] from
//! `JIAN_MASTER_KEYS` (JSON of key ids to base64 keys) with `JIAN_ACTIVE_KEY_ID`, or from
//! `JIAN_MASTER_KEY` (one base64 key, id `local`), and when neither is set from `master.key` in
//! the data directory, generated on the first start (mode 0600 on Unix). A tenant made before
//! secrets existed, or without master keys, gets its data key with its first secret.
//!
//! # What this protects against, and what it does not
//!
//! The role is the wall: a query as `tenant_b` cannot read or write `tenant_a` or `platform`
//! whatever its `search_path` says or however it names a table. PUBLIC's rights on the `public`
//! schema and to create temporary tables are revoked, so there is no shared place to leave data.
//!
//! The wall holds against a mistake in the store's code, such as a query that forgets the
//! schema. It does **not** hold against SQL written by someone else. The pool's user is the
//! owner, and a transaction can `RESET ROLE` back to it or `SET ROLE` to any other tenant's role:
//! Postgres checks `SET ROLE` against the user that logged in, not the current role, and
//! `SET SESSION AUTHORIZATION` would not change that. So the SQL a tenant transaction runs is the
//! store's own, with parameters bound, and never text a user or a model wrote. Tenant names stay
//! visible to every role in the catalog (`pg_namespace`), and any role may take advisory locks.
//!
//! # Database user
//!
//! The embedded server's user is a superuser. An external one must be able to create roles
//! (`CREATEROLE`) and own the database: it creates, grants and drops the tenant roles.

mod accounts;
mod agent_config;
mod agent_events;
mod agents;
mod artifact_audience;
mod artifact_edits;
mod artifact_folders;
mod artifacts;
mod backup;
mod blobs;
mod checkpoints;
mod credentials;
mod database;
mod devices;
pub mod embedded;
mod error;
mod gate;
mod grants;
mod imports;
mod invites;
mod jobs;
mod legacy;
mod legacy_memories;
mod legacy_schedules;
mod legacy_skills;
mod legacy_threads;
mod logins;
mod machines;
mod members;
mod memories;
mod memory_links;
mod messages;
mod migrate;
mod objectives;
#[cfg(unix)]
mod orphan;
mod platform;
mod project_files;
mod project_repos;
mod project_threads;
mod projects;
mod providers;
mod quotas;
mod rounds;
mod runs;
mod schedule_runs;
mod schedules;
mod schema_version;
pub mod secrets;
mod sessions;
mod skills;
mod slots;
mod subagents;
mod subjects;
mod tenant;
mod tenants;
mod threads;
mod tokens;
mod usage;

pub use accounts::{Account, NewAccount, default_name, normalize_email};
pub use agent_config::{AgentMachine, AgentModel};
pub use agent_events::{
    AgentEvent, BUDGET_WINDOW_MS, BudgetKind, BudgetLimits, DEFAULT_PROACTIVE_RUNS_PER_DAY,
    DEFAULT_WAKES_PER_DAY, EXTERNAL_EVENT, MAX_BUDGET_PER_DAY, MAX_EVENT_PAYLOAD_BYTES,
    MAX_PENDING_LATER, MESSAGE_EVENT, NewEvent, Proactivity, ProactivityConfig, RUN_FAILED_EVENT,
    Target, WAKE_LATER_EVENT,
};
pub use agents::{
    Agent, AgentId, AgentPatch, MAX_AGENT_AVATAR_BYTES, MAX_AGENT_DESCRIPTION_CHARS,
    MAX_AGENT_INSTRUCTIONS_CHARS, MAX_AGENT_NAME_CHARS, MAX_AGENT_VIEWERS, NewAgent, Viewer,
    can_manage_agent,
};
pub use artifact_folders::{
    ArtifactFolder, ArtifactFolderId, MAX_ARTIFACT_FOLDER_NAME_CHARS, MAX_ARTIFACT_FOLDERS,
};
pub use artifacts::{
    Artifact, ArtifactActor, ArtifactAuthor, ArtifactFilter, ArtifactId, ArtifactVersion,
    ArtifactVersionInfo, MAX_ARTIFACT_TITLE_CHARS, NewArtifact,
};
pub use backup::tenant_dump_args;
pub use blobs::{BlobError, BlobKey, BlobStore, DiskBlobs};
pub use checkpoints::{Checkpoint, HistoryRow, MAX_HISTORY_PAGE, TailSize};
pub use credentials::{CredentialKind, PasswordCredential};
pub use database::{Database, DatabaseHealth, DatabaseSource, DatabaseUrl};
pub use devices::Device;
pub use error::StoreError;
pub use gate::{TenantLimits, TenantTx};
pub use grants::{GRANTS, MemberGrant};
pub use imports::{ImportMarker, ImportResult, ImportStatus};
pub use invites::{
    Accepted, Invite, InviteStatus, InviteTarget, IssuedInvite, MAX_INVITE_TOKEN_LEN, SendOutcome,
    SendStatus,
};
pub use jobs::{
    Enqueued, Failure, Job, JobId, JobState, JobWakeups, MAX_ATTEMPTS, MAX_ERROR_CHARS,
    MAX_PAYLOAD_BYTES, NewJob, PURGE_BATCH, RetryPolicy,
};
pub use legacy::{DeviceImport, ImportOutcome, LegacyDevice, LegacyMachine, MachineImport};
pub use legacy_memories::{LegacyMemory, LegacyMemoryLink, LegacyProject};
pub use legacy_schedules::LegacySchedule;
pub use legacy_skills::LegacySkill;
pub use legacy_threads::{LegacyAgent, LegacyChat, LegacyMessage, LegacyThread};
pub use logins::{
    GithubLink, LiveLoginLink, LoginPurpose, MAX_LOGIN_VALUE_LEN, NewLoginState, UsedLoginState,
};
pub use machines::{MAX_PAGE, Machine, MachineReport, Page};
pub use members::{AddedMember, Member, NewMember, Role};
pub use memories::{
    MAX_FLASH_HOURS, MAX_MEMORY_CHARS, MAX_MEMORY_KEY, MAX_MEMORY_LINKS, MAX_MEMORY_PAGE, Memory,
    MemoryOrigin, MemoryPage, MemoryQuery, MemoryWrite, OriginKind, RecallScope,
};
pub use messages::{
    Author, MAX_CLIENT_KEY, Message, MessageAppended, MessageId, MessagePage, NewMessage,
    NoObserver, Posted, ThreadObserver, Window,
};
pub use migrate::{MigrateOptions, MigrationReport, Migrations};
pub use objectives::{Objective, ObjectiveState};
pub use project_files::{
    MAX_PROJECT_FILE_BYTES, MAX_PROJECT_FILE_NAME_CHARS, MAX_PROJECT_FILES, ProjectFile,
    ProjectFileId,
};
pub use project_repos::{
    MAX_PROJECT_BRANCH_CHARS, MAX_PROJECT_REPOSITORIES, MAX_PROJECT_URL_CHARS, ProjectRepository,
};
pub use project_threads::ProjectContext;
pub use projects::{
    MAX_PROJECT_DESCRIPTION_CHARS, MAX_PROJECT_INSTRUCTIONS_CHARS, MAX_PROJECT_NAME_CHARS,
    NewProject, Project, ProjectId, ProjectPatch, ThreadMove, can_manage_project,
};
pub use providers::{
    LegacyProvider, MAX_ACCOUNTS, MAX_LABEL_CHARS, NewProviderAccount, ProviderAccount,
    ProviderImport, provider_secret_owner,
};
pub use quotas::{QuotaUsage, Quotas, RunLease};
pub use rounds::{
    DEFAULT_ROUND_EVERY_HOURS, MAX_ROUND_EVERY_HOURS, ROUND_EVENT, ROUND_LINES, RoundLine,
    RoundSuggestion, RoundThread, round_due_ms,
};
pub use runs::{Run, RunOrigin, RunState};
pub use schedule_runs::{Dispatch, DueFiring, PendingSchedule};
pub use schedules::{
    Due, Fired, InboxEvent, MAX_SCHEDULE_INSTRUCTION_CHARS, MAX_SCHEDULE_NAME_CHARS,
    MAX_SCHEDULES_PER_AGENT, NewSchedule, SCHEDULE_EVENT, Schedule, ScheduleId, SchedulePatch,
    When,
};
pub use schema_version::{SchemaState, TenantVersion};
pub use sessions::{LoginCandidate, NewSession};
pub use skills::{
    AgentSkills, MAX_LIBRARY_SKILLS, MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_INSTRUCTIONS_CHARS,
    MAX_SKILL_LICENSE_CHARS, MAX_SKILL_NAME_CHARS, MAX_SKILL_REQUIRED_TOOLS, MAX_SKILL_TOOL_CHARS,
    Skill, SkillDraft, SkillId, SkillSource, SkillText, SkillVersion, can_manage_skill,
    text_problem as skill_text_problem, valid_skill_name,
};
pub use slots::{
    HeldSlot, InstanceId, SLOT_COUNT, SlotClaim, SlotId, SlotOptions, SlotRow, slot_of,
};
pub use subagents::{NewSubagent, Spawn, Subagent, SubagentLimits, SubagentState};
pub use tenant::{TenantCtx, TenantId};
pub use tenants::TenantStatus;
pub use threads::{
    ChannelOrigin, MAX_PARTICIPANTS, MAX_THREAD_TITLE_CHARS, NewThread, Participant, Thread,
    ThreadId, Who,
};
pub use tokens::{
    AccountId, Authenticated, DeviceId, MachineId, Subject, TokenHash, TokenKind, generate_token,
};
pub use usage::{DailyUsage, MAX_USAGE_DAYS, TokenCounts};
