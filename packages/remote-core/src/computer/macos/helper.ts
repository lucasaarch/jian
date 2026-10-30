import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MISSING_HELPER, readStamp, stampForBytes } from '../helper-files.ts';
import { helpersRoot } from '../helpers.ts';

const HELPER_NAME = 'computer-helper';

/** Where the helper runs from: outside the package, so an update replaces it in one place. */
export function helperPaths(home = homedir()) {
  const support = join(home, 'Library', 'Application Support', 'Jian Remote');
  return {
    support,
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/**
 * The universal binary the package ships, built from packages/remote-core/native. A checkout
 * has it only after `native/build-macos.sh`.
 */
export function packagedHelper(root = helpersRoot()): string {
  return join(root, 'macos', HELPER_NAME);
}

/** Drops the download quarantine, without which a helper from npm cannot run under launchd. */
function clearQuarantine(path: string): void {
  spawnSync('xattr', ['-d', 'com.apple.quarantine', path], { encoding: 'utf8' });
}

/**
 * The helper binary, ready to run: the packaged one, copied where it runs whenever its bytes
 * changed — the stamp beside it says which bytes are installed. A package that lost its copy
 * still runs the one installed before.
 */
export async function ensureHelperBinary({
  packaged = packagedHelper(),
  paths = helperPaths(),
}: {
  packaged?: string;
  paths?: ReturnType<typeof helperPaths>;
} = {}): Promise<string> {
  if (!existsSync(packaged)) {
    if (existsSync(paths.binary)) return paths.binary;
    throw new Error(MISSING_HELPER);
  }
  const hash = `bin:${stampForBytes(await readFile(packaged))}`;
  if ((await readStamp(paths.stamp)) !== hash || !existsSync(paths.binary)) {
    await mkdir(paths.support, { recursive: true, mode: 0o755 });
    await copyFile(packaged, paths.binary);
    await chmod(paths.binary, 0o755);
    clearQuarantine(paths.binary);
    await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
  }
  return paths.binary;
}

/**
 * At install: the helper where it runs, and a copy beside the installed worker, which looks
 * for its helpers there.
 */
export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  if (process.platform !== 'darwin' || !existsSync(packagedHelper())) return;
  try {
    await ensureHelperBinary();
    const directory = join(configDir, 'macos');
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await copyFile(packagedHelper(), join(directory, HELPER_NAME));
    await chmod(join(directory, HELPER_NAME), 0o755);
    clearQuarantine(join(directory, HELPER_NAME));
  } catch {
    // Best effort at install: a session that still cannot find its helper says so then.
  }
}
