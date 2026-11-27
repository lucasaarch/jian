//! A run of the import: which domains, in what order, and what each marker says after.

use std::path::PathBuf;

use jian_store::secrets::LocalKeyring;
use jian_store::{Database, ImportResult, ImportStatus, TenantCtx};

use crate::reader::{LegacyReader, LegacyTable};
use crate::{
    ImportError, Source, artifacts_import, connectors, conversations, machines, memories, owner,
    providers, secrets,
};

/// A part of the old Jian that has a table in the core, imported on its own: one marker, one
/// result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    /// The person who ran the install, as the first admin.
    Owner,
    /// Provider keys, MCP tokens and channel credentials.
    Secrets,
    /// Model provider accounts, with their keys.
    Providers,
    /// The old MCP servers, as accounts of the `mcp` plugin every agent reaches. Needs the owner
    /// and the secrets (their tokens come from there).
    Connectors,
    /// Jian Remote workers and their tokens.
    Machines,
    /// Phones and their tokens.
    Devices,
    /// The old profiles, as agents everyone in the workspace sees. Needs the owner.
    Agents,
    /// The old sessions, as direct chats and channel threads. Needs the owner and the agents.
    Threads,
    /// The messages of those sessions. Needs the threads.
    Messages,
    /// The old memories and their links, into the agents made from their profiles. Needs the
    /// agents.
    Memories,
    /// The old projects, as the workspace's. Needs the owner.
    Projects,
    /// The old schedules, into the agents made from their profiles. Needs the owner and the
    /// agents.
    Schedules,
    /// The old skill library, with what was switched off. Needs the owner and the agents.
    Skills,
    /// The artifacts of the old sessions, with their versions and folders. Needs the owner, the
    /// threads and the projects.
    Artifacts,
}

impl Domain {
    /// Every domain, in the order a run takes them.
    pub const ALL: [Self; 14] = [
        Self::Owner,
        Self::Secrets,
        Self::Providers,
        Self::Connectors,
        Self::Machines,
        Self::Devices,
        Self::Agents,
        Self::Threads,
        Self::Messages,
        Self::Memories,
        Self::Projects,
        Self::Schedules,
        Self::Skills,
        Self::Artifacts,
    ];

    /// The name in a marker and in the report.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Secrets => "secrets",
            Self::Providers => "providers",
            Self::Connectors => "connectors",
            Self::Machines => "machines",
            Self::Devices => "devices",
            Self::Agents => "agents",
            Self::Threads => "threads",
            Self::Messages => "messages",
            Self::Memories => "memories",
            Self::Projects => "projects",
            Self::Schedules => "schedules",
            Self::Skills => "skills",
            Self::Artifacts => "artifacts",
        }
    }

    /// The old tables this domain reads: they are not reported as left behind.
    fn tables(self) -> &'static [&'static str] {
        match self {
            Self::Owner => &[],
            Self::Secrets => &["gateway_secrets", "secrets"],
            Self::Providers => &["providers"],
            // `github_installations` and `mcp_secret_moves` stay in the report of what was not
            // imported.
            Self::Connectors => &["mcp_servers"],
            Self::Machines => &["remote_machines"],
            Self::Devices => &["devices"],
            Self::Agents => &["profiles"],
            Self::Threads => &["sessions", "contacts"],
            Self::Messages => &["messages"],
            // `memory_projects` (which memory belonged to which project) has no place in the
            // core, so it stays in the report of what was not imported.
            Self::Memories => &["memories", "memory_links"],
            Self::Projects => &["projects"],
            Self::Schedules => &["schedules"],
            Self::Skills => &["skills"],
            // The old `artifacts` is the output of tool calls, not these, so it stays reported.
            Self::Artifacts => &[
                "artifact_folders",
                "session_artifacts",
                "session_artifact_versions",
            ],
        }
    }
}

/// What a run needs beyond the source. Built by the binary from its flags and environment.
pub struct ImportOptions {
    /// The address that becomes the first admin. The old Jian has no such thing, so without it
    /// the `owner` domain is skipped.
    pub owner_email: Option<String>,
    /// The old install's master key or keys. Without them the `secrets` domain is skipped.
    pub keys: Option<LocalKeyring>,
    /// Where a scratch Postgres lives while a dump is read. Emptied before and removed after.
    pub scratch_dir: PathBuf,
}

/// Which domains a run takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Only those not `done` yet: what the first boot does, so a finished import is never read
    /// again and an interrupted one picks up where it was.
    Pending,
    /// Every domain, again. Rows already there are left as they are; this is `jian import --from`.
    All,
}

/// What one domain's run did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainReport {
    /// The domain.
    pub domain: Domain,
    /// How it ended.
    pub result: ImportResult,
}

/// What a run did, for the log and for the person at the terminal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportReport {
    /// Where the data came from, as the markers say it.
    pub source: String,
    /// The domains that ran, in order. Empty when every domain was already done.
    pub domains: Vec<DomainReport>,
    /// Tables of the old database no domain reads yet, with their rows: what is still to come
    /// over when the core gets a table for it. Empty when no domain ran.
    pub not_imported: Vec<LegacyTable>,
}

