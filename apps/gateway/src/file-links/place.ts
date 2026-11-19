import { constants, type Stats } from 'node:fs';
import { type FileHandle, open, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { EARLIER_PROFILE_FOLDER } from '../agent/workspace-home.js';

/**
 * Which files a link may serve. Stricter than the file tools, because a link hands a file to
 * anyone who holds it, outside every conversation:
 *
 * - Only under the directory the agents share, by real path: a symlink that leads out, an
 *   absolute path elsewhere or a `..` all resolve outside it and are refused. The system's
 *   directories, which the file tools may read, are not offered.
 * - Nothing under a hidden name (`.ssh`, `.env`, `.git`, `.config`): that is where the gateway's
 *   SSH keys and every tool's credentials live in the shared home.
 * - Nothing in another agent's own place. Files are shared between agents by design, but an
 *   earlier version's `<root>/<profileId>` folder and a project's or conversation's checkout
 *   belong to one agent, and its links are its own business, not another's.
 *
 * Every rule is checked again when the link is read, against the agent that made it.
 */

/** Refused for a reason worth telling the agent; anything else thrown is a failure. */
export class LinkRefused extends Error {}

/** Whether a project or conversation with this id is the agent's own. */
export type OwnsPlace = (
  profileId: string,
  kind: 'project' | 'session',
  id: string,
) => Promise<boolean>;

/** The file's place under the shared directory, as path parts, or refused. */
export function sharedParts(home: string, real: string, asked: string): string[] {
  const inside = relative(home, real);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new LinkRefused(
      `${asked} is outside the directory the agents share (${home}); only a file in it can be linked.`,
    );
  }
  const parts = inside.split(sep);
  if (parts.some((part) => part.startsWith('.'))) {
    throw new LinkRefused(
      `${asked} is in a hidden file or folder, where keys and credentials are kept, so it cannot be linked. Copy the file somewhere visible first if it is meant to be shared.`,
    );
  }
  return parts;
}

/** Refuses a place that belongs to another agent: see the rules above. */
export async function assertOwnPlace(
  profileId: string,
  parts: readonly string[],
  owns: OwnsPlace,
  asked: string,
): Promise<void> {
  const [first, second, third] = parts;
  const refuse = () => {
    throw new LinkRefused(`${asked} belongs to another agent, so this one cannot link it.`);
  };

  if (first && EARLIER_PROFILE_FOLDER.test(first) && first !== profileId) refuse();
  if (first !== 'projects' || !second) return;
  // A conversation on several repositories keeps them in `projects/sessions/<sessionId>`, and a
  // project conversation its checkout in `projects/<projectId>/sessions/<sessionId>`.
  if (second === 'sessions') {
    if (third && EARLIER_PROFILE_FOLDER.test(third) && !(await owns(profileId, 'session', third))) {
      refuse();
    }
    return;
  }
  if (EARLIER_PROFILE_FOLDER.test(second) && !(await owns(profileId, 'project', second))) refuse();
}

/**
 * The real path of what the agent named, or refused when nothing is there. Every symlink on the
 * way is resolved, so the checks above compare where the file really is.
 */
export async function realOf(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new LinkRefused(`Use an absolute path, not ${path}`);
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new LinkRefused(`${path} does not exist`);
    throw error;
  }
}

/**
 * Opens the file at `real` to read, only if the descriptor is still that path: a symlink swapped
 * in after the checks would otherwise send the gateway somewhere else. Where /proc is missing, as
 * on macOS, the path is resolved again and must be the same file. `O_NONBLOCK` keeps a FIFO left
 * at the path from holding the request open; it changes nothing for a regular file.
 */
export async function openReal(real: string): Promise<{ handle: FileHandle; info: Stats }> {
  const handle = await open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (opened !== undefined) {
      if (opened !== real) throw new LinkRefused('The file moved while it was being opened');
    } else {
      const [again, there] = await Promise.all([realpath(real), stat(real)]);
      if (again !== real || there.dev !== info.dev || there.ino !== info.ino) {
        throw new LinkRefused('The file moved while it was being opened');
      }
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
