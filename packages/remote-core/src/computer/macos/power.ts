import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

/**
 * Power assertions through caffeinate. Each one names the process it serves with `-w`, so
 * macOS drops it by itself when that process dies, even if this one never gets to.
 */

let workerIdle: ChildProcess | null = null;
let sessionDisplay: { pid: number; process: ChildProcess } | null = null;

function caffeinate(flags: string, pid: number): ChildProcess | null {
  try {
    const child = spawn('/usr/bin/caffeinate', [flags, '-w', String(pid)], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

function stop(child: ChildProcess | null | undefined): void {
  try {
    child?.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * Keeps the system from idle sleep while the worker runs, so its polls go on with the screen
 * locked. A closed lid still sleeps the machine; this does not claim otherwise.
 */
export function startWorkerIdleAssertion(pid: number = process.pid): void {
  if (process.platform !== 'darwin') return;
  stopWorkerIdleAssertion();
  workerIdle = caffeinate('-i', pid);
}

export function stopWorkerIdleAssertion(): void {
  stop(workerIdle);
  workerIdle = null;
}

/** While a Computer Use helper runs, the display stays on too: the agent is looking at it. */
export function holdSessionDisplay(pid: number): void {
  if (process.platform !== 'darwin') return;
  if (sessionDisplay?.pid === pid && sessionDisplay.process.exitCode === null) return;
  releaseSessionDisplay();
  const child = caffeinate('-dimsu', pid);
  sessionDisplay = child ? { pid, process: child } : null;
}

export function releaseSessionDisplay(): void {
  stop(sessionDisplay?.process);
  sessionDisplay = null;
}

/** A moment of declared user activity: wakes a sleeping display. Blocks for `seconds`. */
export function wakeMacDisplay(seconds = 3): void {
  if (process.platform !== 'darwin') return;
  const secs = Math.max(1, Math.min(30, Math.round(seconds)));
  spawnSync('/usr/bin/caffeinate', ['-u', '-t', String(secs)], {
    encoding: 'utf8',
    timeout: (secs + 2) * 1000,
  });
}
