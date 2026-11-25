//! Rows of the store as the protocol shows them, and the delta that says a machine changed.

use jian_protocol::auth::{InviteSummary, MemberRole, MemberSummary};
use jian_protocol::client::{DeltaPayload, DeviceSummary, MachineStatus, MachineSummary, Topic};
use jian_store::{Device, Invite, Machine, MachineId, Member, Role, TenantId};

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
pub(crate) fn role_summary(role: Role) -> MemberRole {
    match role {
        Role::Admin => MemberRole::Admin,
        Role::Member => MemberRole::Member,
    }
}

/// The role a client asked for.
pub(crate) fn role_of(role: MemberRole) -> Role {
    match role {
        MemberRole::Admin => Role::Admin,
        MemberRole::Member => Role::Member,
    }
}

/// A member as an admin lists them: never the password, in any form.
pub(crate) fn member_summary(member: &Member) -> MemberSummary {
    MemberSummary {
        account_id: member.account_id.to_string(),
        email: member.email.clone(),
        name: member.name.clone(),
        role: role_summary(member.role),
        must_change_password: member.must_change_password,
        has_password: member.has_password,
        created_at: member.created_at.clone(),
        disabled: member.disabled,
    }
}

/// A pending invitation as an admin lists it: no token, which was shown once.
pub(crate) fn invite_summary(invite: &Invite) -> InviteSummary {
    InviteSummary {
        id: invite.id.clone(),
        email: invite.email.clone(),
        role: role_summary(invite.role),
        created_at: invite.created_at.clone(),
        expires_at: invite.expires_at.clone(),
    }
}
