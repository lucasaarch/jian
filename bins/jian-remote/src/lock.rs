//! One worker per machine: the running one writes its pid to `worker.pid`. A service manager
//! restart racing a CLI start would otherwise leave two workers, and the gateway would close one
//! as replaced, over and over.

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

/// How long a worker gets to stop by itself before it is killed.
const STOP_WAIT: Duration = Duration::from_secs(8);

pub fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse()
        .ok()
        .filter(|pid| *pid > 0)
}

pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // A worker that exited but was not yet reaped (an init that does not reap, as in many
        // containers) still answers signal 0; it holds nothing, so it does not count.
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            && stat
                .rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z'))
        {
            return false;
        }
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        // Signal 0 only asks whether the process exists. EPERM means it does.
        match rustix::process::test_kill_process(pid) {
            Ok(()) => true,
            Err(error) => error == rustix::io::Errno::PERM,
        }
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        output
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
    }
}

/// TERM, then KILL after [`STOP_WAIT`]. Answers whether it is gone.
pub fn terminate(pid: u32) -> bool {
    if !alive(pid) {
        return true;
    }
    signal(pid, false);
    let deadline = Instant::now() + STOP_WAIT;
    while Instant::now() < deadline && alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if alive(pid) {
        signal(pid, true);
        std::thread::sleep(Duration::from_millis(100));
    }
    !alive(pid)
}

fn signal(pid: u32, kill: bool) {
    #[cfg(unix)]
    if let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    {
        let signal = if kill {
            rustix::process::Signal::KILL
        } else {
            rustix::process::Signal::TERM
        };
        // The process may be gone already; there is nothing to do about it.
        let _ = rustix::process::kill_process(pid, signal);
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if kill {
            command.arg("/F");
        }
        let _ = command.output();
    }
}

/// Claims the lock, stopping a live worker that holds it.
pub fn acquire(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        jian_remote::state::create_private_dir(parent).map_err(|error| error.to_string())?;
    }
    let me = std::process::id();
    for _ in 0..8 {
        if let Some(held) = read_pid(path) {
            if held != me && alive(held) {
                eprintln!(
                    "Another Jian Remote worker is running (pid {held}); stopping it before continuing."
                );
                terminate(held);
            }
            if !alive(held) {
                let _ = std::fs::remove_file(path);
            }
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(path) {
            Ok(mut file) => {
                return writeln!(file, "{me}").map_err(|error| error.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(format!("Could not write {}: {error}", path.display())),
        }
    }
    Err(format!(
        "Could not claim the Jian Remote worker lock at {}. Stop other workers with: jian-remote stop",
        path.display()
    ))
}

/// Removes the lock if this process holds it; someone else's is left alone.
pub fn release(path: &Path) {
    if read_pid(path) == Some(std::process::id()) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_lock_is_taken_over_and_released() {
        // Where integration tests get CARGO_TARGET_TMPDIR; unit tests are not given it.
        let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/tmp"))
            .join(format!("jian-remote-lock-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("worker.pid");
        // No process has pid 0x7fff_fff0 here: the lock is stale.
        std::fs::write(&path, "2147483632\n").unwrap();
        acquire(&path).unwrap();
        assert_eq!(read_pid(&path), Some(std::process::id()));
        release(&path);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
