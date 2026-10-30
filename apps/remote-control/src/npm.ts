import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { readEmbeddedVersion } from './worker-script.ts';

export const PACKAGE = '@jian-ai/remote-control';

/**
 * How this worker was installed: with npm, globally. Only such a worker updates itself, by
 * installing another release the same way. The path is kept because the OS service runs with
 * a thin PATH that may not reach npm (nvm, fnm, a custom prefix).
 */
export type Installer = { kind: 'npm'; npm: string };

export type Run = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

/** Runs a command to its end, its output as text. */
export const runSync: Run = (command, args, options) =>
  spawnSync(command, args, { ...options, encoding: 'utf8' }) as SpawnSyncReturns<string>;

/** The first npm on `env`'s PATH. */
function findNpm(env: NodeJS.ProcessEnv): string | undefined {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'];
  const path = env.PATH ?? env.Path ?? '';
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      if (existsSync(join(directory, name))) return join(directory, name);
    }
  }
  return undefined;
}

/**
 * npm with its own directory first on PATH, so its `#!/usr/bin/env node` finds the Node it came
 * with. A `.cmd` runs only through a shell on Windows; what is passed to it is a checked
 * package name and release, never free text.
 */
function npmOptions(installer: Installer, options: SpawnSyncOptions): SpawnSyncOptions {
  const PATH = `${dirname(installer.npm)}${delimiter}${process.env.PATH ?? ''}`;
  return {
    ...options,
    env: { ...process.env, PATH },
    shell: process.platform === 'win32',
    windowsHide: true,
  };
}

/** Where npm puts this package's worker, globally. */
function globalCli(installer: Installer, spawn: Run): string | undefined {
  const root = spawn(installer.npm, ['root', '-g'], npmOptions(installer, {})).stdout?.trim();
  return root ? join(root, ...PACKAGE.split('/'), 'dist', 'jian-remote.mjs') : undefined;
}

/**
 * This machine's npm install of Jian Remote, if it has one: npm on `env`'s PATH, and the
 * package among its global ones. A worker run some other way (npx, a copy) has none.
 */
export function npmInstaller(env = process.env, spawn: Run = runSync): Installer | undefined {
  const npm = findNpm(env);
  if (!npm) return undefined;
  const installer: Installer = { kind: 'npm', npm };
  const cli = globalCli(installer, spawn);
  return cli && existsSync(cli) ? installer : undefined;
}

/** The tail of what a failed command said, short enough for a result or an error line. */
const tail = (text: string | undefined) => (text ?? '').trim().slice(-2000);

/**
 * Installs `target` (a release or `latest`) globally with npm and says where its worker landed
 * and which release it is. `stdio: 'inherit'` shows npm's own output, for a person at a terminal.
 */
export function installRelease(
  installer: Installer,
  target: string,
  {
    spawn = runSync,
    stdio = 'pipe',
    timeoutMs = 5 * 60_000,
  }: { spawn?: Run; stdio?: 'pipe' | 'inherit'; timeoutMs?: number } = {},
): { ok: true; cli: string; version: string } | { ok: false; error: string } {
  if (!/^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(target)) {
    return { ok: false, error: `Not a release: ${target}` };
  }
  const installed = spawn(
    installer.npm,
    ['install', '-g', `${PACKAGE}@${target}`],
    npmOptions(installer, { stdio, timeout: timeoutMs }),
  );
  if (installed.status !== 0) {
    const reason = installed.error?.message ?? tail(installed.stderr);
    return { ok: false, error: `npm could not install ${PACKAGE}@${target}. ${reason}`.trim() };
  }
  const cli = globalCli(installer, spawn);
  if (!cli || !existsSync(cli)) {
    return { ok: false, error: `npm installed ${PACKAGE}@${target}, but its worker is missing.` };
  }
  return { ok: true, cli, version: readEmbeddedVersion(readFileSync(cli, 'utf8')) };
}
