import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Folders no file operation may touch: where this worker keeps its token and config. The
 * gateway's agent is not trusted with the machine's credentials, whatever else it may read.
 * A host with its own data beside the token adds it with `setRefusedFolders`.
 */
const defaultRefused = () => [join(homedir(), '.config', 'jian-remote')];
let configured: string[] | undefined;

/** Replaces the refused folders; a host calls it once at start with the folders it owns. */
export function setRefusedFolders(folders: string[] | undefined): void {
  configured = folders;
}

export const refusedFolders = (): string[] => configured ?? defaultRefused();

/** Windows and macOS compare names without case; a refusal must not be dodged by a spelling. */
const fold = (path: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;

const inside = (path: string, folder: string) => {
  const a = fold(path);
  const b = fold(folder);
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/**
 * The real location of a path that may not exist yet: the real path of its nearest existing
 * ancestor, with the missing tail put back. A link that dangles counts as missing, since
 * writing replaces the link and not what it points at.
 */
export async function realLocation(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail.reverse());
    tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
}

/** Whether a real path lies in a refused folder, itself resolved the same way. */
export async function isRefused(real: string, folders = refusedFolders()): Promise<boolean> {
  for (const folder of folders) {
    const roots = [resolve(folder), await realLocation(folder)];
    if (roots.some((root) => inside(real, root))) return true;
  }
  return false;
}

/** Message for a refused path; it names no folder, so it does not map the machine's secrets. */
export const REFUSED_MESSAGE =
  'That path holds this worker’s own credentials and is not available.';
