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
    source: join(support, `${HELPER_NAME}.swift`),
    binary: join(support, HELPER_NAME),
    stamp: join(support, `${HELPER_NAME}.sha256`),
  };
}

/** The helper as the package ships it: always the Swift source, a universal binary when published. */
export function packageHelperPaths(packageRoot = helpersRoot()): { swift: string; binary: string } {
  return {
    swift: join(packageRoot, 'macos', `${HELPER_NAME}.swift`),
    binary: join(packageRoot, 'macos', HELPER_NAME),
  };
}

/** Drops the download quarantine, without which a helper from npm cannot run under launchd. */
function clearQuarantine(path: string): void {
  spawnSync('xattr', ['-d', 'com.apple.quarantine', path], { encoding: 'utf8' });
}

/**
 * The helper binary, ready to run: the packaged one when there is one, else compiled from the
 * Swift source with swiftc. The stamp covers the bytes it came from — `bin:` or `src:` — so an
 * update with a different helper replaces the stale one.
 */
export async function ensureHelperBinary(): Promise<string> {
  const paths = helperPaths();
  const packaged = packageHelperPaths();
  await mkdir(paths.support, { recursive: true, mode: 0o755 });
  const previous = await readStamp(paths.stamp);

  if (existsSync(packaged.binary)) {
    const hash = `bin:${stampForBytes(await readFile(packaged.binary))}`;
    if (previous !== hash || !existsSync(paths.binary)) {
      await copyFile(packaged.binary, paths.binary);
      await chmod(paths.binary, 0o755);
      clearQuarantine(paths.binary);
      await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
    }
    // The source beside it only documents what runs; losing it changes nothing.
    await copyFile(packaged.swift, paths.source).catch(() => {});
    return paths.binary;
  }

  const source = await readSwiftSource(packaged.swift, paths.source);
  const hash = `src:${stampForBytes(Buffer.from(source, 'utf8'))}`;
  await writeFile(paths.source, source, { mode: 0o644 });
  if (previous !== hash || !existsSync(paths.binary)) {
    const compiled = spawnSync(
      'swiftc',
      ['-O', '-framework', 'AppKit', '-framework', 'Carbon', '-o', paths.binary, paths.source],
      { encoding: 'utf8' },
    );
    if (compiled.status !== 0) {
      throw new Error(
        (compiled.stderr || compiled.stdout || '').trim() ||
          'Could not build the Jian computer-use helper. Published packages ship a prebuilt helper; for source builds install Xcode Command Line Tools, or reinstall @jian-ai/remote-control.',
      );
    }
    await chmod(paths.binary, 0o755);
    clearQuarantine(paths.binary);
    await writeFile(paths.stamp, `${hash}\n`, { mode: 0o644 });
  }
  return paths.binary;
}

/** The packaged source, or the copy an earlier install left when the package lost it. */
async function readSwiftSource(packaged: string, installed: string): Promise<string> {
  try {
    return await readFile(packaged, 'utf8');
  } catch {
    try {
      return await readFile(installed, 'utf8');
    } catch {
      throw new Error(MISSING_HELPER);
    }
  }
}

/** Copies the Swift source and any prebuilt helper next to the installed worker. */
export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const packaged = packageHelperPaths();
  if (!existsSync(packaged.swift) && !existsSync(packaged.binary)) return;
  const { support, stamp } = helperPaths();
  const directories = [support, join(configDir, 'macos')];
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      if (existsSync(packaged.swift)) {
        await copyFile(packaged.swift, join(directory, `${HELPER_NAME}.swift`));
      }
      if (existsSync(packaged.binary)) {
        const binary = join(directory, HELPER_NAME);
        await copyFile(packaged.binary, binary);
        await chmod(binary, 0o755);
        clearQuarantine(binary);
      }
    }
    if (existsSync(packaged.binary)) {
      const hash = `bin:${stampForBytes(await readFile(packaged.binary))}`;
      await writeFile(stamp, `${hash}\n`, { mode: 0o644 });
    }
  } catch {
    // Best effort at install: a session that still cannot find its helper says so then.
  }
}
