import { chmod, copyFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { materializeComputerHelperSources } from '@jian/remote-core/computer';
import { configDir, installedScript } from './paths.ts';

/** The release a worker script was stamped with, from the line its build keeps. */
export function readEmbeddedVersion(scriptSource: string): string {
  const match = /export const PACKAGE_VERSION = '([^']+)'/.exec(scriptSource);
  return match?.[1] ?? 'unknown';
}

/** Copy this package's Computer Use helpers beside the installed worker, where it looks. */
async function materializeHelpers(): Promise<void> {
  try {
    await materializeComputerHelperSources(configDir);
  } catch {
    // Install still succeeds; the Computer Use probe says so if a helper is missing.
  }
}

/**
 * Copy this worker into ~/.config, so an npm upgrade never moves the path the service runs.
 * Written beside and renamed over, so a running service never reads half a file.
 */
export async function materializeWorkerScript(): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const source = fileURLToPath(import.meta.url);
  if (source !== installedScript) {
    const temp = `${installedScript}.${process.pid}.tmp`;
    await copyFile(source, temp);
    await rename(temp, installedScript);
  }
  if (process.platform !== 'win32') await chmod(installedScript, 0o700);
  await materializeHelpers();
  return installedScript;
}
