//! Two tenants, each with data of every kind the core stores today.

use std::sync::atomic::{AtomicU32, Ordering};

use jian_store::secrets::Secret;
use jian_store::{
    Database, Device, DeviceId, Job, Machine, MachineId, NewJob, TenantCtx, TenantId,
};
use serde_json::json;

/// The owner under which every side stores its secret. The same text on both sides on purpose:
/// a read that mixed tenants up would come back with the other one's value, not with nothing.
pub const SECRET_OWNER: &str = "provider:isolation";

/// The kind of the job each side has queued. No handler is registered for it, so it stays queued
/// until a test claims it.
pub const JOB_KIND: &str = "isolation.probe";

/// The idempotency key both sides use for their job: one key, two tenants, two jobs.
pub const SHARED_KEY: &str = "same-key";

static NEXT: AtomicU32 = AtomicU32::new(0);

/// One tenant and everything the tests may aim at: its context, a token of each kind in clear
/// text (the fixture is the one place that has them) and what it owns.
pub struct Side {
    /// The tenant.
    pub id: TenantId,
    /// What the store asks for to touch its data.
    pub ctx: TenantCtx,
    /// Opens the tenant as its owner.
    pub owner_token: String,
    /// A machine of the tenant.
    pub machine: Machine,
    /// The token that machine's worker connects with.
    pub machine_token: String,
    /// A phone of the tenant.
    pub device: Device,
    /// The token that phone connects with.
    pub device_token: String,
    /// The text stored in the tenant's vault under [`SECRET_OWNER`].
    pub secret_text: String,
    /// The tenant's queued job.
    pub job: Job,
}

impl Side {
    async fn seed(db: &Database, id: TenantId) -> Self {
        db.create_tenant(&id).await.unwrap();
        let ctx = db.tenant(id.clone()).await.unwrap();
        let owner_token = format!("owner-token-of-{id}-{}", "x".repeat(32));
        db.set_owner_token(&ctx, &owner_token).await.unwrap();
        let (machine, machine_token) = db.issue_machine(&ctx, "isolation box").await.unwrap();
        let (device, device_token) = db.issue_device(&ctx, "isolation phone").await.unwrap();
        let secret_text = format!("sk-test-of-{id}");
        db.vault()
            .put(&ctx, SECRET_OWNER, &Secret::new(secret_text.clone()))
            .await
            .unwrap();
        let job = db
            .enqueue_job(
                &ctx,
                NewJob::new(JOB_KIND, json!({ "of": id.as_str() })).idempotent(SHARED_KEY),
            )
            .await
            .unwrap()
            .job;
        Self {
            id,
            ctx,
            owner_token,
            machine,
            machine_token: machine_token.expose().to_owned(),
            device,
            device_token: device_token.expose().to_owned(),
            secret_text,
            job,
        }
    }

    /// The machine's id in the form the store takes.
    pub fn machine_id(&self) -> MachineId {
        MachineId::new(self.machine.id.clone())
    }

    /// The device's id in the form the store takes.
    pub fn device_id(&self) -> DeviceId {
        DeviceId::new(self.device.id.clone())
    }

    /// The name of the tenant's schema, which is also its role.
    pub fn schema(&self) -> String {
        self.id.schema_name()
    }
}

/// Tenants A and B, made in one database with the same kinds of data and different values.
pub struct TwoTenants {
    /// The first tenant.
    pub a: Side,
    /// The second tenant.
    pub b: Side,
}

impl TwoTenants {
    /// Makes both tenants in `db`, which must be migrated and have master keys (see
    /// [`crate::master_keys`]). Their ids are unique within the process, so tests that share one
    /// database cannot step on each other.
    pub async fn seed(db: &Database) -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let id = |side: &str| TenantId::parse(&format!("iso{side}{pid}n{n}")).unwrap();
        Self {
            a: Side::seed(db, id("a")).await,
            b: Side::seed(db, id("b")).await,
        }
    }

    /// `(actor, victim)` both ways round: the same operation is run by A on B's data and by B on
    /// A's, so a one-sided mistake (a hard-coded tenant, a lucky ordering) shows up.
    pub fn crossings(&self) -> [(&Side, &Side); 2] {
        [(&self.a, &self.b), (&self.b, &self.a)]
    }
}
