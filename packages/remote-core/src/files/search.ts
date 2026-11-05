import { spawn } from 'node:child_process';
import { glob, readdir, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { MINIMAL_PATH } from '../shell.ts';
import { MAX_FIND_CHARS, MAX_SEARCH_CHARS } from './limits.ts';
import { inside, isRefused, realLocation, refusedRoots } from './paths.ts';
import { FilesProblem } from './text.ts';
import { type WalkJob, walkSearch } from './walk.ts';

type Op<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesOp, { op: Name }>;

/** Never what someone searching a codebase means, and large enough to drown the answer. */
const SKIPPED = ['.git', 'node_modules'];
/** How long a search runs, in ms, unless the task allows less. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** What the search program may print before it is stopped; the answer keeps far less. */
const MAX_STDOUT = MAX_SEARCH_CHARS * 8;
/** A file larger than this is skipped by the fallback walk, as the read tool refuses it. */
const MAX_SEARCHED_BYTES = 20 * 1024 * 1024;

/**
 * Where the answer shows its paths: as the agent gave them when that is a plain absolute path,
 * else the real ones. Searching and listing run on the real path, which is what the checks saw.
 */
export function shower(given: string, real: string): (path: string) => string {
  const plain = !given.split(/[\\/]/).some((part) => part === '.' || part === '..');
  const shown = plain ? given.replace(/[\\/]+$/, '') || given : real;
  if (shown === real) return (path) => path;
  return (path) =>
    path === real || path.startsWith(real + sep) ? shown + path.slice(real.length) : path;
}

async function folder(real: string) {
  const info = await stat(real);
  if (!info.isDirectory()) throw new FilesProblem('not-directory', 'That path is not a folder.');
}

export async function listFolder(real: string, op: Op<'list'>): Promise<RemoteFilesAnswer> {
  await folder(real);
  const entries = await readdir(real, { withFileTypes: true });
  return {
    ok: true,
    op: 'list',
    entries: entries.slice(0, op.limit).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : entry.isSymbolicLink()
            ? 'symlink'
            : 'other',
    })),
    truncated: entries.length > op.limit,
  };
}

/**
 * Kernel folders of a Unix machine: endless or slow to walk, and never files anyone searches
 * for. Windows has none at a fixed place.
 */
const SYSTEM_FOLDERS = process.platform === 'win32' ? [] : ['/proc', '/sys', '/dev'];

/**
 * Files matching a glob, newest first, without walking a whole disk for a careless pattern. The
 * machine has one worker, so the walk stops at `timeoutMs` and answers with what it found,
 * marked truncated. Folders it cannot read are left out by the glob itself.
 */
