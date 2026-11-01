import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
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

const inside = (root: string, path: string) => {
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
  // A staged deletion followed by a replacement can appear again as an untracked file.
  const unique = new Map<string, SessionChange>();
  for (const file of files) {
    unique.set(file.path, unique.has(file.path) ? { ...file, status: 'modified' } : file);
  }
  return [...unique.values()];
}

/**
 * Read the checkout, never refresh its index or run repository-supplied hooks, filters or diff
 * drivers. A request cannot supply a command, revision, checkout path or arbitrary file path.
 */
export async function checkoutChanges(
  checkout: string,
  path?: string,
  whole = false,
): Promise<SessionChanges> {
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
  // Even `status` can invoke a clean filter while comparing files. Override every local driver,
  // not just external diff/textconv, before asking git to inspect worktree contents.
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
  const files = changedFiles(status.stdout);
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

  let after = '';
  if (file.status !== 'deleted') {
    const target = resolve(root, file.path);
    const info = await lstat(target).catch(() => undefined);
    if (!info) return unavailable('The file changed while reading; refresh the changes.');
    if (!info.isFile()) return unavailable('Symlinks and submodules have no text diff.');
    const real = await realpath(target);
    if (!inside(root, real)) return unavailable('The file resolves outside this checkout.');
    const handle = await openToRead(real);
    try {
      const held = await handle.stat();
      // openToRead protects the workspace; this endpoint is narrower, only this checkout.
      const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
      if (opened !== undefined) {
        if (!inside(root, opened)) return unavailable('The file resolves outside this checkout.');
      } else {
        const again = await realpath(target).catch(() => undefined);
        const there = await lstat(target).catch(() => undefined);
        if (again !== real || held.dev !== there?.dev || held.ino !== there?.ino) {
          return unavailable('The file changed while reading; refresh the changes.');
        }
      }
      if (!held.isFile() || held.size > MAX_FILE_BYTES)
        return unavailable('The file is too large to display.');
      // A fixed-size read also bounds a file that grows after stat.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_FILE_BYTES) return unavailable('The file is too large to display.');
      if (buffer.subarray(0, length).includes(0))
        return unavailable('Binary files have no text diff.');
      after = buffer.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  let before: string | undefined;
  if (file.status !== 'untracked' && file.status !== 'added') {
    // Reading the blob does not execute filters or follow a worktree symlink.
    const original = await git(
      ['show', `HEAD:${file.previousPath ?? file.path}`],
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
    before = original.stdout;
  }
  const diff = fileDiff(file.path, before, after);
  const lines = whole && file.status !== 'deleted' ? fileLines(after) : undefined;
  return diff
    ? { files: [{ ...file, diff, ...(lines ? { lines } : {}) }], truncated: false }
    : unavailable('No text diff is available; the contents may match or exceed comparison limits.');
}
