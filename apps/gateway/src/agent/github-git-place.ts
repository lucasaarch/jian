import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GatewayError } from '../core/errors.js';
import type { Remote } from '../remote/service.js';
import { withGitConfig } from './github-git-command.js';
import { commandEnvironment } from './shell.js';
import { confine, confined, workspaceOf } from './workspace.js';

/** Long enough for a clone of an ordinary repository; the worker channel allows no more. */
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;

type GitOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Where a conversation's git runs: the gateway's workspace, or the machine it targets. */
export type GitPlace = {
  /** In words, for what the agent reads. */
  name: string;
  /**
   * The checkout path as git there should see it. `clone` also makes its parent; a path left
   * out is `fallback`.
   */
  checkout(path: string | undefined, fallback: string, clone: boolean): Promise<string>;
  /** Runs git with `config` added for this one command (see `credentialConfig`). */
  git(
    args: string[],
    config?: ReadonlyArray<[string, string]>,
    signal?: AbortSignal,
  ): Promise<GitOutcome>;
};

const clip = (text: string) =>
  text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n… ${text.length - MAX_OUTPUT} more characters`
    : text;

/**
 * The gateway's workspace, under the shell tool's rules: confined to the profile's directory,
 * without the gateway's environment, with the installation's SSH keys for everything else.
 */
export function localPlace(
  profileId: string,
  gitAccess: { readOnly: string[]; writable: string[]; sshCommand?: string },
): GitPlace {
  return {
    name: "this gateway's workspace",
    async checkout(path, fallback, clone) {
      const home = await workspaceOf(profileId);
      const target = await confine(profileId, resolve(home, path ?? fallback), 'write');

      if (clone) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      return target;
    },
    async git(args, config = [], signal) {
      const home = await workspaceOf(profileId);
      const command = await confined(home, 'git', args, gitAccess);
      const env = withGitConfig(
        commandEnvironment(home, process.env, gitAccess.sshCommand),
        config,
      );

      return new Promise((done) => {
        execFile(
          command.file,
          command.args,
          {
            cwd: home,
            env,
            timeout: TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT * 4,
            encoding: 'utf8',
            ...(signal ? { signal } : {}),
          },
          (error, stdout, stderr) => {
            const failure = error as { code?: unknown; killed?: boolean } | null;
            done({
              exitCode: typeof failure?.code === 'number' ? failure.code : failure ? null : 0,
              stdout: clip(stdout),
              stderr: clip(stderr),
              timedOut: Boolean(failure?.killed),
            });
          },
        );
      });
    },
  };
}

const posix = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const powershell = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The machine a conversation targets, through a worker shell task. The credential goes as the
 * task's secret environment, which the worker neither logs nor stores and the gateway keeps
 * encrypted only until the worker claims it: never in the command, which both of them record.
 */
export function remotePlace(
  profileId: string,
  machineId: string,
  remote: Pick<Remote, 'list' | 'execute'>,
): GitPlace {
  const machine = async () => {
    const found = (await remote.list()).find((item) => item.id === machineId);
    if (!found) throw new GatewayError(404, 'The machine this conversation targets was removed.');
    if (!found.online) {
      throw new GatewayError(
        503,
        `${found.name} is offline. Ask the owner to start Jian Remote there, then try again.`,
      );
    }
    return found;
  };

  return {
    name: 'the machine this conversation targets',
    async checkout(path, fallback) {
      // Relative paths start in the worker's home; the machine's own filesystem decides the rest.
      return path ?? fallback;
    },
    async git(args, config, signal) {
      const windows = (await machine()).platform.startsWith('win32');
      const command = windows
        ? `& git ${args.map(powershell).join(' ')}; exit $LASTEXITCODE`
        : `git ${args.map(posix).join(' ')}`;
      const env = config?.length
        ? (withGitConfig({}, config) as Record<string, string>)
        : undefined;

      return remote.execute(profileId, machineId, { command, timeoutMs: TIMEOUT_MS }, signal, env);
    },
  };
}