export async function findFiles(
  real: string,
  op: Op<'find'>,
  refused: string[],
  show: (path: string) => string = (path) => path,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<RemoteFilesAnswer> {
  await folder(real);
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = glob(op.pattern, {
    cwd: real,
    exclude: (name: string) =>
      SKIPPED.includes(basename(name)) || SYSTEM_FOLDERS.includes(resolve(real, name)),
  })[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One wait for the whole walk: a step that finds nothing for a long time still ends at it.
  const deadline = new Promise<'time'>((done) => {
    timer = setTimeout(() => done('time'), timeoutMs);
  });
  let stopped = false;
  try {
    while (true) {
      const next = await Promise.race([walk.next(), deadline]);
      if (next === 'time') {
        stopped = true;
        break;
      }
      if (next.done) break;
      const file = resolve(real, next.value);
      // A link in the tree may lead to the credentials; it is left out rather than listed.
      if (await isRefused(await realLocation(file), refused)) continue;
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) found.push({ path: file, mtime: info.mtimeMs });
      if (found.length >= op.limit * 10) break;
    }
  } finally {
    clearTimeout(timer);
    // Stops the walk at its next step; what it was reading when the deadline came is dropped.
    void walk.return?.(undefined).catch(() => {});
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const files: string[] = [];
  let chars = 0;
  for (const item of found.slice(0, op.limit)) {
    const shown = show(item.path);
    if (chars + shown.length > MAX_FIND_CHARS) break;
    chars += shown.length;
    files.push(shown);
  }
  return { ok: true, op: 'find', files, truncated: stopped || found.length > files.length };
}

type Search = Op<'search'>;

/** What a search printed, and whether it stopped before the end (size, time or limit). */
type Found = { lines: string[]; truncated: boolean; timedOut: boolean } | { problem: string };

function ripgrepArgs(op: Search, target: string): string[] {
  const mode = op.output === 'files' ? ['-l'] : op.output === 'count' ? ['-c'] : ['-n'];
  return [
    // The owner's RIPGREP_CONFIG_PATH may hold --follow or --no-ignore, which would walk through
    // links into a refused folder under a spelling the output filter does not know.
    '--no-config',
    '--no-heading',
    '--with-filename',
    '--color',
    'never',
    ...mode,
    ...(op.ignoreCase ? ['-i'] : []),
    ...(op.contextLines && op.output === 'content' ? ['-C', String(op.contextLines)] : []),
    ...(op.glob ? ['--glob', op.glob] : []),
    ...SKIPPED.flatMap((name) => ['--glob', `!${name}`]),
    // The pattern after -e and the path after --, so neither can be read as an option.
    '-e',
    op.pattern,
    '--',
    target,
  ];
}

/** Runs ripgrep with no shell; undefined when it is not installed. */
function ripgrep(
  op: Search,
  target: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  roots: string[],
): Promise<Found | undefined> {
  return new Promise((done) => {
    const child = spawn('rg', ripgrepArgs(op, target), {
      env: { ...env, PATH: env.PATH || MINIMAL_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stopped: 'size' | 'time' | undefined;
    let settled = false;
    const finish = (value: Found | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => {
      stopped ??= 'time';
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT && !stopped) {
        stopped = 'size';
        child.kill();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 2000);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' ? undefined : { problem: error.message }),
    );
    child.on('close', (code) => {
      if (stopped) {
        // What was printed up to the stop; the line being written when it stopped is not whole.
        const whole = stdout.endsWith('\n')
          ? stdout
          : stdout.slice(0, stdout.lastIndexOf('\n') + 1);
        finish({
          lines: whole.split('\n').filter(Boolean),
          truncated: true,
          timedOut: stopped === 'time',
        });
      } else if (code === 0 || code === 1 || (code === 2 && stdout)) {
        // 1 is no match, an answer. 2 is an error, but ripgrep still prints what it could read.
        finish({ lines: stdout.split('\n').filter(Boolean), truncated: false, timedOut: false });
      } else {
        // Its complaints name files, which may lie in a refused folder; those lines are dropped.
        const said = stderr
          .split('\n')
          .filter(
            (line) =>
              line.trim() && !roots.some((root) => line.toLowerCase().includes(root.toLowerCase())),
          )
          .join('\n');
        finish({ problem: said || `Search failed (${code}).` });
      }
    });
  });
}

/**
 * The walk without ripgrep, in a worker thread: a pattern that never ends cannot hold this
 * thread, and so every gateway's worker sharing it, past its deadline. The thread's source is
 * the function itself (see walk.ts), which keeps it inside a single bundle.
 */
function walkInThread(job: WalkJob, timeoutMs: number): Promise<Found> {
  return new Promise((done) => {
    const lines: string[] = [];
    let truncated = false;
    let settled = false;
    const worker = new Worker(
      `(${walkSearch.toString()})(require('node:worker_threads').workerData)`,
      {
        eval: true,
        workerData: job,
      },
    );
    const finish = (value: Found) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      done(value);
    };
    const timer = setTimeout(() => finish({ lines, truncated: true, timedOut: true }), timeoutMs);
    worker.on(
      'message',
      (message: { lines?: string[]; problem?: string; done?: boolean; truncated?: boolean }) => {
        if (message.lines) lines.push(...message.lines);
        if (message.problem) finish({ problem: message.problem });
        if (message.done) {
          truncated = Boolean(message.truncated);
          finish({ lines, truncated, timedOut: false });
        }
      },
    );
    worker.on('error', (error: Error) => finish({ problem: error.message }));
    worker.on('exit', () => finish({ lines, truncated, timedOut: false }));
  });
}

/** Ripgrep when it is installed, else the walk, both on the real path and bounded in time. */
export async function searchFiles(
  real: string,
  op: Search,
  env: NodeJS.ProcessEnv,
  refused: string[],
  show: (path: string) => string = (path) => path,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<RemoteFilesAnswer> {
  await stat(real);
  const roots = await refusedRoots(refused);
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const found =
    (await ripgrep(op, real, env, timeoutMs, roots)) ??
    (await walkInThread(
      {
        target: real,
        pattern: op.pattern,
        ignoreCase: op.ignoreCase,
        glob: op.glob,
        contextLines: op.contextLines,
        output: op.output,
        limit: op.limit,
        chars: MAX_SEARCH_CHARS,
        refused: roots,
        caseless,
        skipped: SKIPPED,
        maxFileBytes: MAX_SEARCHED_BYTES,
      },
      timeoutMs,
    ));
  if ('problem' in found) throw new FilesProblem('failed', found.problem);
  // Every line starts with the path it came from, so what came from a refused folder goes by its
  // prefix, compared as the file system compares. Lines without a path (`--`) stay.
  const kept = found.lines.filter(
    (line) => !roots.some((root) => inside(line, root) && line !== root),
  );
  const matches: string[] = [];
  let chars = 0;
  for (const line of kept.slice(0, op.limit)) {
    const shown = show(line);
    if (chars + shown.length > MAX_SEARCH_CHARS) {
      // One line longer than the budget is cut, not turned into an empty answer.
      if (!matches.length) matches.push(shown.slice(0, MAX_SEARCH_CHARS));
      break;
    }
    chars += shown.length;
    matches.push(shown);
  }
  if (found.timedOut && matches.length < op.limit && chars + 50 <= MAX_SEARCH_CHARS) {
    matches.push('… search stopped at its time limit');
  }
  return {
    ok: true,
    op: 'search',
    matches,
    truncated: found.truncated || kept.length > matches.length,
  };
}
