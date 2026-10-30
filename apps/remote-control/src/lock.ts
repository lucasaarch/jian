import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workerLockPath } from './paths.ts';
/** True when `pid` is a live process (best-effort; false on ESRCH / invalid). */
export function isPidAlive(pid: number): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function readWorkerLockPid(lockPath = workerLockPath): number | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, Math.max(0, Number(ms) || 0));
}

/**
 * Stop a stray worker PID (SIGTERM → wait → SIGKILL). Used by stop/restart and the run lock.
 */
export function terminateWorkerPid(
  pid: number,
  {
    waitMs = 8_000,
    kill = process.kill.bind(process),
  }: { waitMs?: number; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): { stopped: boolean; alreadyDead?: true } {
  if (!isPidAlive(pid)) return { stopped: true, alreadyDead: true };
  try {
    kill(pid, 'SIGTERM');
  } catch {
    return { stopped: !isPidAlive(pid) };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isPidAlive(pid)) sleepMs(100);
  if (isPidAlive(pid)) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      // ESRCH — already gone.
    }
    sleepMs(100);
  }
  return { stopped: !isPidAlive(pid) };
}

/**
 * Claim the exclusive worker lock. If another live PID holds it, terminate that process first
 * so KeepAlive / CLI restarts never leave two pollers on the same machine.
 */
export async function acquireWorkerLock({
  lockPath = workerLockPath,
  pid = process.pid,
  maxAttempts = 8,
}: {
  lockPath?: string;
  pid?: number;
  maxAttempts?: number;
} = {}): Promise<{
  ok: true;
  pid: number;
}> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = readWorkerLockPid(lockPath);
    if (existing && existing !== pid && isPidAlive(existing)) {
      console.error(
        `Another Jian Remote worker is running (pid ${existing}); stopping it before continuing.`,
      );
      terminateWorkerPid(existing);
    }
    if (existing && !isPidAlive(existing)) {
      try {
        await unlink(lockPath);
      } catch {
        // Lost the race to remove a stale lock; retry create.
      }
    }
    try {
      writeFileSync(lockPath, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return { ok: true, pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      sleepMs(150);
    }
  }
  throw new Error(
    `Could not claim the Jian Remote worker lock at ${lockPath}. Stop other workers with: jian-remote stop`,
  );
}

export async function releaseWorkerLock({
  lockPath = workerLockPath,
  pid = process.pid,
}: {
  lockPath?: string;
  pid?: number;
} = {}): Promise<void> {
  const existing = readWorkerLockPid(lockPath);
  if (existing !== undefined && existing !== pid) return;
  try {
    await unlink(lockPath);
  } catch {
    // Best-effort; a stale pid file is cleared on the next acquire.
  }
}
