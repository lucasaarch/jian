//! The file operations on the gateway's machine and on a connected one: the same script gives the
//! same answers. This is what lets an agent code the same way wherever its machine is.

use jian_exec::{Executor, LocalExecutor, Machine, files_done};
use jian_protocol::machine::{
    FileEdit, FilesAnswer, FilesDone, FilesOp, FilesProblem, Replacement, SearchOutput,
};
use jian_server::AgentMachines;
use jian_store::AgentMachine;
use serde_json::Value;

use super::accounts::{open_settings, start};
use super::machines::{agent_of, choose, online, scope};
use super::support::RealWorker;

/// A folder as both machines name it. Canonicalizing on Windows gives the `\\?\D:\` form, which
/// takes no `/` (os error 123) and is not what either machine answers with.
fn plain(dir: &std::path::Path) -> String {
    let real = std::fs::canonicalize(dir).unwrap();
    let text = real.to_str().unwrap();
    text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
}

/// The answer with what legitimately differs between two machines taken out: modification times,
/// the folder the files are in, and which separator joins a Windows path.
fn shape(answer: &FilesAnswer, root: &str) -> Value {
    fn clean(value: &mut Value, root: &str) {
        match value {
            Value::Object(map) => {
                map.remove("mtimeMs");
                map.values_mut().for_each(|v| clean(v, root));
            }
            Value::Array(items) => items.iter_mut().for_each(|v| clean(v, root)),
            Value::String(text) => *text = text.replace('\\', "/").replace(root, "<root>"),
            _ => {}
        }
    }
    let root = root.replace('\\', "/");
    let mut value = serde_json::to_value(answer).unwrap();
    clean(&mut value, &root);
    value
}

fn edit(path: &str, old: &str, new: &str, replace_all: bool, expected: Option<f64>) -> FileEdit {
    FileEdit {
        path: path.to_owned(),
        create: None,
        expected_mtime_ms: expected,
        replacements: vec![Replacement {
            old: old.to_owned(),
            new: new.to_owned(),
            replace_all,
        }],
    }
}

fn read(path: &str, from: Option<usize>, lines: Option<usize>) -> FilesOp {
    FilesOp::Read {
        path: path.to_owned(),
        max_bytes: 1_000_000,
        from_line: from,
        max_lines: lines,
    }
}

fn mtime(done: &FilesAnswer) -> f64 {
    match done {
        FilesAnswer::Done(FilesDone::Read { mtime_ms, .. }) => *mtime_ms,
        other => panic!("not a read: {other:?}"),
    }
}

/// One script, whose answers are returned in order. `at` is the folder the files are in, as a
/// prefix of the paths the script uses: empty where relative paths start in it.
async fn script(machine: &dyn Machine, at: &str, root: &str) -> Vec<Value> {
    let p = |name: &str| format!("{at}{name}");
    let (a, b) = (p("a.txt"), p("sub/b.txt"));
    let mut seen = Vec::new();
    let mut run = |answer: FilesAnswer| seen.push(shape(&answer, root));

    let numbers = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n";
    for (path, text) in [(&a, numbers), (&b, "needle here\nand needle there\n")] {
        let op = FilesOp::Write {
            path: path.clone(),
            content: text.to_owned(),
            expected_mtime_ms: None,
        };
        run(machine.files(op).await.unwrap());
    }
    run(machine.files(read(&a, Some(3), Some(3))).await.unwrap());
    run(machine
        .files(FilesOp::Search {
            path: p("."),
            pattern: "needle".to_owned(),
            glob: Some("*.txt".to_owned()),
            ignore_case: false,
            context_lines: 0,
            output: SearchOutput::Count,
            limit: 50,
        })
        .await
        .unwrap());
    run(machine
        .files(FilesOp::Find {
            path: p("."),
            pattern: "**/*.txt".to_owned(),
            limit: 50,
        })
        .await
        .unwrap());

    // Two files edited at once.
    let before = machine.files(read(&a, None, None)).await.unwrap();
    let both = FilesOp::Edit {
        files: vec![
            edit(&a, "line2\n", "two\n", false, Some(mtime(&before))),
            edit(&b, "needle here", "needle HERE", false, None),
        ],
    };
    run(machine.files(both).await.unwrap());
    run(machine.files(read(&a, Some(2), Some(1))).await.unwrap());

    // An edit that cannot apply to the second file changes neither.
    let bad = FilesOp::Edit {
        files: vec![
            edit(&a, "line3\n", "three\n", false, None),
            edit(&b, "absent text", "x", false, None),
        ],
    };
    run(machine.files(bad).await.unwrap());
    run(machine.files(read(&a, Some(3), Some(1))).await.unwrap());
    // More than one place, without replaceAll: refused with the count.
    let twice = FilesOp::Edit {
        files: vec![edit(&b, "needle", "pin", false, None)],
    };
    run(machine.files(twice).await.unwrap());
    // The file changed since it was read.
    let stale = FilesOp::Edit {
        files: vec![edit(&a, "line4\n", "four\n", false, Some(1.0))],
    };
    run(machine.files(stale).await.unwrap());
    run(machine.files(read(&a, Some(4), Some(1))).await.unwrap());
    seen
}

