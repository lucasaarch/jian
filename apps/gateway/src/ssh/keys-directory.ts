import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EARLIER_PROFILE_FOLDER,
  ownerComputer,
  workspaceHome,
  workspacesRoot,
} from '../agent/workspace-home.js';

/** Where a home keeps the installation's keys, one directory per key id. */
export const directory = (home: string) => join(home, '.ssh', 'jian');

/**
 * Where the installation's keys are written for git. On a desktop `HOME` is the owner's own and its
 * `.ssh` is never written to, so they live in Jian's data, beside their own known_hosts.
 */
export async function keysDirectory(): Promise<string> {
  const local = ownerComputer();

  return local ? join(local.gateway, 'ssh') : directory(await workspaceHome());
}

/**
 * The folders of keys in the per-profile directories of earlier versions, on either host. Only a
 * child named by an id: the root is `HOME` on a server, full of whatever agents made there.
 */
export async function earlierKeyDirectories(): Promise<string[]> {
  const root = workspacesRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && EARLIER_PROFILE_FOLDER.test(entry.name))
    .map((entry) => directory(join(root, entry.name)));
}
