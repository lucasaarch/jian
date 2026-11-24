import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { secretEnvNameSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { secretForms } from '../secrets/forms.js';
import type { LentValue, OfferedSecret } from '../secrets/service.js';
import { clip, MAX_OUTPUT } from './clip.js';
import { fileTools } from './files.js';
import { type ProcessAccess, processTools, startBackground } from './process-tools.js';
import { redactText } from './results.js';
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

/** Said only where the run can start one: elsewhere the agent would look for what it lacks. */
const BACKGROUND =
  ' `background: true` starts it in the background instead and answers at once with its processId and what it printed in its first seconds: for a server, a watcher or a job that outlives this call, with no time limit. Read it with process_output, end it with stop_process. It ends when the gateway restarts.';

/**
 * The owner's Secrets this run may hand a command: what the agent is told of them, and how their
 * values are read for one command. `reveal` takes variable names, and each one lends the whole
 * Secret it belongs to; it refuses any this agent may not use. `offered` may be empty when the
 * agent can save a Secret during the run.
 */
export type SecretAccess = {
  offered: readonly OfferedSecret[];
  reveal: (envNames: readonly string[]) => Promise<Record<string, LentValue>>;
  /** Refuses as `reveal` does, reading no value. */
  check: (envNames: readonly string[]) => Promise<void>;
};

/** What the agent reads of the Secrets it may use: names and what each is for, never a value. */
function secretsDescription(offered: readonly OfferedSecret[]): string {
  const listed = offered
    .map(({ title, description, fields }) => {
      const names = fields.map(({ envName }) => envName).join(', ');
      return `${title}${description ? ` (${description})` : ''}: ${names}`;
    })
    .join('; ');

  return ` The owner keeps Secrets for your commands. Name a variable of the one a command needs in \`secrets\`, and it gets every variable of that Secret, for that command alone: write "$NAME" in the command, never a value. You never see a sensitive value: wherever one would be printed it comes back as [REDACTED]. Send a Secret only to the service it is for, and never write it to a file. Where this conversation asks before acting, the owner approves each such command, seeing which variables it gets. Yours: ${listed || 'none yet'}.`;
}

/**
 * Every variable a call would hand a command: naming one lends its whole Secret, so the card
 * the owner approves, and what Auto's guardrail is told, list them all, not only the ones the
 * agent wrote. Read from what the run was offered: a Secret saved since shows as the names given.
 */
export function lentNames(offered: readonly OfferedSecret[], asked: readonly string[]): string[] {
  const lent = new Set<string>();
  for (const name of asked) {
    const whole = offered.find(({ fields }) => fields.some(({ envName }) => envName === name));
    for (const { envName } of whole?.fields ?? [{ envName: name }]) lent.add(envName);
  }
  return [...lent];
}

const refused = (stderr: string) => ({ exitCode: 126, stdout: '', stderr });

const refusal = (error: unknown) => refused(error instanceof Error ? error.message : 'Not run.');

export function shellTools(
  gitAccess: { readOnly: string[]; writable: string[]; sshCommand?: string } = {
    readOnly: [],
    writable: [],
  },
  secrets?: SecretAccess,
  /** Where the run may start commands in the background: only where this gateway can keep them. */
  processes?: ProcessAccess,
): ToolSet {
  const plain = z.object({
    command: z.string().trim().min(1).max(4000),
    cwd: absolute.optional(),
    timeoutMs: z.number().int().min(1000).max(TIMEOUT_MS).default(30_000),
  });
  const base = processes ? plain.extend({ background: z.boolean().optional() }) : plain;
  // Offered only to a run with Secrets to use. Any well-formed name passes: a Secret saved after
  // the run began is lendable at once, and `reveal` refuses what this agent may not use.
  const inputSchema = secrets
    ? base.extend({ secrets: z.array(secretEnvNameSchema).max(40).optional() })
    : base;

  return {
    run_command: Object.assign(
      tool({
        description:
          (onOwnerComputer() ? RUN_COMMAND.owner : RUN_COMMAND.server) +
          (processes ? BACKGROUND : '') +
          (secrets ? secretsDescription(secrets.offered) : ''),
        inputSchema,
        execute: async (
          input: z.infer<typeof base> & { secrets?: string[]; background?: boolean },
        ) => {
          const { command, cwd, timeoutMs } = input;
          if (/(?:^|[;&|\s])ssh-keygen(?:\s|$)/.test(command)) {
            return refused('SSH keys must be managed with the SSH key tools, not ssh-keygen.');
          }
          // Checked again here, at the moment it runs: an approved call is run from what was
          // stored, not through the schema, and a Secret may have been taken away since.
          let lent: Record<string, LentValue> = {};
          if (input.secrets?.length) {
            if (!secrets) return refused('Not run: this run has no Secrets to use.');
            try {
              lent = await secrets.reveal(input.secrets);
            } catch (error) {
              return refusal(error);
            }
          }
          // Masked here, before the result leaves the tool, in every form a command could print a
          // value in; the run masks every sensitive value of the installation again in what it
          // records. Only sensitive fields, as they are now: a username lent with them prints as
          // it is, and a field the owner made sensitive since the run began is masked.
          const masks = new Set(
            Object.values(lent)
              .filter((field) => field.sensitive)
              .flatMap((field) => secretForms(field.value)),
          );
          const mask = (text: string) => (masks.size ? redactText(text, masks) : text);
          const home = await workspaceHome();
          const temp = await workspaceTemp();
          const directory = cwd ? await confine(cwd, 'read') : (reachableFolders()[0] ?? home);
          const shell = await confined(home, '/bin/sh', ['-c', command], gitAccess);
          // The secrets reach the command as its environment alone: never its text, which
          // the owner's timeline and the approval card show.
          const env = {
            ...commandEnvironment({ home, temp }, process.env, gitAccess.sshCommand),
            ...Object.fromEntries(Object.entries(lent).map(([name, field]) => [name, field.value])),
          };

          if (input.background) {
            // Checked here too: an approved call is run from what was stored, not the schema.
            if (!processes) return refused('Not run: this run cannot start background commands.');

            try {
              // The same line as a command that waits, then kept: its output is masked as it
              // arrives, before anything of it is stored or shown.
              return await startBackground(processes, {
                command,
                cwd: directory,
                file: shell.file,
                args: shell.args,
                env,
                secrets: masks,
                spawned: surrenderFirst,
              });
            } catch (error) {
              return refusal(error);
            }
          }

          return new Promise((resolvePromise) => {
            const child = execFile(
              shell.file,
              shell.args,
              {
                cwd: directory,
                env,
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
                  // Masked whole, then cut: a cut through a value would leave part of it.
                  stdout: clip(mask(stdout), MAX_OUTPUT),
                  stderr: clip(mask(stderr), MAX_OUTPUT),
                });
              },
            );
            surrenderFirst(child.pid);
          });
        },
      }),
      {
        // A Secret this agent may not use would be refused only once the owner approved the
        // command: it is answered as it would be then, before anyone is asked.
        refusedBeforeAsking: async (input: unknown) => {
          const asked = (input as { secrets?: unknown } | null)?.secrets;
          if (!Array.isArray(asked) || !asked.length) return undefined;
          if (!secrets) return refused('Not run: this run has no Secrets to use.');
          return secrets.check(asked.map(String)).then(() => undefined, refusal);
        },
        // The card names every variable the command gets, which the call does not: naming one
        // lends its whole Secret.
        cardInput: async (input: unknown) => {
          const asked = (input as { secrets?: unknown } | null)?.secrets;
          if (!secrets || !Array.isArray(asked) || !asked.length) return input;
          return {
            ...(input as object),
            secrets: lentNames(secrets.offered, asked.map(String)),
          };
        },
      },
    ),

    ...fileTools(),
    ...(processes ? processTools(processes) : {}),
  };
}
