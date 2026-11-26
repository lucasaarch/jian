//! What has an isolation test, written down so that a new thing without one fails a test.
//!
//! The binary's tests check [`JOB_KINDS`] against the kinds it registers; the gateway's own
//! isolation test keeps the equivalent tables for its routes, requests and topics, next to the
//! tests they name. Registering a kind fails a test until it is listed here with the test that
//! proves it, and that test has to exist for the entry to be honest: the name is for the
//! reviewer.

/// A job kind a binary registers, and the test that shows its jobs run as their own tenant and
/// see nothing of another's. `debug.log` is a stand-in that logs ids; the runner-level test
/// stands for it until a real handler brings its own.
pub const JOB_KINDS: &[(&str, &str)] = &[
    (
        "debug.log",
        "jian-server/tests/jobs.rs: a_job_runs_as_its_own_tenant_and_a_handler_sees_nothing_of_another",
    ),
    (
        "schedule.fire",
        "jian-server/tests/gateway/schedules.rs: a_schedule_fires_into_its_agents_inbox_once_and_never_into_another_tenants",
    ),
    (
        "thread.compact",
        "jian-server/tests/compact_job.rs: a_compaction_job_runs_as_its_own_tenant_and_a_tenant_over_its_limit_costs_the_provider_nothing",
    ),
    (
        "agent.run",
        "jian-server/tests/run_job.rs: a_panicking_tool_fails_its_run_while_another_tenants_run_finishes",
    ),
    (
        "invite.send",
        "jian-server/tests/gateway/invites.rs: an_invitation_is_sent_with_its_own_workspaces_mail_account_and_nobody_elses",
    ),
    (
        "login_link.send",
        "jian-server/tests/gateway/sign_in.rs: a_magic_link_opens_only_the_workspace_and_member_it_was_made_for",
    ),
];
