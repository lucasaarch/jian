import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MISSING_HELPER =
  'Computer-use helper is missing from this install. Reinstall or update @jian-ai/remote-control.';

/**
 * The helper binary the package ships for this OS and CPU, under the helpers root: one
 * universal file on macOS, one per CPU on Linux and Windows. native/build-*.sh write them.
 */
export function packagedBinary(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'darwin') return join(root, 'macos', 'computer-helper');
  if (platform === 'win32') return join(root, 'windows', `computer-helper-${arch}.exe`);
  return join(root, 'linux', `computer-helper-${arch}`);
}

export type BinaryInstall = {
  /** The binary as this package ships it. */
  packaged: string;
  /** Where the worker runs it from: outside the package, so an update replaces it in one place. */
  installed: string;
  stamp: string;
  /** Runs on a freshly copied binary, before it is stamped: macOS drops its quarantine here. */
  prepare?: (path: string) => void;
};

/**
 * The helper binary, ready to run: the packaged one, copied where it runs whenever its bytes
 * changed — the stamp beside it says which bytes are installed. A package that lost its copy
 * still runs the one installed before.
 */
export async function installHelperBinary({
  packaged,
  installed,
  stamp,
  prepare,
}: BinaryInstall): Promise<string> {
  if (!existsSync(packaged)) {
    if (existsSync(installed)) return installed;
    throw new Error(MISSING_HELPER);
  }
  const hash = `bin:${stampForBytes(await readFile(packaged))}`;
  if ((await readStamp(stamp)) !== hash || !existsSync(installed)) {
    await mkdir(dirname(installed), { recursive: true, mode: 0o755 });
    // Beside, then renamed into place. Windows refuses to replace an exe that is running, but
    // lets it be renamed: the old one moves aside and is deleted once nothing runs it.
    const temporary = `${installed}.${process.pid}.tmp`;
    await copyFile(packaged, temporary);
    await chmod(temporary, 0o755);
    prepare?.(temporary);
    if (process.platform === 'win32' && existsSync(installed)) {
      const aside = `${installed}.${Date.now()}.old`;
      await rename(installed, aside);
      await rm(aside, { force: true }).catch(() => {});
    }
    await rename(temporary, installed);
    await writeFile(stamp, `${hash}\n`, { mode: 0o644 });
  }
  return installed;
}

/** A short content hash, written beside an installed helper to tell when it is stale. */
function stampForBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The stamp an earlier install left, or '' when there is none. */
async function readStamp(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}
