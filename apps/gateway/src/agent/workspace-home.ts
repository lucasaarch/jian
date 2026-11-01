import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where agents work, which depends on the host and never on the agent: every agent of an
 * installation shares one filesystem. Memories, conversations, skills and the browser's logins
 * stay per agent; files do not.
 *
 * - A server gateway gives them one directory, the workspaces root, as `HOME`.
 * - The desktop app's local gateway runs on the owner's computer, as the owner, so `HOME` is the
 *   owner's real home. Nothing here may write to it at startup or on a run's way in: a folder
 *   appears there only because a clone asked for it.
 *
 * A gateway knows which it is by `JIAN_LOCAL_DIR`, which only `local.ts` reads and the desktop app
 * sets. It stays out of a command's environment, so nothing an agent starts inherits the mode.
 */

/** What only a desktop app's local gateway has. */
export type OwnerComputer = {
  /** The gateway's own folder in the app's data: its database, managed keys, older workspaces. */
  gateway: string;
  /** All of the app's data, the database and credentials among it: what the file tools refuse. */
  appData: string;
};

export function ownerComputer(): OwnerComputer | undefined {
  const gateway = process.env.JIAN_LOCAL_DIR;
  if (!gateway) return undefined;

  // `local.ts` will not start without JIAN_APP_DATA; the fallback only ever refuses less broadly.
  return { gateway: resolve(gateway), appData: resolve(process.env.JIAN_APP_DATA ?? gateway) };
}

export const onOwnerComputer = () => ownerComputer() !== undefined;

/**
 * On a server, the shared directory; a volume should be mounted over it (or over the home above).
 * On a desktop, the folder that held the per-profile workspaces before files were shared. Either
 * way each `<root>/<profileId>` of an earlier version stays where it is, as a subfolder, because
 * paths recorded in old conversations point into it.
 */
export function workspacesRoot(): string {
  const local = ownerComputer();

  return local
    ? join(local.gateway, 'workspaces')
    : resolve(process.env.JIAN_WORKSPACES || join(homedir(), 'workspaces'));
}

/** Names a per-profile directory an earlier version made under the root. */
export const EARLIER_PROFILE_FOLDER = /^[0-9a-f-]{36}$/;

/** The agents' `HOME`, a real path. On a server it is created on first use; a home already is. */
export async function workspaceHome(): Promise<string> {
  if (onOwnerComputer()) return realpath(homedir());

  const root = workspacesRoot();

  await mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 });

  return realpath(root);
}

/**
 * `/tmp` on Linux is shared with every user of the computer, so a fixed name there could already be
 * someone else's: the user id keeps the name apart, and the owner is checked rather than assumed.
 */
async function ownerTemp(): Promise<string> {
  const uid = process.getuid?.();
  const path = join(tmpdir(), uid === undefined ? 'jian' : `jian-${uid}`);

  await mkdir(path, { recursive: true, mode: 0o700 });

  const info = await lstat(path);

  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${path} is not a folder of this user's, so it cannot hold temporary files`);
  }

  return realpath(path);
}

/** A command's `TMPDIR`, made here each time because a system may clear its temporary folder. */
export async function workspaceTemp(): Promise<string> {
  return onOwnerComputer() ? ownerTemp() : join(await workspaceHome(), 'tmp');
}

/**
 * Where a clone with no chosen folder goes: never loose in the owner's home. Not created here,
 * since naming it must not make it appear; the clone makes the parents it needs.
 */
export async function cloneRoot(): Promise<string> {
  const home = await workspaceHome();

  return onOwnerComputer() ? join(home, 'Jian') : home;
}

/**
 * A conversation's checkout, where an earlier version may already have made it under its agent's
 * folder. That one wins: telling the agent a new path would make it clone again beside a checkout
 * that may hold work not yet pushed. This is the one reason a profile id still names a place.
 */
async function conversationPlace(profileId: string, parts: string[]): Promise<string> {
  const earlier = await realpath(join(workspacesRoot(), profileId, ...parts)).catch(
    () => undefined,
  );

  return earlier ?? join(await cloneRoot(), ...parts);
}

/** A project conversation's own checkout, which its instructions name and its clone defaults to. */
export const projectCheckout = (profileId: string, projectId: string, sessionId: string) =>
  conversationPlace(profileId, ['projects', projectId, 'sessions', sessionId]);

/** The folder a conversation on several repositories keeps its checkouts of them in. */
export const sessionCheckouts = (profileId: string, sessionId: string) =>
  conversationPlace(profileId, ['projects', 'sessions', sessionId]);
