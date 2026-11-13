import { execFile } from 'node:child_process';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionChange, SessionChanges } from '@jian/contracts';
import { fileDiff, fileLines } from '../agent/diff.js';
import { commandEnvironment } from '../agent/shell.js';
import { confine, confined, openToRead } from '../agent/workspace.js';
import { workspaceHome, workspaceTemp } from '../agent/workspace-home.js';
import { GatewayError } from '../core/errors.js';

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 500_000;
const MAX_GIT_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;

export const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** NUL records keep spaces, newlines, quotes and pathspec metacharacters literal. */
function changedFiles(status: string): SessionChange[] {
  const records = status.split('\0');
  const files: SessionChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = xy.includes('R');
    const copied = xy.includes('C');
    const previousPath = renamed || copied ? records[++index] : undefined;
    if (!path || path.length > 4096 || (previousPath && previousPath.length > 4096)) {
      throw new GatewayError(413, 'A changed path is too long to display.');
    }
    files.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status:
        xy === '??'
          ? 'untracked'
          : ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)
            ? 'conflicted'
            : renamed
              ? 'renamed'
              : copied
                ? 'copied'
                : xy.includes('D')
                  ? 'deleted'
                  : xy.includes('A')
                    ? 'added'
                    : xy.includes('T')
                      ? 'typechanged'
                      : 'modified',
    });
  }
  return merged(files);
}

/** A staged deletion followed by a replacement can appear again as an untracked file. */
function merged(files: SessionChange[]): SessionChange[] {
  const unique = new Map<string, SessionChange>();
  for (const file of files) {
    unique.set(file.path, unique.has(file.path) ? { ...file, status: 'modified' } : file);
  }
  return [...unique.values()];
}

const DIFF_STATUS: Record<string, SessionChange['status']> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'typechanged',
  U: 'conflicted',
};

/**
 * `diff --name-status -z --no-renames`: a renamed file reads as a deletion plus an addition,
 * which keeps one path per record and gives the old side a plain `git show` of the same path.
 */
function diffFiles(output: string): SessionChange[] {
  const records = output.split('\0');
  const files: SessionChange[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const status = DIFF_STATUS[records[index]?.[0] ?? ''];
    const path = records[index + 1] ?? '';
    if (!status || !path) continue;
    if (path.length > 4096) throw new GatewayError(413, 'A changed path is too long to display.');
    files.push({ path, status });
  }
  return files;
}

/**
 * The checkout read the way the panel may: never refresh its index or run repository-supplied
 * hooks, filters or diff drivers. Every read of a checkout, including the merge base below, goes
 * through here so none of them can be run with looser settings.
 */
