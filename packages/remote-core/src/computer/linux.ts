/**
 * Computer Use on Linux (X11, or XWayland): the Rust helper (packages/remote-core/native)
 * captures the screen, draws the Jian pointer and drives input through XTest. It is one static
 * binary per CPU and needs nothing from the distribution but an X display.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { installHelperBinary, packagedBinary } from './helper-files.ts';
import { helpersRoot } from './helpers.ts';
import { ComputerSession, captureThroughHelper } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.linux;
const HELPER_NAME = 'computer-helper';

/** Where the helper runs from: outside the package, so an update replaces it in one place. */
function helperPaths(home = homedir()) {
  const support = join(home, '.local', 'share', 'jian-remote');
  return {
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/** The binary for this CPU the package ships; a checkout has it after `native/build-linux.sh`. */
export function packagedHelper(root = helpersRoot()): string {
  return packagedBinary(root, 'linux');
}

function ensureHelperBinary(): Promise<string> {
  const paths = helperPaths();
  return installHelperBinary({
    packaged: packagedHelper(),
    installed: paths.binary,
    stamp: paths.stamp,
  });
}

/**
 * At install: the helper where it runs, and a copy beside the installed worker, which looks
 * for its helpers there.
 */
export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  if (process.platform !== 'linux' || !existsSync(packagedHelper())) return;
  try {
    await ensureHelperBinary();
    const copy = packagedBinary(configDir, 'linux');
    await mkdir(dirname(copy), { recursive: true, mode: 0o755 });
    await copyFile(packagedHelper(), copy);
    await chmod(copy, 0o755);
  } catch {
    // Best effort at install: a session that still cannot find its helper says so then.
  }
}

let sharedSession: ComputerSession | null = null;

export function computerSession(): ComputerSession {
  sharedSession ??= new ComputerSession({
    async launch() {
      return spawn(await ensureHelperBinary(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    capture: captureThroughHelper,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/**
 * The helper is here and there is an X display to talk to: X11, or XWayland, which sets
 * DISPLAY too. A Wayland session without XWayland cannot be driven this way.
 */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return false;
  try {
    await ensureHelperBinary();
    return true;
  } catch {
    return false;
  }
}
