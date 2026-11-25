//! Two tenants, each with data of every kind the core stores today: a machine, a phone, a
//! secret, a job and three members.

use std::sync::atomic::{AtomicU32, Ordering};

use jian_store::secrets::Secret;
use jian_store::{
    Database, Device, DeviceId, Job, Machine, MachineId, Member, NewJob, NewMember, Role,
    TenantCtx, TenantId,
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

/// The password of every seeded account. Synthetic.
pub const PASSWORD: &str = "correct horse battery staple";

/// [`PASSWORD`] as argon2id at the cheapest cost, so that seeding hashes nothing. This crate
/// cannot depend on `jian-auth` (that crate's tests depend on this one), so it is made once.
const PASSWORD_HASH: &str =
    "$argon2id$v=19$m=8,t=1,p=1$u4VdiL+SNf5YkY/Bb0w0+g$YxDk33lU+nHQ0Ch6mnDAFP8IVRDk6xDPy7Ld1LfZlyI";

/// How long the sessions seeded here last.
const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

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
    /// An admin of the tenant: `admin@<tenant>.test`, with [`PASSWORD`].
    pub admin: Member,
    /// The admin's session token, clear text.
    pub admin_session: String,
    /// A member of the tenant: `member@<tenant>.test`, with [`PASSWORD`].
    pub member: Member,
    /// The member's session token, clear text.
    pub member_session: String,
    /// A second member, `peer@<tenant>.test`, who shares the tenant with [`Side::member`] and must
    /// not see what that member keeps private.
    pub peer: Member,
    /// The second member's session token, clear text.
    pub peer_session: String,
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
        let (admin, admin_session) = seed_member(db, &ctx, "admin", Role::Admin).await;
        let (member, member_session) = seed_member(db, &ctx, "member", Role::Member).await;
        let (peer, peer_session) = seed_member(db, &ctx, "peer", Role::Member).await;
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
            admin,
            admin_session,
            member,
            member_session,
            peer,
            peer_session,
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

/// A member of the tenant with an account of its own (an account is global, so the address
/// carries the tenant and two sides never share one), and a session.
async fn seed_member(db: &Database, ctx: &TenantCtx, who: &str, role: Role) -> (Member, String) {
    let email = format!("{who}@{}.test", ctx.id());
    let added = db
        .add_member(
            ctx,
            NewMember {
                email: &email,
                name: Some("Isolation member"),
                role,
                invited_by: None,
                password_hash: Some(PASSWORD_HASH),
                must_change: false,
            },
        )
        .await
        .unwrap();
    let session = db
        .start_session(ctx, &added.member.account_id, SESSION_TTL)
        .await
        .unwrap();
    (added.member, session.token.expose().to_owned())
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
