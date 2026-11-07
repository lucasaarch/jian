import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { fileTools } from './files.js';
import { confine, confined, reachableFolders } from './workspace.js';
import { onOwnerComputer, workspaceHome, workspaceTemp } from './workspace-home.js';

/**
 * Running commands on the machine the gateway runs on, with the file tools beside them.
 *
 * Always offered: the former `allowShell` profile switch is deprecated. Anyone who can make this
 * agent act, including an approved contact on a chat channel, can make it run a command. The
 * runtime puts a guard in front of each action that changes the machine (see guard.ts); it is a
 * second opinion, not a boundary.
 *
 * On a server, the boundary is the directory every agent shares (see workspace.ts): a command
 * starts there, with it as `HOME`, confined by Landlock to it and to the system's tools. It also
 * starts without the gateway's environment, which holds the database DSN, the keyring and the host
 * token: a test run from a project would otherwise pick them up — a database test aimed at the
 * gateway's own PostgreSQL. The two cover each other: Landlock keeps the gateway's files and
 * /proc closed, and the allow-list keeps its secrets out of the command, even where Landlock is
 * missing.
 *
 * On a desktop there is no such boundary: a command runs as the owner, with the owner's home, and
 * only the allow-list stands between it and the gateway's secrets. It can read Jian's data on disk.
 */

/** Long enough for a build, short enough that a run does not die waiting on a hung command. */
const TIMEOUT_MS = 120_000;
/**
 * Characters kept of each stream, its first and last halves; a command that prints a megabyte
 * would cost the run its context. The result's own budget then cuts what is kept further.
 */
const MAX_OUTPUT = 60_000;
/** What a command may print before it is stopped, in bytes: well past MAX_OUTPUT. */
const READ_OUTPUT = 8 * 1024 * 1024;

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), 'Use an absolute path');

/** What a shell needs to find its tools and its locale — no credential among them. */
const PASSED = new Set([
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'HOSTNAME',
  // The flag the machine-tools skill checks to know it is in the Jian image.
  'JIAN_TOOLBOX',
]);

/**
 * A desktop's owner reaches their Git hosts through their own SSH agent. On a server there is no
 * owner's agent to find, and it is a door out of the sandbox if the gateway happens to have one.
 */
const PASSED_ON_OWNER_COMPUTER = new Set(['SSH_AUTH_SOCK']);

/**
 * The environment a command starts with: an allow-list, so a variable added to the gateway later
 * stays out by default. `NODE_ENV` is left out on purpose — the gateway's `production` would make
 * a project's install skip its dev dependencies.
 *
 * On a server the per-user install paths move into the shared directory. On a desktop they stay
 * the owner's: an `NPM_CONFIG_PREFIX` or a `GOPATH` of Jian's would silently change where the
 * owner's own tools install, and a PATH with their bin folders removed would hide those tools.
 */
export function commandEnvironment(
  { home, temp }: { home: string; temp: string },
  source: NodeJS.ProcessEnv = process.env,
  gitSshCommand?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const owner = onOwnerComputer();

  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (PASSED.has(name) || name.startsWith('LC_') || (owner && PASSED_ON_OWNER_COMPUTER.has(name)))
    ) {
      env[name] = value;
    }
  }

  if (owner) {
    const path = (source.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean);

    return {
      ...env,
      HOME: home,
      TMPDIR: temp,
      ...(gitSshCommand ? { GIT_SSH_COMMAND: gitSshCommand } : {}),
      // After the owner's own order: an app started from the Dock has a short PATH to add to.
      PATH: [...new Set([...path, join(home, '.local', 'bin'), join(home, 'go', 'bin')])].join(':'),
    };
  }

  // The image puts the gateway's own per-user bin folders on PATH; the shared ones replace them.
  const gatewayHome = source.HOME;
  const system = (source.PATH ?? '/usr/local/bin:/usr/bin:/bin')
    .split(':')
    .filter((entry) => entry && !(gatewayHome && entry.startsWith(gatewayHome)));

  return {
    ...env,
    HOME: home,
    TMPDIR: temp,
    GOPATH: join(home, 'go'),
    NPM_CONFIG_PREFIX: join(home, '.local'),
    ...(gitSshCommand
      ? {
          GIT_SSH_COMMAND: gitSshCommand,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'url.git@bitbucket.org:.insteadOf',
          GIT_CONFIG_VALUE_0: 'https://bitbucket.org/',
        }
      : {}),
    PATH: [join(home, '.local', 'bin'), join(home, 'go', 'bin'), ...system].join(':'),
  };
}

