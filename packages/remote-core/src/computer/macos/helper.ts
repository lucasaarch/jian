import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installHelperBinary, packagedBinary } from '../helper-files.ts';
import { helpersInstallDir, helpersRoot } from '../helpers.ts';

const HELPER_NAME = 'computer-helper';

/** Where the helper runs from: outside the package, so an update replaces it in one place. */
export function helperPaths(home = homedir()) {
  const support =
    helpersInstallDir() ?? join(home, 'Library', 'Application Support', 'Jian Remote');
  return {
    support,
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/** The universal binary the package ships; a checkout has it after `native/build-macos.sh`. */
export function packagedHelper(root = helpersRoot()): string {
  return packagedBinary(root, 'darwin');
}

/** Drops the download quarantine, without which a helper from npm cannot run under launchd. */
function clearQuarantine(path: string): void {
  spawnSync('xattr', ['-d', 'com.apple.quarantine', path], { encoding: 'utf8' });
}

export function ensureHelperBinary({
  packaged = packagedHelper(),
  paths = helperPaths(),
}: {
  packaged?: string;
  paths?: ReturnType<typeof helperPaths>;
} = {}): Promise<string> {
  return installHelperBinary({
    packaged,
    installed: paths.binary,
    stamp: paths.stamp,
    prepare: clearQuarantine,
  });
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
