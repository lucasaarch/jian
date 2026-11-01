import { readlinkSync } from 'node:fs';
import { join } from 'node:path';

const NAP_MS = 250;
/** How long a holder gets to stop, in ms: a gateway stopping can take 7 seconds on its own. */
const LEAVES_WITHIN_MS = 15_000;

/** Who holds the app's lock, from the link Chromium keeps as `host-pid` in the app's folder. */
export function lockHolder(userData: string): number | undefined {
  try {
    const pid = Number(readlinkSync(join(userData, 'SingletonLock')).split('-').pop());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It exists, and is only someone else's to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Waits for whoever holds the lock to be gone, and only then lets the lock be asked for. Asking
 * while it is held must not happen: Electron 45 never fires `ready` in a process whose first
 * `requestSingleInstanceLock` failed, even once a later one succeeds, which leaves it running with
 * no window and no gateway. It blocks, as nothing else may start before the lock is decided.
 *
 * False for a holder that stays: another launch of the app, not a restart.
 */
export function whenHolderLeft({
  holder,
  alive: isAlive = alive,
  nap = (ms) => Atomics.wait(pause, 0, 0, ms),
}: {
  holder: () => number | undefined;
  alive?: (pid: number) => boolean;
  nap?: (ms: number) => unknown;
}): boolean {
  for (let waited = 0; waited < LEAVES_WITHIN_MS; waited += NAP_MS) {
    const pid = holder();
    if (pid === undefined || !isAlive(pid)) return true;
    nap(NAP_MS);
  }

  const pid = holder();
  return pid === undefined || !isAlive(pid);
}
