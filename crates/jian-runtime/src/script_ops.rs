//! Long commands and background jobs on the run's machine, with nothing but its shell: a script
//! goes in as a here-document (no file for the agent to write), and a job is a detached command
//! whose log and exit code the machine keeps in its temp folder.
//!
//! This speaks POSIX `sh`. A machine whose shell is PowerShell says so back, as an error the
//! model can read.

use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use jian_core::MAX_TOOL_RESULT_BYTES;
use jian_exec::{ExecError, Machine, ShellOutput};
use serde_json::Value;

use crate::tool::{Job, MachineSlot};

/// The longest command or script the tools accept, in bytes, whatever the model sends. A command
/// reaches the shell as one argument and Linux refuses an argument over 128 KiB (`MAX_ARG_STRLEN`),
/// so this stays under it with room for the wrapper. It is a ceiling, not a habit: a script that
/// long should be a file the agent writes with `write_file`.
pub const COMMAND_MAX_BYTES: usize = 100_000;
/// The longest a foreground command may run, in milliseconds, whatever the model asks.
pub const FOREGROUND_LIMIT_MS: u64 = 120_000;
/// What a foreground command gets when the model says nothing.
pub const FOREGROUND_DEFAULT_MS: u64 = 30_000;
/// What `process_output` shows of a log when the model says nothing, and the most it may ask.
const TAIL_DEFAULT: usize = 12_000;
const TAIL_MAX: usize = MAX_TOOL_RESULT_BYTES - 1_000;
/// How long a job gets to end after it is asked to, before it is killed.
const STOP_GRACE_SECS: u32 = 2;

/// The mark a job's start prints, so the log's path and the group are found among whatever the
/// shell's profile prints too.
const MARK: &str = "jian-job:";

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn exec(error: &ExecError) -> String {
    error.to_string()
}

/// What the model sees of a command's output: the last bytes, since a build or a test says why
/// it failed at the end. The machine may already have cut it; this covers one that did not.
#[must_use]
pub fn tail_for_model(output: String) -> String {
    let room = MAX_TOOL_RESULT_BYTES - 64;
    if output.len() <= room {
        return output;
    }
    let mut from = output.len() - room;
    while !output.is_char_boundary(from) {
        from += 1;
    }
    format!(
        "[output cut: the first {from} bytes were left out]\n{}",
        &output[from..]
    )
}

/// A finished foreground command as the model reads it.
pub fn finish(done: &ShellOutput) -> Result<String, String> {
    let output = tail_for_model(done.output.clone());
    match done.exit_code {
        Some(0) => Ok(output),
        Some(code) => Err(format!("exit code {code}\n{output}")),
        None => Err(format!("ended by a signal\n{output}")),
    }
}

fn too_long(what: &str, text: &str) -> Result<(), String> {
    if text.len() > COMMAND_MAX_BYTES {
        return Err(format!(
            "the {what} is {} bytes; the most one call takes is {COMMAND_MAX_BYTES}. Write it with write_file and run the file",
            text.len()
        ));
    }
    Ok(())
}

pub fn timeout(input: &Value) -> u64 {
    input
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(FOREGROUND_DEFAULT_MS)
        .min(FOREGROUND_LIMIT_MS)
}

/// The shell command that runs `script` with `language` reading it from standard input.
fn script_command(language: &str, script: &str) -> Result<String, String> {
    let reader = match language {
        "sh" => "sh",
        "python" => "\"$(command -v python3 || command -v python)\" -",
        "node" => "node -",
        other => {
            return Err(format!(
                "`language` is `sh`, `python` or `node`, not `{other}`"
            ));
        }
    };
    let mut end = String::from("JIAN_SCRIPT_END");
    while script.contains(&end) {
        end.push('_');
    }
    Ok(format!("{reader} <<'{end}'\n{script}\n{end}\n"))
}

/// `run_script`: inline `sh`, `python` or `node`, run to the end within its time.
pub async fn run_script(machine: &dyn Machine, input: &Value) -> Result<String, String> {
    let language = input
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("sh");
    let script = input
        .get("script")
        .and_then(Value::as_str)
        .ok_or("`script` is required and must be a string")?;
    too_long("script", script)?;
    let command = script_command(language, script)?;
    let done = machine
        .shell(&command, timeout(input))
        .await
        .map_err(|e| exec(&e))?;
    finish(&done)
}

/// `shell`, in the foreground.
pub async fn run_command(machine: &dyn Machine, input: &Value) -> Result<String, String> {
    let command = input
        .get("command")
        .and_then(Value::as_str)
        .ok_or("`command` is required and must be a string")?;
    too_long("command", command)?;
    let done = machine
        .shell(command, timeout(input))
        .await
        .map_err(|e| exec(&e))?;
    finish(&done)
}

fn clock() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos())
}