/// The import into one tenant.
pub struct Importer<'a> {
    db: &'a Database,
    ctx: &'a TenantCtx,
    options: &'a ImportOptions,
}

impl<'a> Importer<'a> {
    /// An import into the tenant `ctx` of `db`.
    pub fn new(db: &'a Database, ctx: &'a TenantCtx, options: &'a ImportOptions) -> Self {
        Self { db, ctx, options }
    }

    /// Imports `source` into the tenant: for each domain in `scope`, marks it running, writes
    /// its rows (each one atomically, and only if it is not already there), and records how it
    /// ended. A domain that fails is recorded and the next one goes on; only a source that
    /// cannot be opened, or a marker that cannot be written, ends the run with an error.
    pub async fn run(&self, source: &Source, scope: Scope) -> Result<ImportReport, ImportError> {
        let described = source.describe()?;
        let markers = self.db.imports(self.ctx).await?;
        let wanted: Vec<Domain> = Domain::ALL
            .into_iter()
            .filter(|domain| {
                scope == Scope::All
                    || !markers.iter().any(|marker| {
                        marker.domain == domain.as_str() && marker.status == ImportStatus::Done
                    })
            })
            .collect();
        if wanted.is_empty() {
            return Ok(ImportReport {
                source: described,
                domains: Vec::new(),
                not_imported: Vec::new(),
            });
        }
        let mut reader = source.open(&self.options.scratch_dir).await?;
        let report = self.each(&mut reader, &described, &wanted).await;
        reader.close().await;
        report
    }

    async fn each(
        &self,
        reader: &mut LegacyReader,
        source: &str,
        wanted: &[Domain],
    ) -> Result<ImportReport, ImportError> {
        let mut domains = Vec::with_capacity(wanted.len());
        for &domain in wanted {
            self.db
                .start_import(self.ctx, domain.as_str(), source)
                .await?;
            let result = match self.domain(reader, domain).await {
                Ok(result) => result,
                // The store or the source failed in the middle of this domain: it is recorded
                // and the others go on. The reason is the error's own words, with no value.
                Err(error) => ImportResult {
                    status: ImportStatus::Failed,
                    imported: 0,
                    already_there: 0,
                    failed: 0,
                    detail: Some(error.to_string()),
                },
            };
            tracing::info!(
                domain = domain.as_str(),
                status = result.status.as_str(),
                imported = result.imported,
                already_there = result.already_there,
                failed = result.failed,
                "import of the old Jian"
            );
            self.db
                .finish_import(self.ctx, domain.as_str(), &result)
                .await?;
            domains.push(DomainReport { domain, result });
        }
        // A listing that fails costs the report its second half, not the import what it wrote.
        let mut not_imported = reader.tables().await.unwrap_or_else(|error| {
            tracing::warn!(%error, "cannot list the old tables that were not imported");
            Vec::new()
        });
        let read: Vec<&str> = Domain::ALL
            .into_iter()
            .flat_map(|domain| domain.tables().iter().copied())
            .collect();
        not_imported.retain(|table| !read.contains(&table.name.as_str()));
        Ok(ImportReport {
            source: source.to_owned(),
            domains,
            not_imported,
        })
    }

    async fn domain(
        &self,
        reader: &mut LegacyReader,
        domain: Domain,
    ) -> Result<ImportResult, ImportError> {
        match domain {
            Domain::Owner => {
                Ok(owner::import(self.db, self.ctx, self.options.owner_email.as_deref()).await?)
            }
            Domain::Secrets => {
                secrets::import(self.db, self.ctx, reader, self.options.keys.as_ref()).await
            }
            Domain::Providers => {
                providers::import(self.db, self.ctx, reader, self.options.keys.as_ref()).await
            }
            Domain::Connectors => {
                let email = self.options.owner_email.as_deref();
                connectors::import(self.db, self.ctx, reader, email).await
            }
            Domain::Machines => machines::machines(self.db, self.ctx, reader).await,
            Domain::Devices => machines::devices(self.db, self.ctx, reader).await,
            Domain::Agents => {
                let email = self.options.owner_email.as_deref();
                conversations::agents(self.db, self.ctx, reader, email).await
            }
            Domain::Threads => {
                let email = self.options.owner_email.as_deref();
                conversations::threads(self.db, self.ctx, reader, email).await
            }
            Domain::Messages => {
                let email = self.options.owner_email.as_deref();
                conversations::messages(self.db, self.ctx, reader, email).await
            }
            Domain::Memories => memories::memories(self.db, self.ctx, reader).await,
            Domain::Schedules => {
                let email = self.options.owner_email.as_deref();
                memories::schedules(self.db, self.ctx, reader, email).await
            }
            Domain::Skills => {
                let email = self.options.owner_email.as_deref();
                memories::skills(self.db, self.ctx, reader, email).await
            }
            Domain::Projects => {
                let email = self.options.owner_email.as_deref();
                memories::projects(self.db, self.ctx, reader, email).await
            }
            Domain::Artifacts => {
                let email = self.options.owner_email.as_deref();
                artifacts_import::artifacts(self.db, self.ctx, reader, email).await
            }
        }
    }
}