/**
 * Its first and last halves within `limit`: a build or a test run says what failed at the end,
 * and the start says what ran. What is cut here is gone, not stored, and the marker says so.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n[… ${(text.length - 2 * half).toLocaleString('en')} characters of this output were not kept]\n${text.slice(-half)}`;
}

/**
 * On Linux, a command is the first the kernel kills when memory runs out, and what it starts
 * inherits that: a test suite that fills a container's memory is ended (exit 137) instead of
 * the gateway, with every turn it is running. Raising a process's own score needs no privilege;
 * written as it starts, before the command forks, and harmless where it cannot be written.
 */
function surrenderFirst(pid: number | undefined): void {
  if (process.platform !== 'linux' || !pid) return;
  void writeFile(`/proc/${pid}/oom_score_adj`, '1000').catch(() => {});
}

const RUN_COMMAND = {
  server:
    'Run a command on the machine this gateway runs on and read what it printed. It starts in the directory every agent of this installation shares, which is also $HOME, and can write only there. Other agents work in it too: keep to a folder for your task. Prefer a single command over a shell pipeline you cannot inspect. Anything destructive needs the owner to have asked for it in this conversation.',
  owner:
    "Run a command on the owner's computer, as the owner, and read what it printed. It starts in this chat's first folder, or in their home, which is also $HOME. Nothing confines it, so it can change anything of theirs: touch only what the task needs. Prefer a single command over a shell pipeline you cannot inspect. Anything destructive needs the owner to have asked for it in this conversation.",
};

export function shellTools(
  gitAccess: { readOnly: string[]; writable: string[]; sshCommand?: string } = {
    readOnly: [],
    writable: [],
  },
): ToolSet {
  return {
    run_command: tool({
      description: onOwnerComputer() ? RUN_COMMAND.owner : RUN_COMMAND.server,
      inputSchema: z.object({
        command: z.string().trim().min(1).max(4000),
        cwd: absolute.optional(),
        timeoutMs: z.number().int().min(1000).max(TIMEOUT_MS).default(30_000),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        if (/(?:^|[;&|\s])ssh-keygen(?:\s|$)/.test(command)) {
          return {
            exitCode: 126,
            stdout: '',
            stderr: 'SSH keys must be managed with the SSH key tools, not ssh-keygen.',
          };
        }
        const home = await workspaceHome();
        const temp = await workspaceTemp();
        const directory = cwd ? await confine(cwd, 'read') : (reachableFolders()[0] ?? home);
        const shell = await confined(home, '/bin/sh', ['-c', command], gitAccess);

        return new Promise((resolvePromise) => {
          const child = execFile(
            shell.file,
            shell.args,
            {
              cwd: directory,
              env: commandEnvironment({ home, temp }, process.env, gitAccess.sshCommand),
              timeout: timeoutMs,
              // Read past what is kept, so the end that is kept is the command's real end: a
              // command stopped at this size ends with whatever it printed by then.
              maxBuffer: READ_OUTPUT,
              encoding: 'utf8',
            },
            (error, stdout, stderr) => {
              const status = (error as { code?: unknown } | null)?.code;

              resolvePromise({
                // Zero is success; a string here is a signal, such as a command that timed out.
                exitCode: typeof status === 'number' ? status : status ? String(status) : 0,
                stdout: clip(stdout, MAX_OUTPUT),
                stderr: clip(stderr, MAX_OUTPUT),
              });
            },
          );
          surrenderFirst(child.pid);
        });
      },
    }),

    ...fileTools(),
  };
}
