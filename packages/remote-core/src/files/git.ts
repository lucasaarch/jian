import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { workerChildEnv } from '../shell.ts';
import { inside, isRefused, REFUSED_MESSAGE, realLocation } from './paths.ts';
import { FilesProblem } from './text.ts';

type Op<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesOp, { op: Name }>;

const TIMEOUT_MS = 10_000;
/** Each raw output of `git-status` and each side of `git-file`: the contract's 200,000. */
const SIDE_BYTES = 200_000;
const SMALL_BYTES = 4096;

/**
 * Git reads the repository the way the gateway's `openCheckout` does (apps/gateway/src/sessions/
 * changes.ts): never refresh the index, never run a hook, fsmonitor or filter the repository
 * supplies, never read the owner's global config, never fetch. Keep the two in step. Also,
 * `GIT_LITERAL_PATHSPECS` makes a path such as `:(top)x` a file name, not pathspec magic.
 */
const nowhere = () => (process.platform === 'win32' ? 'NUL' : '/dev/null');

function environment(): NodeJS.ProcessEnv {
  return {
    ...workerChildEnv(),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nowhere(),
    GIT_NO_LAZY_FETCH: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
}

type Ran = { code: number | string; stdout: Buffer; stderr: string };

function runGit(root: string, settings: string[], args: string[], maxBytes: number): Promise<Ran> {
  const full = [
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${nowhere()}`,
    ...settings,
    '-C',
    root,
    ...args,
  ];
  return new Promise((done, reject) => {
    execFile(
      'git',
      full,
      {
        cwd: tmpdir(),
        env: environment(),
        timeout: TIMEOUT_MS,
        maxBuffer: maxBytes,
        encoding: 'buffer',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const failure = error as { code?: number | string; killed?: boolean } | null;
        if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new FilesProblem('too-large', 'Git printed more than an answer can carry.'));
        } else if (failure?.killed) {
          reject(new FilesProblem('failed', 'Git took too long.'));
        } else if (failure?.code === 'ENOENT') {
          reject(new FilesProblem('failed', 'Git is not installed on this machine.'));
        } else {
          done({ code: failure?.code ?? 0, stdout, stderr: stderr.toString('utf8') });
        }
      },
    );
  });
}

type Checkout = {
  root: string;
  top: string;
  git: (args: string[], maxBytes?: number) => Promise<Ran>;
  settings: string[];
};

/** The folder, refused-roots checked and proven to be the top of its own repository. */
async function openRepository(root: string, refused?: string[]): Promise<Checkout> {
  const real = await realLocation(root);
  if (await isRefused(real, refused)) throw new FilesProblem('refused', REFUSED_MESSAGE);
  const settings: string[] = [];
  const git = (args: string[], maxBytes = SIDE_BYTES + 1) => runGit(real, settings, args, maxBytes);
  const notRepository = new FilesProblem(
    'not-repository',
    'That folder is not the top of a git repository.',
  );
  const found = await git(['rev-parse', '--show-toplevel'], SMALL_BYTES);
  const top = found.stdout.toString('utf8').trim();
  if (found.code !== 0 || !top || (await realpath(top).catch(() => '')) !== real) {
    throw notRepository;
  }
  return { root: real, top, git, settings };
}

/** Even `status` can run a clean filter while comparing files; every local driver is overridden. */
async function overrideFilters(checkout: Checkout): Promise<string[]> {
  const found = await checkout.git(
    [
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      String.raw`^filter\..*\.(clean|smudge|process|required)$`,
    ],
    SIDE_BYTES,
  );
  if (found.code !== 0 && found.code !== 1) {
    throw new FilesProblem('failed', 'The repository configuration could not be read.');
  }
  const keys = found.stdout.toString('utf8').split('\0').filter(Boolean);
  if (keys.length > 200 || keys.some((key) => key.length > 1024)) {
    throw new FilesProblem(
      'too-large',
      'The repository has more filter settings than can be shown.',
    );
  }
  for (const key of keys) {
    checkout.settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return keys;
}

export async function gitStatus(
  op: Op<'git-status'>,
  refused?: string[],
): Promise<RemoteFilesAnswer> {
  const checkout = await openRepository(op.root, refused);
  const filters = await overrideFilters(checkout);
  const status = await checkout.git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=dirty',
  ]);
  if (status.code !== 0) throw new FilesProblem('failed', 'The changes could not be read.');
  let diff: string | undefined;
  if (op.against !== undefined) {
    const tracked = await checkout.git([
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--ignore-submodules=dirty',
      op.against,
      '--',
    ]);
    if (tracked.code !== 0) throw new FilesProblem('failed', 'The changes could not be read.');
    diff = tracked.stdout.toString('utf8');
  }
  return {
    ok: true,
    op: 'git-status',
    top: checkout.top,
    filters,
    status: status.stdout.toString('utf8'),
    ...(diff === undefined ? {} : { diff }),
  };
}

/** The working copy of a file, only when it is a regular file that stays inside the repository. */
async function workingSide(
  checkout: Checkout,
  path: string,
  cap: number,
  refused?: string[],
): Promise<{ text: string | null; binary: boolean }> {
  const target = join(checkout.root, path);
  if (!inside(target, checkout.root))
    throw new FilesProblem('refused', 'That path leaves the repository.');
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (!info) return { text: null, binary: false };
  if (info.isSymbolicLink()) {
    const real = await realpath(target).catch(() => undefined);
    if (real && !inside(real, checkout.root)) {
      throw new FilesProblem('refused', 'That file resolves outside the repository.');
    }
    throw new FilesProblem('not-file', 'Symlinks and submodules have no text diff.');
  }
  if (!info.isFile()) throw new FilesProblem('not-file', 'That path is not a file.');
  const real = await realpath(target);
  if (!inside(real, checkout.root) || (await isRefused(real, refused))) {
    throw new FilesProblem('refused', 'That file resolves outside the repository.');
  }
  if (info.size > cap) throw new FilesProblem('too-large', 'The file is too large to display.');
  const buffer = await readFile(real);
  if (buffer.length > cap) throw new FilesProblem('too-large', 'The file is too large to display.');
  if (buffer.subarray(0, 8000).includes(0)) return { text: null, binary: true };
  return { text: buffer.toString('utf8'), binary: false };
}

export async function gitFile(op: Op<'git-file'>, refused?: string[]): Promise<RemoteFilesAnswer> {
  const checkout = await openRepository(op.root, refused);
  const cap = Math.min(op.maxBytes, SIDE_BYTES);
  await overrideFilters(checkout);
  const shown = await checkout.git(['show', `${op.against}:${op.path}`], cap);
  let before: string | null = null;
  let binary = false;
  if (shown.code === 0) {
    if (shown.stdout.subarray(0, 8000).includes(0)) binary = true;
    else before = shown.stdout.toString('utf8');
  } else if (!/does not exist|exists on disk, but not in|not a tree object/i.test(shown.stderr)) {
    throw new FilesProblem('failed', 'The committed file could not be read.');
  }
  const working = await workingSide(checkout, op.path, cap, refused);
  if (working.binary) binary = true;
  return {
    ok: true,
    op: 'git-file',
    before,
    after: working.text,
    ...(binary ? { binary: true as const } : {}),
  };
}

export async function mergeBase(
  op: Op<'merge-base'>,
  refused?: string[],
): Promise<RemoteFilesAnswer> {
  const checkout = await openRepository(op.root, refused);
  // A full ref, so the base cannot read as an option or resolve to a tag.
  const found = await checkout.git(['merge-base', `refs/heads/${op.base}`, 'HEAD'], SMALL_BYTES);
  const sha = found.stdout.toString('utf8').trim();
  if (found.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new FilesProblem('failed', `Could not find where this branch left ${op.base}.`);
  }
  return { ok: true, op: 'merge-base', sha };
}
