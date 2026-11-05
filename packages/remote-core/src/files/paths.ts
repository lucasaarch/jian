import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Folders no file operation may touch: where the CLI worker keeps its token and config, and
 * where the desktop app keeps its own data (the sealed worker tokens). Both are always refused,
 * whichever host runs: a machine with both installed must not let one read the other's token.
 * A host with more of its own adds it with `setRefusedFolders`.
 */
function knownFolders(): string[] {
  const home = homedir();
  const appData =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return [
    join(home, '.config', 'jian-remote'),
    // The desktop app, packaged and from source.
    join(appData, 'Jian'),
    join(appData, 'Jian Dev'),
  ];
}
let extra: string[] = [];

/** Adds the folders a host owns to the ones always refused. */
export function setRefusedFolders(folders: string[] | undefined): void {
  extra = folders ?? [];
}

export const refusedFolders = (): string[] => [...knownFolders(), ...extra];

/** Windows and macOS compare names without case; a refusal must not be dodged by a spelling. */
const fold = (path: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;

/** Whether `path` is `folder` or lies in it, compared the way the file system compares. */
export const inside = (path: string, folder: string) => {
  const a = fold(path);
  const b = fold(folder);
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/**
 * The real location of a path that may not exist yet. An existing path is resolved by the
 * system, so `..` after a link means the link target's parent, as it does for the program that
 * will open it. A missing one is the real path of its nearest existing ancestor with the missing
 * names put back; a `..` or `.` in the missing part has no meaning to resolve and is refused.
 * A link that dangles counts as missing, since writing replaces the link, not its target.
 */
export async function realLocation(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  while (true) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const name = basename(current);
    const parent = dirname(current);
    if (name === '.' || name === '..') {
      throw Object.assign(new Error('A path through a missing folder cannot use . or ..'), {
        code: 'ENOENT',
      });
    }
    if (parent === current) return resolve(current, ...tail.reverse());
    if (name) tail.push(name);
    current = parent;
  }
}

/** Whether a real path lies in a refused folder, itself resolved the same way. */
export async function isRefused(real: string, folders = refusedFolders()): Promise<boolean> {
  return (await refusedRoots(folders)).some((root) => inside(real, root));
}

/** The real locations of the refused folders, with their spelling as given as well. */
export async function refusedRoots(folders = refusedFolders()): Promise<string[]> {
  const roots = await Promise.all(
    folders.map(async (folder) => [resolve(folder), await realLocation(folder).catch(() => '')]),
  );
  return [...new Set(roots.flat().filter(Boolean))];
}

/** Message for a refused path; it names no folder, so it does not map the machine's secrets. */
export const REFUSED_MESSAGE =
  'That path holds this worker’s own credentials and is not available.';
