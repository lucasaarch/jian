//! The import of the old Node Jian, from the command line and at the first start.
//!
//! `jian import --from <source>` imports every domain again (rows already there are left alone);
//! `jian import status` shows what each domain's marker says. At a start, [`at_boot`] imports the
//! domains not yet `done` when a source is given (`--import-from`) or the old desktop app left an
//! `export.sql` in its folder. It never stops a start: whatever goes wrong is logged and the
//! gateway serves.
//!
//! The old keys and the owner's address come from flags with an environment variable each
//! (`JIAN_IMPORT_*`), and are only read here; `jian-import` receives values.

use std::path::{Path, PathBuf};

use anyhow::Context as _;
use clap::{Args, Subcommand};
use jian_import::{ImportOptions, ImportReport, Importer, Scope, Source};
use jian_store::secrets::LocalKeyring;
use jian_store::{Database, TenantCtx};

/// The dump the old desktop app's export leaves next to its `database` folder.
const EXPORT_FILE: &str = "export.sql";
/// Where the old desktop app keeps its master key when the OS keychain does not seal it.
const OLD_KEY_FILE: &str = "local-gateway.json";

/// What the import needs besides a source. Global so a start and a subcommand take the same.
// The names are the flags' (`--import-from`), so the prefix stays.
#[allow(clippy::struct_field_names)]
#[derive(Args, Clone, Default)]
pub struct ImportFlags {
    /// The old Jian's data to import at the first start: a `.sql` dump made from the desktop
    /// app's database, or the old gateway's `postgres://` URL. Read only, never changed.
    #[arg(
        long,
        env = "JIAN_IMPORT_FROM",
        value_name = "SOURCE",
        hide_env_values = true,
        global = true
    )]
    import_from: Option<String>,

    /// The old install's one master key (the desktop app's `JIAN_MASTER_KEY`), base64. Holds a
    /// key, so `--help` does not show its value.
    #[arg(
        long,
        env = "JIAN_IMPORT_MASTER_KEY",
        value_name = "BASE64",
        hide_env_values = true,
        global = true
    )]
    import_master_key: Option<String>,

    /// The old install's master keys as JSON (the server's `JIAN_MASTER_KEYS`). Holds keys, so
    /// `--help` does not show its value.
    #[arg(
        long,
        env = "JIAN_IMPORT_MASTER_KEYS",
        value_name = "JSON",
        hide_env_values = true,
        global = true
    )]
    import_master_keys: Option<String>,

    /// The address that becomes the first admin: the old Jian kept none for its owner.
    #[arg(
        long,
        env = "JIAN_IMPORT_OWNER_EMAIL",
        value_name = "EMAIL",
        global = true
    )]
    import_owner_email: Option<String>,
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct ImportArgs {
    #[command(subcommand)]
    action: Option<ImportAction>,
    /// What to import: a `.sql` dump, or a `postgres://` URL.
    #[arg(long, value_name = "SOURCE")]
    from: Option<String>,
}

#[derive(Subcommand)]
pub enum ImportAction {
    /// What each domain of the import did, and which old tables are still to come over.
    Status,
}

fn given(value: Option<&String>) -> Option<&str> {
    value
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
}

impl ImportFlags {
    /// The old keys: the list when given, else the single key under the id `local`. A key that
    /// does not parse is an error the person is told about.
    fn keys(&self, key_file: Option<&Path>) -> anyhow::Result<Option<LocalKeyring>> {
        if let Some(list) = given(self.import_master_keys.as_ref()) {
            let ring = LocalKeyring::for_reading_legacy(list)
                .context("JIAN_IMPORT_MASTER_KEYS is not usable")?;
            return Ok(Some(ring));
        }
        let single = given(self.import_master_key.as_ref())
            .map(str::to_owned)
            .or_else(|| key_file.and_then(unsealed_key));
        let Some(single) = single else {
            return Ok(None);
        };
        let list = serde_json::json!({ "local": single }).to_string();
        let ring = LocalKeyring::for_reading_legacy(&list)
            .context("the old master key (JIAN_IMPORT_MASTER_KEY) is not usable")?;
        Ok(Some(ring))
    }

    fn options(&self, scratch: PathBuf, key_file: Option<&Path>) -> anyhow::Result<ImportOptions> {
        Ok(ImportOptions {
            owner_email: given(self.import_owner_email.as_ref()).map(str::to_owned),
            keys: self.keys(key_file)?,
            scratch_dir: scratch,
        })
    }
}

