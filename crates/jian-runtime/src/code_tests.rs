//! The programming tools against a real machine (the gateway's own, in a temp folder): what an
//! edit promises when it fails, what a stale read costs, and that a run sees only its own jobs.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use jian_exec::{Executor, LocalExecutor, Scope};
use serde_json::json;

use crate::tool::MachineSlot;
use crate::{file_ops, script_ops, standard_tools};

fn slot(root: &tempfile::TempDir, run: &str) -> MachineSlot {
    let executor: Arc<dyn Executor> = Arc::new(LocalExecutor::new(root.path()));
    MachineSlot::new(
        executor,
        Scope {
            tenant: "t1".to_owned(),
            agent: "bot".to_owned(),
            run: run.to_owned(),
        },
    )
}

/// The agent's folder, where relative paths lead.
fn folder(root: &tempfile::TempDir) -> std::path::PathBuf {
    root.path().join("t1").join("bot")
}

async fn put(slot: &MachineSlot, path: &str, content: &str) {
    let machine = slot.get().await.unwrap();
    file_ops::write(machine, slot, &json!({ "path": path, "content": content }))
        .await
        .unwrap();
}

async fn text_of(slot: &MachineSlot, path: &str) -> String {
    let machine = slot.get().await.unwrap();
    machine.read_file(path).await.unwrap()
}

#[tokio::test]
async fn an_edit_that_cannot_apply_to_one_file_changes_none() {
    let root = tempfile::tempdir().unwrap();
    let slot = slot(&root, "r1");
    put(&slot, "a.txt", "one\ntwo\n").await;
    put(&slot, "b.txt", "red\nred\n").await;
    let machine = slot.get().await.unwrap();

    let both = json!({ "files": [
        { "path": "a.txt", "replacements": [{ "old": "two", "new": "2" }] },
        { "path": "b.txt", "replacements": [{ "old": "blue", "new": "x" }] },
    ]});
    let error = file_ops::edit(machine, &slot, &both).await.unwrap_err();
    assert!(error.contains("not found in"), "{error}");
    assert_eq!(text_of(&slot, "a.txt").await, "one\ntwo\n");

    // More than one place: the count and the lines, and nothing changed.
    let many = json!({ "path": "b.txt", "old": "red", "new": "blue" });
    let error = file_ops::edit(machine, &slot, &many).await.unwrap_err();
    assert!(
        error.contains("2 times") && error.contains("lines 1, 2"),
        "{error}"
    );
    assert_eq!(text_of(&slot, "b.txt").await, "red\nred\n");

    // The text is not there but something like it is: the line to look at comes back.
    let near = json!({ "path": "a.txt", "old": "twoo", "new": "x" });
    let error = file_ops::edit(machine, &slot, &near).await.unwrap_err();
    assert!(error.contains("line 2: two"), "{error}");

    // Both apply: both change, and replaceAll takes every place.
    let ok = json!({ "files": [
        { "path": "a.txt", "replacements": [{ "old": "two", "new": "2" }] },
        { "path": "b.txt", "replacements": [{ "old": "red", "new": "blue", "replace_all": true }] },
    ]});
    file_ops::edit(machine, &slot, &ok).await.unwrap();
    assert_eq!(text_of(&slot, "a.txt").await, "one\n2\n");
    assert_eq!(text_of(&slot, "b.txt").await, "blue\nblue\n");
}

