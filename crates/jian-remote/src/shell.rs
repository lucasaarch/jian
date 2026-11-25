//! A command in the machine's shell.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use jian_protocol::machine::{STDERR_CAP, STDOUT_CAP, ShellTask, Stream, TaskResult};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::ends::OutputEnds;
use crate::mask::Secrets;
use crate::process::{Pipe, run_bounded};

/// The PATH a command gets in front of the worker's own, which is thin under launchd and
/// systemd: where the usual tools live, Homebrew's included.
pub const MINIMAL_PATH: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// The user's home directory, or the temp directory when none is set.
pub fn home_dir() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .filter(|home| !home.is_empty())
        .map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// The shell by absolute path: a PATH the task changed must not choose it.
fn shell_program() -> PathBuf {
    if cfg!(windows) {
        return "powershell.exe".into();
    }
    ["/bin/sh", "/bin/bash", "/usr/bin/sh"]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// The directory to run in, and a note when the one asked for could not be used: a missing cwd
/// fails the spawn as if the shell were missing, and the agent learns nothing from that.
pub fn resolve_cwd(requested: Option<&str>, home: &Path) -> (PathBuf, Option<String>) {
    let temp = std::env::temp_dir();
    let fallback = [home, temp.as_path(), Path::new("/tmp"), Path::new("/")]
        .into_iter()
        .find(|path| path.is_dir())
        .unwrap_or(Path::new("/"))
        .to_path_buf();
    let Some(target) = requested.map(str::trim).filter(|target| !target.is_empty()) else {
        return (fallback, None);
    };
    let note = match std::fs::metadata(target) {
        Ok(meta) if meta.is_dir() => return (target.into(), None),
        Ok(_) => format!(
            "Requested cwd {target} is not a directory; using {}.",
            fallback.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => format!(
            "Requested cwd {target} does not exist on this computer; using {}.",
            fallback.display()
        ),
        Err(_) => format!(
            "Requested cwd {target} is not usable; using {}.",
            fallback.display()
        ),
    };
    (fallback, Some(note))
}

/// What a child gets on top of the worker's environment: always a usable PATH and HOME.
pub fn child_env(command: &mut Command) {
    let home = home_dir();
    if cfg!(windows) {
        command.env("USERPROFILE", &home);
    } else {
        let current = std::env::var("PATH").unwrap_or_default();
        let path = if current.is_empty() {
            MINIMAL_PATH.to_owned()
        } else {
            format!("{MINIMAL_PATH}:{current}")
        };
        command.env("PATH", path);
    }
    command.env("HOME", home);
}

/// Runs `task` within `timeout`, sending its output as it comes through `on_output`, masked.
pub async fn run_shell(
    id: &str,
    task: &ShellTask,
    timeout: Duration,
    cancel: &CancellationToken,
    mut on_output: impl FnMut(Stream, String),
) -> TaskResult {
    let shell = shell_program();
    let (cwd, note) = resolve_cwd(task.cwd.as_deref(), &home_dir());
    let mut command = Command::new(&shell);
    if cfg!(windows) {
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &task.command,
        ]);
    } else {
        command.args(["-lc", &task.command]);
    }
    command.current_dir(&cwd);
    child_env(&mut command);
    command.envs(&task.env);

    let secrets = Secrets::new(task.env.values());
    let mut streams = [secrets.stream(), secrets.stream()];
    let mut stdout = OutputEnds::new(STDOUT_CAP);
    let mut stderr = OutputEnds::new(STDERR_CAP);
    if let Some(note) = &note {
        stderr.push(&format!("{note}\n"));
    }
    let outcome = run_bounded(command, timeout, cancel, |pipe, bytes| {
        let (ends, stream, index) = match pipe {
            Pipe::Stdout => (&mut stdout, Stream::Stdout, 0),
            Pipe::Stderr => (&mut stderr, Stream::Stderr, 1),
        };
        ends.push_bytes(bytes);
        let sendable = streams[index].push(&String::from_utf8_lossy(bytes));
        if !sendable.is_empty() {
            on_output(stream, sendable);
        }
    })
    .await;
    for (index, stream) in [Stream::Stdout, Stream::Stderr].into_iter().enumerate() {
        let rest = streams[index].finish();
        if !rest.is_empty() {
            on_output(stream, rest);
        }
    }
    if let Some(error) = &outcome.spawn_error {
        stderr.push(&spawn_error(error, &shell, &cwd));
    }
    TaskResult {
        id: id.into(),
        exit_code: outcome.code,
        stdout: secrets.mask(&stdout.text()),
        stderr: secrets.mask(&stderr.text()),
        timed_out: outcome.timed_out,
        cancelled: outcome.cancelled,
        ..TaskResult::default()
    }
}

fn spawn_error(error: &std::io::Error, shell: &Path, cwd: &Path) -> String {
    if error.kind() == std::io::ErrorKind::NotFound && !cfg!(windows) && !shell.exists() {
        return format!(
            "Could not find the shell executable {}. Install a POSIX shell or reinstall Jian Remote.",
            shell.display()
        );
    }
    format!(
        "Could not start the remote shell ({}) in {}: {error}",
        shell.display(),
        cwd.display()
    )
}

/// The secret environment of a task as the log may show it: names only.
pub fn env_names(env: &BTreeMap<String, String>) -> String {
    env.keys().cloned().collect::<Vec<_>>().join(",")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_missing_cwd_falls_back_with_a_note() {
        let home = std::env::temp_dir();
        let (cwd, note) = resolve_cwd(Some("/definitely/not/here"), &home);
        assert_eq!(cwd, home);
        assert!(note.unwrap().contains("does not exist on this computer"));
        let (cwd, note) = resolve_cwd(Some("/"), &home);
        assert_eq!((cwd, note), (PathBuf::from("/"), None));
    }

    #[tokio::test]
    async fn secrets_are_masked_in_the_result_and_the_stream() {
        let task = ShellTask {
            command: "echo \"key=$JIAN_TEST_KEY\"".into(),
            cwd: None,
            env: [("JIAN_TEST_KEY".to_owned(), "sk-synthetic-0001".to_owned())].into(),
        };
        let mut streamed = String::new();
        let result = run_shell(
            "t1",
            &task,
            Duration::from_secs(10),
            &CancellationToken::new(),
            |_, chunk| streamed.push_str(&chunk),
        )
        .await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "key=[secret]\n");
        assert_eq!(streamed, "key=[secret]\n");
    }
}
