//! The gateway's own machine: what runs, what is cut, and what the file tools may touch.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::{Duration, Instant};

use jian_core::MAX_TOOL_RESULT_BYTES;
use jian_exec::{ExecError, Executor, LocalExecutor, Machine, Scope};

fn scope(tenant: &str, agent: &str) -> Scope {
    Scope {
        tenant: tenant.to_owned(),
        agent: agent.to_owned(),
        run: "r1".to_owned(),
    }
}

async fn open(root: &tempfile::TempDir, tenant: &str, agent: &str) -> Box<dyn Machine> {
    LocalExecutor::new(root.path())
        .open(&scope(tenant, agent))
        .await
        .unwrap()
}

const SLEEP: &str = if cfg!(windows) {
    "Start-Sleep -Seconds 20"
} else {
    "sleep 20"
};
const BIG: &str = if cfg!(windows) {
    "Write-Output ('x' * 100000)"
} else {
    "head -c 100000 /dev/zero | tr '\\0' x"
};

#[tokio::test]
async fn a_shell_command_runs_and_its_exit_code_comes_back() {
    let root = tempfile::tempdir().unwrap();
    let machine = open(&root, "a", "bot").await;
    let done = machine.shell("echo hello", 10_000).await.unwrap();
    assert_eq!(done.exit_code, Some(0));
    assert!(done.output.contains("hello"));
    let failed = machine.shell("exit 3", 10_000).await.unwrap();
    assert_eq!(failed.exit_code, Some(3));
}

#[tokio::test]
async fn a_command_past_its_time_is_stopped() {
    let root = tempfile::tempdir().unwrap();
    let machine = open(&root, "a", "bot").await;
    let started = Instant::now();
    let error = machine.shell(SLEEP, 300).await.unwrap_err();
    assert!(matches!(error, ExecError::TimedOut), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn big_output_is_cut_and_says_so() {
    let root = tempfile::tempdir().unwrap();
    let machine = open(&root, "a", "bot").await;
    let done = machine.shell(BIG, 20_000).await.unwrap();
    assert!(done.output.len() <= MAX_TOOL_RESULT_BYTES);
    assert!(done.output.contains("output cut"), "{}", done.output);
}

#[tokio::test]
async fn files_are_the_agents_own_folder_and_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    let machine = open(&root, "a", "bot").await;
    machine.write_file("notes/today.txt", "hi").await.unwrap();
    assert_eq!(machine.read_file("notes/today.txt").await.unwrap(), "hi");

    let outside = root.path().join("secret.txt");
    std::fs::write(&outside, "no").unwrap();
    for path in [
        outside.to_str().unwrap(),
        "../../secret.txt",
        "notes/../../../secret.txt",
    ] {
        let read = machine.read_file(path).await.unwrap_err();
        assert!(read.to_string().contains("outside"), "{path}: {read}");
        let write = machine.write_file(path, "x").await.unwrap_err();
        assert!(write.to_string().contains("outside"), "{path}: {write}");
    }
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "no");
}

#[tokio::test]
async fn another_agent_or_tenant_has_a_folder_of_its_own() {
    let root = tempfile::tempdir().unwrap();
    open(&root, "a", "bot")
        .await
        .write_file("mine.txt", "a")
        .await
        .unwrap();
    for (tenant, agent) in [("a", "other"), ("b", "bot")] {
        let machine = open(&root, tenant, agent).await;
        assert!(machine.read_file("mine.txt").await.is_err());
    }
    let hostile = LocalExecutor::new(root.path())
        .open(&scope("a", "../bot"))
        .await;
    assert!(hostile.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn the_shell_starts_in_the_agents_folder_and_a_link_does_not_lead_out() {
    let root = tempfile::tempdir().unwrap();
    let machine = open(&root, "a", "bot").await;
    machine.write_file("here.txt", "x").await.unwrap();
    let listed = machine.shell("ls", 10_000).await.unwrap();
    assert!(listed.output.contains("here.txt"));

    let outside = root.path().join("secret.txt");
    std::fs::write(&outside, "no").unwrap();
    let made = machine
        .shell(
            &format!(
                "ln -s {} leak; ln -s {}/nowhere dangling; ln -s {} lane",
                outside.display(),
                root.path().display(),
                root.path().display()
            ),
            10_000,
        )
        .await
        .unwrap();
    assert_eq!(made.exit_code, Some(0));
    for path in ["leak", "lane/secret.txt", "dangling"] {
        assert!(machine.read_file(path).await.is_err(), "{path}");
        let write = machine.write_file(path, "x").await.unwrap_err();
        assert!(write.to_string().contains("outside"), "{path}: {write}");
    }
    assert!(!root.path().join("nowhere").exists());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "no");
}