#[tokio::test]
async fn a_file_that_changed_since_it_was_read_is_not_edited() {
    let root = tempfile::tempdir().unwrap();
    let slot = slot(&root, "r1");
    put(&slot, "a.txt", "one\n").await;
    let machine = slot.get().await.unwrap();
    let shown = file_ops::read(machine, &slot, &json!({ "path": "a.txt" }))
        .await
        .unwrap();
    assert_eq!(shown, "     1\tone\n");

    // Someone else changes it (a later mtime, whatever the file system's grain).
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(folder(&root).join("a.txt"), "uno\n").unwrap();
    let change = json!({ "path": "a.txt", "old": "one", "new": "1" });
    let error = file_ops::edit(machine, &slot, &change).await.unwrap_err();
    assert!(error.contains("changed since it was read"), "{error}");
    let overwrite = json!({ "path": "a.txt", "content": "mine\n" });
    assert!(file_ops::write(machine, &slot, &overwrite).await.is_err());
    assert_eq!(text_of(&slot, "a.txt").await, "uno\n");

    // Read again and the edit goes through; a file never read needs no read first.
    file_ops::read(machine, &slot, &json!({ "path": "a.txt" }))
        .await
        .unwrap();
    let again = json!({ "path": "a.txt", "old": "uno", "new": "1" });
    file_ops::edit(machine, &slot, &again).await.unwrap();
    std::fs::write(folder(&root).join("fresh.txt"), "x\n").unwrap();
    let fresh = json!({ "path": "fresh.txt", "old": "x", "new": "y" });
    file_ops::edit(machine, &slot, &fresh).await.unwrap();
}

#[tokio::test]
async fn reading_gives_a_range_and_several_files_in_one_call() {
    let root = tempfile::tempdir().unwrap();
    let slot = slot(&root, "r1");
    let ten = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
    put(&slot, "ten.txt", ten).await;
    put(&slot, "two.txt", "a\nb\n").await;
    let machine = slot.get().await.unwrap();
    let range = json!({ "path": "ten.txt", "offset": 4, "limit": 2 });
    let shown = file_ops::read(machine, &slot, &range).await.unwrap();
    assert!(shown.starts_with("     4\tl4\n     5\tl5\n"), "{shown}");
    assert!(
        shown.contains("lines 4-5 of 10") && shown.contains("offset=6"),
        "{shown}"
    );
    let many = json!({ "paths": ["two.txt", "missing.txt"] });
    let shown = file_ops::read(machine, &slot, &many).await.unwrap();
    assert!(
        shown.contains("==> two.txt <==\n     1\ta\n     2\tb\n"),
        "{shown}"
    );
    assert!(shown.contains("==> missing.txt <==\nerror:"), "{shown}");
    // Outside the folder is refused on this machine.
    let outside = json!({ "path": "../../../etc/hosts" });
    assert!(file_ops::read(machine, &slot, &outside).await.is_err());
}

#[tokio::test]
async fn a_patch_applies_whole_or_not_at_all() {
    let root = tempfile::tempdir().unwrap();
    let slot = slot(&root, "r1");
    put(&slot, "a.txt", "one\ntwo\nthree\n").await;
    put(&slot, "b.txt", "x\ny\n").await;
    let machine = slot.get().await.unwrap();

    let bad = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n\
               --- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n x\n-nope\n+z\n";
    let error = file_ops::apply_patch(machine, &slot, &json!({ "patch": bad }))
        .await
        .unwrap_err();
    assert!(error.contains("not found in"), "{error}");
    assert_eq!(text_of(&slot, "a.txt").await, "one\ntwo\nthree\n");

    let good = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n\
                --- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n\
                --- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n";
    file_ops::apply_patch(machine, &slot, &json!({ "patch": good }))
        .await
        .unwrap();
    assert_eq!(text_of(&slot, "a.txt").await, "one\nTWO\nthree\n");
    assert_eq!(text_of(&slot, "b.txt").await, "x\nz\n");
    assert_eq!(text_of(&slot, "new.txt").await, "hello\n");
}

#[tokio::test]
async fn search_find_and_list_see_the_folder() {
    let root = tempfile::tempdir().unwrap();
    let slot = slot(&root, "r1");
    put(&slot, "src/lib.rs", "fn main() {}\n").await;
    put(&slot, "notes.md", "nothing\n").await;
    let machine = slot.get().await.unwrap();
    let found = file_ops::search(machine, &json!({ "pattern": "fn main", "glob": "*.rs" }))
        .await
        .unwrap();
    assert!(
        found.contains("lib.rs") && found.contains("fn main"),
        "{found}"
    );
    let files = file_ops::find(machine, &json!({ "pattern": "**/*.rs" }))
        .await
        .unwrap();
    assert!(files.contains("lib.rs"), "{files}");
    let listed = file_ops::list(machine, &json!({})).await.unwrap();
    assert!(
        listed.contains("src/") && listed.contains("notes.md"),
        "{listed}"
    );
}

