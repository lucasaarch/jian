use crate::TenantId;

/// The `pg_dump` arguments that save one tenant and nothing else: its schema, in the custom
/// format `pg_restore` reads. Add `--dbname=<url>` and `--file=<path>`.
///
/// The embedded server ships `pg_dump` in `<data_dir>/postgres/<version>/bin`; with an external
/// one, use the `pg_dump` of the same major as the server. Owners are kept, so a restore needs
/// the role `tenant_<id>` to exist and the schema not to: restore into a database where the
/// tenant was deleted and its role created again, or into a fresh one after
/// [`create_tenant`](crate::Database::create_tenant) and a `DROP SCHEMA`.
pub fn tenant_dump_args(tenant: &TenantId) -> Vec<String> {
    vec![
        format!("--schema={}", tenant.schema_name()),
        "--format=custom".to_owned(),
    ]
}