/// `shell` with `background: true`: starts the command and answers at once with its job id.
pub async fn start(
    machine: &dyn Machine,
    slot: &MachineSlot,
    run: &str,
    input: &Value,
) -> Result<String, String> {
    let command = input
        .get("command")
        .and_then(Value::as_str)
        .ok_or("`command` is required and must be a string")?;
    too_long("command", command)?;
    // The file name is the run's, a counter and the clock: unguessable enough that another run's
    // job cannot be found by name, and the ids that reach the model only open this run's jobs.
    let run: String = run
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(24)
        .collect();
    let name = format!("{run}-{}-{}", clock(), std::process::id());
    // The job leads its own session so stop_process can end its whole group. macOS ships no
    // `setsid` binary but always has perl, whose setsid-then-exec keeps the pid, so `$!` is the
    // group either way. The new session is made after the fork, so the start waits (up to ~5 s)
    // until the job leads its group: a stop sent before that would miss it.
    let script = format!(
        "d=\"${{TMPDIR:-/tmp}}/jian-jobs\"; mkdir -p \"$d\" && chmod 700 \"$d\" || exit 1\n\
         if command -v setsid > /dev/null; then\n\
         setsid nohup sh -c 'sh -c \"$1\"; echo $? > \"$2\"' sh {cmd} \"$d/{name}.log.exit\" \
         > \"$d/{name}.log\" 2>&1 < /dev/null &\n\
         elif command -v perl > /dev/null; then\n\
         perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; exec @ARGV or die' \
         nohup sh -c 'sh -c \"$1\"; echo $? > \"$2\"' sh {cmd} \"$d/{name}.log.exit\" \
         > \"$d/{name}.log\" 2>&1 < /dev/null &\n\
         else echo 'starting a background job needs setsid or perl'; exit 1; fi\n\
         p=$!; i=0\n\
         while [ $i -lt 50 ] && [ ! -f \"$d/{name}.log.exit\" ] && kill -s 0 $p 2>/dev/null \
               && [ \"$(ps -o pgid= -p $p 2>/dev/null | tr -d ' ')\" != \"$p\" ]; do \
         sleep 0.1; i=$((i+1)); done\n\
         echo \"{MARK}$p $d/{name}.log\"\n",
        cmd = quote(command)
    );
    let done = machine.shell(&script, 20_000).await.map_err(|e| exec(&e))?;
    let started = done
        .output
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix(MARK))
        .and_then(|rest| rest.split_once(' '))
        .map(|(group, log)| (group.to_owned(), log.trim().to_owned()));
    let Some((group, log)) = started else {
        return Err(format!(
            "could not start a background job here (it needs a POSIX shell with nohup, and setsid or perl): {}",
            done.output.trim()
        ));
    };
    let job = slot
        .add_job(group, log)
        .ok_or("the run's job list is unavailable")?;
    Ok(format!(
        "started {}; read it with process_output and end it with stop_process",
        job.id
    ))
}

fn known(slot: &MachineSlot, input: &Value) -> Result<Job, String> {
    let id = input
        .get("job")
        .and_then(Value::as_str)
        .ok_or("`job` is required: the id `shell` answered with")?;
    slot.job(id)
        .ok_or_else(|| format!("this run has no job `{id}`"))
}

/// The status line and the end of the log of `job`.
fn report_script(job: &Job, tail: usize) -> String {
    let log = quote(&job.log);
    let group = &job.group;
    format!(
        // The leader (the job's pid) lives until it has written the exit code, so its own pid
        // says whether the job runs; `ps -p` is the same on Linux and macOS, `-g` is not.
        "if [ -f {log}.exit ]; then echo \"status: exited with code $(cat {log}.exit)\"; \
         elif kill -s 0 {group} 2>/dev/null \
              && ! ps -o stat= -p {group} 2>/dev/null | grep -q '^ *Z'; then echo 'status: running'; \
         else echo 'status: ended without an exit code (killed)'; fi\n\
         echo '--- the last {tail} bytes of its output ---'\n\
         tail -c {tail} {log}\n"
    )
}

/// `process_output`: whether the job lives and the end of what it printed.
pub async fn output(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let job = known(slot, input)?;
    let tail = input
        .get("tail_bytes")
        .and_then(Value::as_u64)
        .map_or(TAIL_DEFAULT, |n| {
            usize::try_from(n).unwrap_or(TAIL_MAX).min(TAIL_MAX)
        })
        .max(1);
    let done = machine
        .shell(&report_script(&job, tail), 20_000)
        .await
        .map_err(|e| exec(&e))?;
    Ok(tail_for_model(done.output))
}

/// `stop_process`: asks the job to end, kills it if it does not, and shows what it left.
pub async fn stop(
    machine: &dyn Machine,
    slot: &MachineSlot,
    input: &Value,
) -> Result<String, String> {
    let job = known(slot, input)?;
    let log = quote(&job.log);
    let group = &job.group;
    let mut script = String::new();
    // Only a job that has not written its exit code: the group number of one that ended could
    // have been given to something else since.
    let _ = writeln!(
        script,
        "if [ ! -f {log}.exit ]; then \
         kill -s TERM -- -{group} 2>/dev/null || kill -s TERM {group} 2>/dev/null; \
         sleep {STOP_GRACE_SECS}; \
         kill -s KILL -- -{group} 2>/dev/null || kill -s KILL {group} 2>/dev/null; fi"
    );
    script.push_str(&report_script(&job, TAIL_DEFAULT));
    let done = machine.shell(&script, 30_000).await.map_err(|e| exec(&e))?;
    Ok(tail_for_model(done.output))
}
