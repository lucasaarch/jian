import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const MISSING_HELPER =
  'Computer-use helper is missing from this install. Reinstall or update @jian-ai/remote-control.';

/** A short content hash, written beside an installed helper to tell when it is stale. */
export function stampForBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The stamp an earlier install left, or '' when there is none. */
export async function readStamp(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

export type ScriptInstall = {
  /** The script as this package ships it. */
  packaged: string;
  /** Where the running worker executes it from: outside the package, so updates swap it. */
  installed: string;
  stamp: string;
};

/**
 * Puts the packaged helper script where it runs, rewriting it only when its content changed.
 * A package that lost its copy still runs the one installed before.
 */
export async function installHelperScript({
  packaged,
  installed,
  stamp,
}: ScriptInstall): Promise<string> {
  let source: string;
  try {
    source = await readFile(packaged, 'utf8');
  } catch {
    try {
      source = await readFile(installed, 'utf8');
    } catch {
      throw new Error(MISSING_HELPER);
    }
  }
  const hash = stampForBytes(Buffer.from(source, 'utf8'));
  await mkdir(dirname(installed), { recursive: true, mode: 0o755 });
  if ((await readStamp(stamp)) !== hash || !existsSync(installed)) {
    await writeFile(installed, source, { mode: 0o755 });
    await writeFile(stamp, `${hash}\n`, { mode: 0o644 });
  }
  await chmod(installed, 0o755);
  return installed;
}

/**
 * Copies a packaged helper into each directory at install time. Best effort: a session that
 * still cannot find its helper says so then, with a clearer error than an installer could.
 */
export async function copyHelperInto(packaged: string, directories: string[]): Promise<void> {
  if (!existsSync(packaged)) return;
  const name = basename(packaged);
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await copyFile(packaged, join(directory, name));
      await chmod(join(directory, name), 0o755);
    }
  } catch {
    // Best effort, as above.
  }
}