#[test]
fn a_run_that_may_only_suggest_gets_the_reads_and_no_tool_that_writes() {
    let names = standard_tools().read_only().names();
    for read in ["read_file", "list_directory", "find_files", "search_files"] {
        assert!(names.contains(&read), "{read} in {names:?}");
    }
    for write in [
        "edit_file",
        "write_file",
        "apply_patch",
        "run_script",
        "shell",
        "process_output",
        "stop_process",
    ] {
        assert!(!names.contains(&write), "{write} in {names:?}");
    }
}

#[cfg(unix)]
mod unix {
    use super::*;

    #[tokio::test]
    async fn a_script_runs_inline_and_stops_at_its_time() {
        let root = tempfile::tempdir().unwrap();
        let slot = slot(&root, "r1");
        let machine = slot.get().await.unwrap();
        // Longer than the old 4000-character command limit, with quotes in it.
        let long = format!("echo 'it''s'; {}echo done", "echo -n x; ".repeat(1000));
        let out = script_ops::run_script(machine, &json!({ "script": long }))
            .await
            .unwrap();
        assert!(
            out.starts_with("its\n") && out.trim_end().ends_with("done"),
            "{out}"
        );
        let python = json!({ "language": "python", "script": "print(6 * 7)" });
        if let Ok(out) = script_ops::run_script(machine, &python).await {
            assert_eq!(out.trim(), "42");
        }
        let sleeper = json!({ "script": "sleep 20", "timeout_ms": 300 });
        let error = script_ops::run_script(machine, &sleeper).await.unwrap_err();
        assert!(error.contains("time limit"), "{error}");
        let huge = json!({ "script": "x".repeat(script_ops::COMMAND_MAX_BYTES + 1) });
        let error = script_ops::run_script(machine, &huge).await.unwrap_err();
        assert!(error.contains("100000"), "{error}");
    }

    #[tokio::test]
    async fn a_background_job_is_started_read_and_stopped_by_its_own_run_only() {
        let root = tempfile::tempdir().unwrap();
        let mine = slot(&root, "r1");
        let other = slot(&root, "r2");
        let machine = mine.get().await.unwrap();
        let quick =
            json!({ "command": "echo started; sleep 1; echo finished", "background": true });
        let said = script_ops::start(machine, &mine, "r1", &quick)
            .await
            .unwrap();
        assert!(said.starts_with("started job-1"), "{said}");

        let poll = json!({ "job": "job-1" });
        let running = script_ops::output(machine, &mine, &poll).await.unwrap();
        assert!(running.contains("status: running"), "{running}");
        let mut last = String::new();
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            last = script_ops::output(machine, &mine, &poll).await.unwrap();
            if last.contains("exited") {
                break;
            }
        }
        assert!(
            last.contains("exited with code 0") && last.contains("finished"),
            "{last}"
        );

        // Another run, same machine: it has no such job, by id or by anything it could guess.
        let other_machine = other.get().await.unwrap();
        let error = script_ops::output(other_machine, &other, &poll)
            .await
            .unwrap_err();
        assert!(error.contains("no job"), "{error}");
        assert!(
            script_ops::stop(other_machine, &other, &poll)
                .await
                .is_err()
        );

        // A long job is stopped on request.
        let long = json!({ "command": "echo up; sleep 60", "background": true });
        let said = script_ops::start(machine, &mine, "r1", &long)
            .await
            .unwrap();
        assert!(said.starts_with("started job-2"), "{said}");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let stopped = script_ops::stop(machine, &mine, &json!({ "job": "job-2" }))
            .await
            .unwrap();
        assert!(
            stopped.contains("killed") && stopped.contains("up"),
            "{stopped}"
        );
    }
}
