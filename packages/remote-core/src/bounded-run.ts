import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';

/** How a child is started: `spawn`, or a test's stand-in. */
export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How long a stopped command gets to end by itself before it is killed, in ms. */
const TERM_GRACE_MS = 2000;
/**
 * How long a command's pipes may stay open after its own process exited, in ms. What it printed
 * last is read in this time; past it, whoever still holds them is something it left running, and
 * the worker, which runs one task at a time, cannot wait for that to end.
 */
const EXIT_DRAIN_MS = 1000;

export type BoundedOutcome = {
  code: number | null;
  timedOut: boolean;
  /** Set only when the process could not be started. */
  error?: Error;
};

export type BoundedRun = {
  done: Promise<BoundedOutcome>;
  /** Stops the command and everything it started, as its time limit does. */
  stop(): void;
};

/** Commands still running: a worker that exits takes them along, as they can report to no one. */
const running = new Set<() => void>();
let reapsOnExit = false;

function reapOnExit(): void {
  if (reapsOnExit) return;
  reapsOnExit = true;
  process.on('exit', () => {
    for (const reap of running) reap();
  });
}

const windowsTreeKill = (pid: number) => ['/PID', String(pid), '/T', '/F'];

/**
 * Ends the tree on Windows. `taskkill /T` walks it from the root, so it has to run while the root
 * lives: `child.kill()` first would leave the descendants with nothing to be found through.
 */
function killWindowsTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  try {
    const killer = spawn('taskkill.exe', windowsTreeKill(child.pid), {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => child.kill());
    killer.on('close', (code) => {
      if (code) child.kill();
    });
  } catch {
    child.kill();
  }
}

/** POSIX: the command leads its own process group, so the negative pid reaches all of it. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (!child.pid) throw new Error('not started');
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone, or the child was never its leader.
    child.kill(signal);
  }
}

/**
 * Runs a command that cannot outlast its limit: on time it is stopped with its process tree, and
 * the answer comes even if something it left behind keeps the pipes open. A process it left
 * running when it ended normally is not touched, and its pipes are still read (and thrown away)
 * so that its next write does not kill it with SIGPIPE. A process that made its own session
 * (`setsid`) has left the group and is not stopped either.
 */
export function runBounded(
  command: string,
  args: string[],
  {
    spawnOptions,
    timeoutMs,
    onStdout,
    onStderr,
    encoding,
    spawnImpl = spawn as Spawn,
    platform = process.platform,
  }: {
    spawnOptions: SpawnOptions;
    timeoutMs: number;
    onStdout: (chunk: string | Buffer) => void;
    onStderr: (chunk: string | Buffer) => void;
    encoding?: BufferEncoding;
    spawnImpl?: Spawn;
    platform?: NodeJS.Platform;
  },
): BoundedRun {
  const windows = platform === 'win32';
  // On Windows a detached child opens a console of its own; `taskkill /T` needs no group there.
  const child = spawnImpl(command, args, { ...spawnOptions, detached: !windows });
  const signal = (name: NodeJS.Signals) => {
    if (windows) killWindowsTree(child);
    else signalGroup(child, name);
  };
  const reap = () => {
    if (windows && child.pid) {
      spawnSync('taskkill.exe', windowsTreeKill(child.pid), {
        stdio: 'ignore',
        windowsHide: true,
        timeout: TERM_GRACE_MS,
      });
    } else if (!windows) {
      signalGroup(child, 'SIGTERM');
    }
  };
  reapOnExit();
  running.add(reap);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), TERM_GRACE_MS).unref();
  };

  // Dropped once answered: a process left running must not keep the captured output in memory.
  let out: typeof onStdout | undefined = onStdout;
  let err: typeof onStderr | undefined = onStderr;
  if (encoding) {
    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
  }
  child.stdout?.on('data', (chunk: string | Buffer) => out?.(chunk));
  child.stderr?.on('data', (chunk: string | Buffer) => err?.(chunk));
  // A pipe that breaks must not take the worker down with an unhandled 'error' event.
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  let timedOut = false;
  const limit = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);

  const done = new Promise<BoundedOutcome>((resolve) => {
    let answered = false;
    let draining: NodeJS.Timeout | undefined;
    const answer = (code: number | null, error?: Error) => {
      if (answered) return;
      answered = true;
      clearTimeout(limit);
      clearTimeout(draining);
      running.delete(reap);
      out = undefined;
      err = undefined;
      // Whatever still holds the pipes must not keep this process from exiting.
      for (const pipe of [child.stdout, child.stderr]) {
        (pipe as { unref?: () => void } | null)?.unref?.();
      }
      child.unref?.();
      resolve({ code, timedOut, ...(error ? { error } : {}) });
    };
    child.on('error', (error) => {
      // With a pid it started, and this is a signal that failed: its exit still comes.
      if (!child.pid) answer(null, error);
    });
    child.on('exit', (code) => {
      running.delete(reap);
      // The limit was for this process; what it left running is not on the clock.
      clearTimeout(limit);
      draining = setTimeout(() => answer(code), EXIT_DRAIN_MS);
    });
    child.on('close', (code) => answer(code));
  });

  return { done, stop };
}