/// The key in the old desktop app's `local-gateway.json`, when it is stored in the clear
/// (`sealed` is false). A sealed one needs the OS keychain, which only the old app can open.
fn unsealed_key(path: &Path) -> Option<String> {
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if json.get("sealed")?.as_bool()? {
        return None;
    }
    Some(json.get("masterKey")?.as_str()?.to_owned())
}

/// The old desktop app's folder: `<application data>/Jian/gateway`.
fn old_desktop_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.config_dir().join("Jian").join("gateway"))
}

/// `jian import [--from SOURCE]` and `jian import status`.
pub async fn run(
    database: &Database,
    ctx: &TenantCtx,
    flags: &ImportFlags,
    data_dir: &Path,
    args: ImportArgs,
) -> anyhow::Result<()> {
    if let Some(ImportAction::Status) = args.action {
        return status(database, ctx).await;
    }
    let from = args
        .from
        .or_else(|| flags.import_from.clone())
        .context("say what to import: `jian import --from <dump.sql | postgres://...>`")?;
    let source = Source::parse(&from).context("cannot use that source")?;
    let key_file = old_desktop_dir().map(|dir| dir.join(OLD_KEY_FILE));
    let options = flags.options(data_dir.join("import-scratch"), key_file.as_deref())?;
    let report = Importer::new(database, ctx, &options)
        .run(&source, Scope::All)
        .await
        .context("the import failed")?;
    print_report(&report);
    Ok(())
}

#[allow(clippy::print_stdout)]
fn print_report(report: &ImportReport) {
    println!("source: {}", report.source);
    for done in &report.domains {
        let result = &done.result;
        println!(
            "{}: {} (imported {}, already there {}, failed {}){}",
            done.domain.as_str(),
            result.status.as_str(),
            result.imported,
            result.already_there,
            result.failed,
            result
                .detail
                .as_deref()
                .map(|detail| format!(" - {detail}"))
                .unwrap_or_default()
        );
    }
    print_left(report);
}

#[allow(clippy::print_stdout)]
fn print_left(report: &ImportReport) {
    let left: Vec<_> = report
        .not_imported
        .iter()
        .filter(|table| table.rows > 0)
        .collect();
    if left.is_empty() {
        return;
    }
    println!("not imported yet (no table in the core for them):");
    for table in left {
        println!("  {}: {} rows", table.name, table.rows);
    }
}

#[allow(clippy::print_stdout)]
async fn status(database: &Database, ctx: &TenantCtx) -> anyhow::Result<()> {
    let markers = database
        .imports(ctx)
        .await
        .context("cannot read the markers")?;
    if markers.is_empty() {
        println!("nothing was imported from an old Jian");
    }
    for marker in markers {
        println!(
            "{}: {} (imported {}, already there {}, failed {}) from {}{}",
            marker.domain,
            marker.status.as_str(),
            marker.imported,
            marker.already_there,
            marker.failed,
            marker.source,
            marker
                .detail
                .as_deref()
                .map(|detail| format!(" - {detail}"))
                .unwrap_or_default()
        );
    }
    Ok(())
}

/// The first-start import: with a source given, or an old desktop export found, takes the
/// domains not `done`. Never fails the start.
pub async fn at_boot(database: &Database, ctx: &TenantCtx, flags: &ImportFlags, data_dir: &Path) {
    let old_dir = old_desktop_dir();
    let from = if let Some(from) = given(flags.import_from.as_ref()) {
        from.to_owned()
    } else {
        let Some(path) = old_dir.as_deref().and_then(find_export) else {
            if old_dir
                .as_ref()
                .is_some_and(|dir| dir.join("database").join("PG_VERSION").is_file())
            {
                tracing::warn!(
                    "an old Jian database was found, but it is not a native Postgres; export \
                         it to {EXPORT_FILE} next to it (see the jian-import docs), or run \
                         `jian import --from <dump.sql>`"
                );
            }
            return;
        };
        path.to_string_lossy().into_owned()
    };
    let key_file = old_dir.map(|dir| dir.join(OLD_KEY_FILE));
    let attempt = async {
        let source = Source::parse(&from)?;
        let options = flags.options(data_dir.join("import-scratch"), key_file.as_deref())?;
        let report = Importer::new(database, ctx, &options)
            .run(&source, Scope::Pending)
            .await?;
        anyhow::Ok(report)
    };
    match attempt.await {
        Ok(report) => {
            if !report.domains.is_empty() {
                print_report(&report);
            }
        }
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "the import of the old Jian did not run; starting anyway");
        }
    }
}

fn find_export(dir: &Path) -> Option<PathBuf> {
    let path = dir.join(EXPORT_FILE);
    path.is_file().then_some(path)
}
