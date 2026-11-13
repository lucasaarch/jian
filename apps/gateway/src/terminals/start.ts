import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import type { Session } from '@jian/contracts';
import { commandEnvironment } from '../agent/shell.js';
import { confined } from '../agent/workspace.js';
import {
  onOwnerComputer,
  projectCheckout,
  sessionCheckouts,
  workspaceHome,
  workspaceTemp,
} from '../agent/workspace-home.js';

/**
 * Where the owner's terminal starts and what it runs. It stands behind the same line as the
 * agent's `run_command` (see agent/shell.ts), never a weaker one, since whoever reaches the panel
 * reaches this:
 *
 * - On a server the shell runs under the Landlock helper, confined to the directory the agents
 *   share, with the allow-listed environment: the gateway's database address, keyring and token
 *   stay out of it. It starts inside that directory or not at all.
 * - On the owner's computer it is the owner's own shell in the owner's home, unconfined, as their
 *   commands already are there; the allow-list still keeps the gateway's secrets out.
 */
export type TerminalStart = {
  /** The folder the shell starts in, a real path. */
  cwd: string;
  /** The shell itself, which is what the terminal says it runs. */
  shell: string;
  /** What is executed: the shell, or the confinement helper in front of it. */
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type TerminalPlaces = {
  sessions: { session(profileId: string, sessionId: string): Promise<Session> };
  worktrees: {
    recordedOnGateway(profileId: string, sessionId: string): Promise<{ path: string }[]>;
  };
};

const windows = process.platform === 'win32';

const first = (candidates: (string | undefined)[]) =>
  candidates.find((path): path is string => Boolean(path && isAbsolute(path) && existsSync(path)));

function shellFor(): { shell: string; args: string[] } {
  if (windows) return { shell: process.env.COMSPEC || 'powershell.exe', args: [] };
  if (!onOwnerComputer()) return { shell: first(['/bin/bash']) ?? '/bin/sh', args: [] };

  return {
    shell: first([process.env.SHELL, '/bin/zsh', '/bin/bash']) ?? '/bin/sh',
    // An app started from the Dock has no login environment; macOS terminals start a login shell
    // for that reason, and it is where the owner's PATH is set.
    args: process.platform === 'darwin' ? ['-l'] : [],
  };
}

/** What a Windows shell cannot start without, and the folders its programs look for. */
const WINDOWS_PASSED = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'TEMP',
  'TMP',
  'PSMODULEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
]);

/**
 * `commandEnvironment` is written for POSIX: it reads `PATH` split on colons. Windows names its
 * variables in any case and separates with semicolons, so it gets its own allow-list, still with
 * nothing of the gateway's in it.
 */
function windowsEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) => value !== undefined && WINDOWS_PASSED.has(name.toUpperCase()),
    ),
  );
}

async function environment(home: string, shell: string): Promise<NodeJS.ProcessEnv> {
  const screen = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (windows) return { ...windowsEnvironment(process.env), ...screen };

  const env = commandEnvironment({ home, temp: await workspaceTemp() });
  // macOS gives an app no locale, and a shell without one draws accented letters as escapes.
  const locale =
    process.platform === 'darwin' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE
      ? { LANG: 'en_US.UTF-8' }
      : {};

  return { ...env, ...locale, SHELL: shell, ...screen };
}

/** The real path of a folder that exists, and on a server only inside the shared directory. */
async function usable(path: string | undefined, home: string): Promise<string | undefined> {
  if (!path) return undefined;

  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return undefined;
    if (onOwnerComputer() || real === home || real.startsWith(`${home}${sep}`)) return real;
  } catch {
    // Not cloned yet, or removed: the next place is tried.
  }

  return undefined;
}

/**
 * The conversation's checkout on this machine, in the order its agent's commands would find it:
 * its worktree, its first folder, its project's checkout. A conversation that works on a remote
 * machine has none of these here, and its terminal still opens on the gateway, in the home.
 */
async function folderFor(
  places: TerminalPlaces,
  profileId: string,
  sessionId: string | undefined,
  home: string,
): Promise<string> {
  if (!sessionId) return home;

  // Belonging to the profile is a condition of the read: another profile's conversation is a 404.
  const session = await places.sessions.session(profileId, sessionId);
  if (session.remoteMachineId) return home;

  const [worktree] = await places.worktrees.recordedOnGateway(profileId, sessionId);
  const checkout = session.projectIds?.length
    ? await sessionCheckouts(profileId, sessionId)
    : session.projectId
      ? await projectCheckout(profileId, session.projectId, sessionId)
      : undefined;

  for (const candidate of [worktree?.path, session.folders?.[0], checkout]) {
    const folder = await usable(candidate, home);
    if (folder) return folder;
  }

  return home;
}

export async function terminalStart(
  places: TerminalPlaces,
  profileId: string,
  sessionId?: string,
): Promise<TerminalStart> {
  const home = await workspaceHome();
  const cwd = await folderFor(places, profileId, sessionId, home);
  const { shell, args } = shellFor();
  const program = await confined(home, shell, args);

  return { cwd, shell, ...program, env: await environment(home, shell) };
}
