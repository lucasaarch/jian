import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDevVersion } from '@jian/remote-core';
import { materializeComputerHelperSources } from '@jian/remote-core/computer';
import { configDir, installedScript } from './paths.ts';
/**
 * Reject garbage / HTML / truncated downloads before replacing ~/.config/jian-remote/jian-remote.mjs.
 * Credentials and config.json are never touched by the updater.
 */
export function validateWorkerScriptBytes(
  bytes: Buffer | string,
): { ok: true; version: string } | { ok: false; message: string } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length || buffer.length > 1_000_000) {
    return { ok: false, message: 'Invalid worker update size.' };
  }
  const source = buffer.toString('utf8');
  if (!source.includes('Jian Remote') || !/export const PACKAGE_VERSION = '[^']+'/.test(source)) {
    return { ok: false, message: 'Worker update did not look like a Jian Remote script.' };
  }
  if (!source.includes('updateIfNeeded') || !source.includes('async function run(')) {
    return { ok: false, message: 'Worker update was missing required entrypoints.' };
  }
  return { ok: true, version: readEmbeddedVersion(source) };
}

export function readEmbeddedVersion(scriptSource: string): string {
  const match = /export const PACKAGE_VERSION = '([^']+)'/.exec(scriptSource);
  return match?.[1] ?? 'unknown';
}

/** Pull a specific npm release’s worker script into a temp path (for update when self is wrong). */
export function fetchNpmWorkerScript(version: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'jian-remote-'));
  try {
    const packed = spawnSync(
      'npm',
      ['pack', `@jian-ai/remote-control@${version}`, '--pack-destination', dir],
      { encoding: 'utf8', windowsHide: true },
    );
    if (packed.status !== 0) {
      throw new Error(
        packed.stderr?.trim() ||
          `Could not download @jian-ai/remote-control@${version} from npm. Check the version and network.`,
      );
    }
    const tarball = packed.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarball)
      throw new Error(`npm pack produced no tarball for @jian-ai/remote-control@${version}`);
    const tarballPath = join(dir, tarball);
    const extracted = spawnSync('tar', ['-xzf', tarballPath, '-C', dir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (extracted.status !== 0) {
      throw new Error(extracted.stderr?.trim() || 'Could not extract the remote-control package');
    }
    // Releases before the bundle shipped the script in bin/.
    const bundled = join(dir, 'package', 'dist', 'jian-remote.mjs');
    return readFileSync(
      existsSync(bundled) ? bundled : join(dir, 'package', 'bin', 'jian-remote.mjs'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy this package's Computer Use helpers beside the installed worker, where it looks for
 * them. Never touches jian-remote.mjs: an update must not swap a gateway-stamped script for
 * an older npm copy.
 */
export async function materializeHelpers(): Promise<void> {
  try {
    await materializeComputerHelperSources(configDir);
  } catch {
    // Install still succeeds; the Computer Use probe says so if a helper is missing.
  }
}

/** Copy a worker script into ~/.config, so an npm upgrade never moves the path the service runs. */
export async function materializeWorkerScript(sourceBytes?: Buffer): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (sourceBytes) {
    const temp = `${installedScript}.${process.pid}.tmp`;
    await writeFile(temp, sourceBytes, { mode: 0o700 });
    await rename(temp, installedScript);
  } else {
    const source = fileURLToPath(import.meta.url);
    if (source !== installedScript) await copyFile(source, installedScript);
  }
  if (process.platform !== 'win32') await chmod(installedScript, 0o700);
  await materializeHelpers();
  return installedScript;
}

/**
 * True when this process’s PACKAGE_VERSION no longer matches the installed script on disk.
 * A surviving poller after another worker already applied an update must exit so KeepAlive
 * loads the new file — ETag 304 alone is not enough (disk matches gateway, memory is stale).
 */
export function isStaleInstalledWorker(
  processVersion: string,
  installedSource: string | undefined,
): boolean {
  if (isDevVersion(processVersion)) return false;
  if (typeof installedSource !== 'string' || !installedSource) return false;
  const diskVersion = readEmbeddedVersion(installedSource);
  if (!diskVersion || diskVersion === 'unknown' || isDevVersion(diskVersion)) return false;
  return diskVersion !== processVersion;
}
