/**
 * Computer Use on Windows: the Rust helper (packages/remote-core/native) captures the primary
 * display, draws the Jian pointer and drives input through SendInput.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { installHelperBinary, packagedBinary } from './helper-files.ts';
import { helpersInstallDir, helpersRoot } from './helpers.ts';
import { ComputerSession, captureThroughHelper } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.win32;
const HELPER_NAME = 'computer-helper.exe';

/** Where the helper runs from: outside the package, so an update replaces it in one place. */
export function helperPaths(home = homedir()) {
  const support = helpersInstallDir() ?? join(home, '.config', 'jian-remote', 'windows');
  return {
    support,
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/** The binary the package ships for this CPU; a checkout has it after `native/build-windows.sh`. */
export function packagedHelper(root = helpersRoot(), arch: string = process.arch): string {
  return packagedBinary(root, 'win32', arch);
}

export function ensureHelperBinary({
  packaged = packagedHelper(),
  paths = helperPaths(),
}: {
  packaged?: string;
  paths?: ReturnType<typeof helperPaths>;
} = {}): Promise<string> {
  return installHelperBinary({ packaged, installed: paths.binary, stamp: paths.stamp });
}

/**
 * At install: the helper where it runs, and a copy beside the installed worker, which looks
 * for its helpers there.
 */
export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  const packaged = packagedHelper();
  if (process.platform !== 'win32' || !existsSync(packaged)) return;
  try {
    await ensureHelperBinary({ packaged });
    const directory = join(configDir, 'windows');
    await mkdir(directory, { recursive: true });
    await copyFile(packaged, join(directory, basename(packaged)));
  } catch {
    // Best effort at install: a session that still cannot find its helper says so then.
  }
}

let sharedSession: ComputerSession | null = null;

export function computerSession(): ComputerSession {
  sharedSession ??= new ComputerSession({
    async launch() {
      return spawn(await ensureHelperBinary(), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
    capture: captureThroughHelper,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/** Whether this PC can offer Computer Use: the package ships its helper, or one is installed. */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await ensureHelperBinary();
    return true;
  } catch {
    return false;
  }
}
