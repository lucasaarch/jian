//! Rows of the store as the protocol shows them, and the delta that says a machine changed.

use jian_protocol::auth::{UserRole, UserSummary};
use jian_protocol::client::{DeltaPayload, DeviceSummary, MachineStatus, MachineSummary, Topic};
use jian_store::{Device, Machine, MachineId, Role, TenantId, User};

use crate::AppState;

/// A machine as a client sees it; whether it is online is the hub's word, not the database's.
pub(crate) fn machine_summary(machine: &Machine, online: bool) -> MachineSummary {
    let status = if machine.revoked {
        MachineStatus::Revoked
    } else if online {
        MachineStatus::Online
    } else {
        MachineStatus::Offline
    };
    MachineSummary {
        id: machine.id.clone().into(),
        name: machine.name.clone(),
        status,
        os: machine.os.clone(),
        arch: machine.arch.clone(),
        hostname: machine.hostname.clone(),
        system: machine.system.clone(),
        worker_version: machine.worker_version.clone(),
        capabilities: machine.capabilities.clone(),
        created_at: machine.created_at.clone(),
        last_seen_at: machine.last_seen_at.clone(),
    }
}

pub(crate) fn device_summary(device: &Device) -> DeviceSummary {
    DeviceSummary {
        id: device.id.clone(),
        name: device.name.clone(),
        platform: device.platform.clone(),
        created_at: device.created_at.clone(),
        last_seen_at: device.last_seen_at.clone(),
        revoked: device.revoked,
    }
}

impl AppState {
    /// The machine as clients see it now.
    pub(crate) fn summarize(&self, tenant: &TenantId, machine: &Machine) -> MachineSummary {
        let online = self
            .hub
            .is_online(tenant, &MachineId::new(machine.id.clone()));
        machine_summary(machine, online)
    }

    /// Tells the tenant's subscribers that the machine changed.
    pub(crate) async fn publish_machine(&self, tenant: &TenantId, machine: &Machine) {
        let payload = DeltaPayload::Machine(self.summarize(tenant, machine));
        self.events.publish(tenant, Topic::Machines, payload).await;
    }
}

/// The role as a client sees it.
pub(crate) fn role_summary(role: Role) -> UserRole {
    match role {
        Role::Admin => UserRole::Admin,
        Role::Member => UserRole::Member,
    }
}

/// The role a client asked for.
pub(crate) fn role_of(role: UserRole) -> Role {
    match role {
        UserRole::Admin => Role::Admin,
        UserRole::Member => Role::Member,
    }
}

/// A user as an admin lists them: never the password, in any form.
pub(crate) fn user_summary(user: &User) -> UserSummary {
    UserSummary {
        id: user.id.to_string(),
        email: user.email.clone(),
        name: user.name.clone(),
        role: role_summary(user.role),
        must_change_password: user.must_change_password,
        has_password: user.has_password,
        created_at: user.created_at.clone(),
        disabled: user.disabled,
    }
}