export async function openCheckout(checkout: string) {
  const root = await realpath(await confine(checkout, 'read')).catch(() => {
    throw new GatewayError(409, 'This conversation has no checkout yet.');
  });
  const home = await workspaceHome();
  const temp = await workspaceTemp();
  const nowhere = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = {
    ...commandEnvironment({ home, temp }),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nowhere,
    // A missing promisor blob must not let `git show` contact its configured remote.
    GIT_NO_LAZY_FETCH: '1',
  };
  const settings = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nowhere}`];
  const git = async (args: string[], maxBuffer = MAX_GIT_BYTES) => {
    const command = await confined(home, 'git', [
      '--no-optional-locks',
      ...settings,
      '-C',
      root,
      ...args,
    ]);
    return new Promise<{ code: number | string; stdout: string }>((done, reject) => {
      execFile(
        command.file,
        command.args,
        { cwd: home, env, timeout: TIMEOUT_MS, maxBuffer, encoding: 'utf8' },
        (error, stdout) => {
          const failure = error as { code?: number | string; killed?: boolean } | null;
          if (failure?.killed || failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(
              new GatewayError(
                413,
                'The checkout is too large or slow to display. Use git in the terminal.',
              ),
            );
          } else {
            done({ code: failure?.code ?? 0, stdout });
          }
        },
      );
    });
  };
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || (await realpath(top.stdout.trim()).catch(() => '')) !== root) {
    throw new GatewayError(409, 'This conversation has no git checkout at its project path.');
  }
  return { root, git, settings };
}

/** Both sides of a changed file as text, or why it has no text diff. */
export type FileSides = { before?: string; after: string } | { unavailable: string };

/**
 * How one checkout is read, wherever it is. `status` hands over git's raw `-z` outputs, and the
 * parsers here turn them into files, so a checkout on this disk and one on a machine list the
 * same way; `diff` is there only when `against` was given. `file` reads the sides of a file the
 * status listed (`before` is absent for an untracked or added one; `after` is empty for a deleted
 * one). `mergeBase` is where a worktree's branch left `base`.
 */
export type CheckoutReader = {
  status(against?: string): Promise<{ status: string; diff?: string }>;
  file(file: SessionChange, against: string): Promise<FileSides>;
  mergeBase(base: string): Promise<string>;
};

/** A checkout on the gateway's own disk, read with the settings of `openCheckout`. */
export async function localReader(checkout: string): Promise<CheckoutReader> {
  return checkoutReader(await openCheckout(checkout));
}

/** The reader of a checkout already opened, for a caller that also runs its own git reads there. */
export function checkoutReader({
  root,
  git,
  settings,
}: Awaited<ReturnType<typeof openCheckout>>): CheckoutReader {
  return {
    async status(against) {
      // Even `status` can invoke a clean filter while comparing files. Override every local
      // driver, not just external diff/textconv, before asking git to inspect worktree contents.
      const filters = await git([
        'config',
        '--null',
        '--name-only',
        '--get-regexp',
        String.raw`^filter\..*\.(clean|smudge|process|required)$`,
      ]);
      if (filters.code !== 0 && filters.code !== 1) {
        throw new GatewayError(409, 'The checkout configuration could not be read.');
      }
      for (const key of filters.stdout.split('\0').filter(Boolean)) {
        settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
      }
      const status = await git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
      ]);
      if (status.code !== 0) throw new GatewayError(409, 'The checkout changes could not be read.');
      if (against === undefined) return { status: status.stdout };
      const tracked = await git([
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        '--ignore-submodules=dirty',
        against,
      ]);
      if (tracked.code !== 0)
        throw new GatewayError(409, 'The checkout changes could not be read.');
      return { status: status.stdout, diff: tracked.stdout };
    },
    file: (file, against) => localSides(root, git, file, against),
    async mergeBase(base) {
      const found = await git(['merge-base', `refs/heads/${base}`, 'HEAD']);
      const sha = found.stdout.trim();
      if (found.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new GatewayError(409, `Could not find where this worktree left ${base}.`);
      }
      return sha;
    },
  };
}

type Git = Awaited<ReturnType<typeof openCheckout>>['git'];

/**
 * The bytes of a file under `root`, or why not: it resolves `outside` the checkout, it `moved`
 * while being opened, it is no regular file (`special`), or it is `large`r than `max` bytes.
 * `real` is `target` already resolved by the caller, which decides what a symlink means to it.
 * The check is made on the open descriptor, so a link swapped in after it cannot be read.
 */
export async function readInside(
  root: string,
  target: string,
  real: string,
  max: number,
): Promise<{ bytes: Buffer } | { refused: 'outside' | 'moved' | 'special' | 'large' }> {
  if (!inside(root, real)) return { refused: 'outside' };
  const handle = await openToRead(real);
  try {
    const held = await handle.stat();
    // openToRead protects the workspace; this endpoint is narrower, only this checkout.
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (opened !== undefined) {
      if (!inside(root, opened)) return { refused: 'outside' };
    } else {
      const again = await realpath(target).catch(() => undefined);
      const there = await stat(real).catch(() => undefined);
      if (again !== real || held.dev !== there?.dev || held.ino !== there?.ino) {
        return { refused: 'moved' };
      }
    }
    if (!held.isFile()) return { refused: 'special' };
    if (held.size > max) return { refused: 'large' };
    // A fixed-size read also bounds a file that grows after stat.
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > max) return { refused: 'large' };
    return { bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

async function localSides(
  root: string,
  git: Git,
  file: SessionChange,
  against: string,
): Promise<FileSides> {
  const unavailable = (reason: string) => ({ unavailable: reason });
  let after = '';
  if (file.status !== 'deleted') {
    const target = resolve(root, file.path);
    const info = await lstat(target).catch(() => undefined);
    if (!info) return unavailable('The file changed while reading; refresh the changes.');
    if (!info.isFile()) return unavailable('Symlinks and submodules have no text diff.');
    const read = await readInside(root, target, await realpath(target), MAX_FILE_BYTES);
    if ('refused' in read) {
      return unavailable(
        read.refused === 'outside'
          ? 'The file resolves outside this checkout.'
          : read.refused === 'moved'
            ? 'The file changed while reading; refresh the changes.'
            : 'The file is too large to display.',
      );
    }
    if (read.bytes.includes(0)) return unavailable('Binary files have no text diff.');
    after = read.bytes.toString('utf8');
  }

  if (file.status === 'untracked' || file.status === 'added') return { after };
  // Reading the blob does not execute filters or follow a worktree symlink.
  const original = await git(
    ['show', `${against}:${file.previousPath ?? file.path}`],
    MAX_FILE_BYTES + 1,
  ).catch((error: unknown) => {
    if (error instanceof GatewayError && error.statusCode === 413) return undefined;
    throw error;
  });
  if (!original) return unavailable('The committed file is too large or slow to display.');
  if (original.code !== 0) return unavailable('The committed version could not be read.');
  if (Buffer.byteLength(original.stdout) > MAX_FILE_BYTES)
    return unavailable('The file is too large to display.');
  if (original.stdout.includes('\0')) return unavailable('Binary files have no text diff.');
  return { before: original.stdout, after };
}

/**
 * Where a worktree's branch left its base: the commit its changes are shown against, so the
 * base moving on never lists the base's own new work as the worktree's. The gateway computes it;
 * a request never supplies a revision. The base is a branch name, passed as a full ref so it
 * cannot read as an option or resolve to a tag.
 */
export async function worktreeMergeBase(checkout: string, base: string): Promise<string> {
  return (await localReader(checkout)).mergeBase(base);
}

/**
 * Read the checkout against \`against\` (HEAD for a project checkout, a merge base for a
 * worktree). A request cannot supply a command, revision, checkout path or arbitrary file path.
 */
export async function checkoutChanges(
  checkout: string,
  path?: string,
  whole = false,
  against = 'HEAD',
): Promise<SessionChanges> {
  return readChanges(await localReader(checkout), path, whole, against);
}

/** The changed files of whatever checkout `reader` reads, or one file's diff. */
export async function readChanges(
  reader: CheckoutReader,
  path?: string,
  whole = false,
  against = 'HEAD',
): Promise<SessionChanges> {
  // `against` is a sha the gateway computed; anything else would be a revision from outside.
  if (against !== 'HEAD' && !/^[0-9a-f]{40}$/.test(against)) {
    throw new GatewayError(500, 'Invalid comparison base.');
  }
  const raw = await reader.status(against === 'HEAD' ? undefined : against);
  const files =
    against === 'HEAD'
      ? changedFiles(raw.status)
      : merged([
          ...diffFiles(raw.diff ?? ''),
          ...changedFiles(raw.status).filter((file) => file.status === 'untracked'),
        ]);
  if (path === undefined)
    return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };

  // Membership, rather than path normalization alone, excludes traversal and git pathspec magic.
  const file = files.find((item) => item.path === path);
  if (!file) throw new GatewayError(404, 'That file is no longer changed in this checkout.');
  const unavailable = (reason: string): SessionChanges => ({
    files: [{ ...file, unavailable: reason }],
    truncated: false,
  });
  if (file.status === 'conflicted')
    return unavailable('Resolve the merge conflict to see a single diff.');

  const sides = await reader.file(file, against);
  if ('unavailable' in sides) return unavailable(sides.unavailable);
  const diff = fileDiff(file.path, sides.before, sides.after);
  const lines = whole && file.status !== 'deleted' ? fileLines(sides.after) : undefined;
  return diff
    ? { files: [{ ...file, diff, ...(lines ? { lines } : {}) }], truncated: false }
    : unavailable('No text diff is available; the contents may match or exceed comparison limits.');
}