#[tokio::test]
async fn the_same_script_gives_the_same_answers_on_the_gateways_machine_and_a_connected_one() {
    let (gateway, tenants) = start(open_settings()).await;
    let a = &tenants.a;
    let agent = agent_of(&gateway, a).await;
    let scope = scope(a, &agent);

    // The gateway's own machine: relative paths start in the agent's folder.
    let work = tempfile::tempdir().unwrap();
    let local = LocalExecutor::new(work.path()).open(&scope).await.unwrap();
    // The agent's own folder is two levels down (tenant, agent), made when the machine opened.
    let only = |dir: &std::path::Path| {
        let mut all = std::fs::read_dir(dir).unwrap();
        all.next().unwrap().unwrap().path()
    };
    let local_root = plain(&only(&only(work.path())));
    let local_answers = script(local.as_ref(), "", &local_root).await;

    // A connected machine: the same script, in a folder of its own.
    let executor = AgentMachines::new(gateway.db.clone(), gateway.state.hub.clone(), None);
    choose(&gateway, a, &agent, AgentMachine::Machine(a.machine_id())).await;
    let worker = RealWorker::start(&gateway.url(), &a.machine_token);
    online(&gateway, a).await;
    let hub = executor.open(&scope).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let hub_root = plain(dir.path());
    let at = format!("{hub_root}/");
    let hub_answers = script(hub.as_ref(), &at, &hub_root).await;

    assert_eq!(local_answers.len(), hub_answers.len());
    for (i, (l, h)) in local_answers.iter().zip(&hub_answers).enumerate() {
        assert_eq!(l, h, "step {i} differs between the machines");
    }
    // And the script did what it should, not only the same thing twice.
    let text = |i: usize| {
        local_answers[i]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(text(2), "line3\nline4\nline5\n");
    assert_eq!(local_answers[2]["firstLine"], 3);
    assert_eq!(local_answers[2]["totalLines"], 10);
    assert_eq!(text(6), "two\n", "{}", local_answers[5]);
    let message = |i: usize| {
        local_answers[i]["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    assert!(message(7).contains("not found"), "{}", message(7));
    assert_eq!(text(8), "line3\n", "a failed edit changed nothing");
    assert!(message(9).contains("2 times"), "{}", message(9));
    assert_eq!(local_answers[10]["problem"], "changed");
    assert_eq!(text(11), "line4\n");

    // Neither machine is a way out of what it guards: the gateway's folder, the worker's own
    // credentials.
    let outside = work.path().join("outside.txt");
    std::fs::write(&outside, "no").unwrap();
    let refused = files_done(local.as_ref(), read(outside.to_str().unwrap(), None, None)).await;
    assert!(refused.is_err());
    let secret = format!(
        "{}/.config/jian-remote/state.json",
        std::env::var("HOME").unwrap()
    );
    match hub.files(read(&secret, None, None)).await.unwrap() {
        FilesAnswer::Failed(failed) => assert_eq!(failed.problem, FilesProblem::Refused),
        other @ FilesAnswer::Done(_) => panic!("the worker's own folder was read: {other:?}"),
    }
    worker.stop().await;
    gateway.stop().await;
}
