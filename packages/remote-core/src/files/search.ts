import { spawn } from 'node:child_process';
import { glob, open, readdir, stat } from 'node:fs/promises';
import { basename, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { MINIMAL_PATH } from '../shell.ts';
import { MAX_FIND_CHARS, MAX_SEARCH_CHARS } from './limits.ts';
import { isRefused, realLocation, refusedFolders } from './paths.ts';
import { FilesProblem } from './text.ts';

type Op<Name extends RemoteFilesOp['op']> = Extract<RemoteFilesOp, { op: Name }>;

/** Never what someone searching a codebase means, and large enough to drown the answer. */
const SKIPPED = ['.git', 'node_modules'];
const SEARCH_TIMEOUT_MS = 30_000;
/** What the search program may print before it is stopped; the answer keeps far less. */
const MAX_STDOUT = MAX_SEARCH_CHARS * 8;
/** A file larger than this is skipped by the fallback walk, as the gateway's read refuses it. */
const MAX_SEARCHED_BYTES = 20 * 1024 * 1024;

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

/** Files matching a glob, newest first, without walking a whole disk for a careless pattern. */
export async function findFiles(
  real: string,
  op: Op<'find'>,
  refused = refusedFolders(),
): Promise<RemoteFilesAnswer> {
  await folder(real);
  const found: Array<{ path: string; mtime: number }> = [];
  for await (const entry of glob(op.pattern, {
    cwd: real,
    exclude: (name: string) => SKIPPED.includes(basename(name)),
  })) {
    const file = resolve(real, entry);
    // A link in the tree may lead to the credentials; it is left out rather than listed.
    if (await isRefused(await realLocation(file), refused)) continue;
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) found.push({ path: file, mtime: info.mtimeMs });
    if (found.length >= op.limit * 10) break;
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const files: string[] = [];
  let chars = 0;
  for (const item of found.slice(0, op.limit)) {
    if (chars + item.path.length > MAX_FIND_CHARS) break;
    chars += item.path.length;
    files.push(item.path);
  }
  return { ok: true, op: 'find', files, truncated: found.length > files.length };
}

type Search = Op<'search'>;

/** The lines a search prints, the way `rg --no-heading` does, from the program or the walk. */
type Lines = { lines: string[] } | { problem: string };

function ripgrepArgs(op: Search, target: string): string[] {
  const mode = op.output === 'files' ? ['-l'] : op.output === 'count' ? ['-c'] : ['-n'];
  return [
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
function ripgrep(op: Search, target: string, env: NodeJS.ProcessEnv): Promise<Lines | undefined> {
  return new Promise((done) => {
    const child = spawn('rg', ripgrepArgs(op, target), {
      env: { ...env, PATH: env.PATH || MINIMAL_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: SEARCH_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: Lines | undefined) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) child.kill();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 2000);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ENOENT' ? undefined : { problem: error.message }),
    );
    child.on('close', (code) => {
      // 1 is no match, an answer. 2 is an error, but ripgrep still prints what it could read.
      if (code === 0 || code === 1 || (code === 2 && stdout)) {
        finish({ lines: stdout.split('\n').filter(Boolean) });
      } else {
        finish({ problem: stderr.trim() || `Search failed (${code}).` });
      }
    });
  });
}

/**
 * The walk without ripgrep: JS regular expressions, which differ from Rust's at the edges, and no
 * .gitignore. Hidden entries, `.git`, `node_modules`, binary files and files over 20 MiB are
 * skipped, as ripgrep skips them, and the output lines have the same shape.
 */
async function walk(op: Search, target: string, refused: string[]): Promise<Lines> {
  let expression: RegExp;
  try {
    expression = new RegExp(op.pattern, op.ignoreCase ? 'i' : '');
  } catch (error) {
    return { problem: error instanceof Error ? error.message : 'Invalid pattern.' };
  }
  const root = (await stat(target)).isDirectory() ? target : undefined;
  const files: string[] = [];
  const collect = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (root) await collect(root);
  else files.push(target);

  const lines: string[] = [];
  let printedAfter: { file: string; line: number } | undefined;
  for (const file of files) {
    if (refused.some((folder) => file.startsWith(`${folder}${sep}`))) continue;
    if (op.glob && root && !globMatches(op.glob, relative(root, file))) continue;
    const text = await readSearchable(file);
    if (text === undefined) continue;
    const rows = text.split('\n');
    if (rows.at(-1) === '') rows.pop();
    const hits = rows.flatMap((row, index) => (expression.test(row) ? [index] : []));
    if (!hits.length) continue;
    if (op.output === 'files') lines.push(file);
    else if (op.output === 'count') lines.push(`${file}:${hits.length}`);
    else {
      const shown = new Set<number>();
      for (const hit of hits) {
        const from = Math.max(0, hit - op.contextLines);
        for (let at = from; at <= Math.min(rows.length - 1, hit + op.contextLines); at += 1) {
          shown.add(at);
        }
      }
      for (const at of [...shown].sort((a, b) => a - b)) {
        // Groups that do not touch are told apart, within a file and between files.
        if (
          op.contextLines &&
          printedAfter &&
          (printedAfter.file !== file || at > printedAfter.line + 1)
        ) {
          lines.push('--');
        }
        const hit = hits.includes(at);
        lines.push(`${file}${hit ? ':' : '-'}${at + 1}${hit ? ':' : '-'}${rows[at]}`);
        printedAfter = { file, line: at };
      }
    }
  }
  return { lines };
}

/** A ripgrep glob is matched against the path under the folder, or the name when it has no `/`. */
const globMatches = (pattern: string, path: string) =>
  matchesGlob(path, pattern) || (!pattern.includes('/') && matchesGlob(basename(path), pattern));

async function readSearchable(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (info.size > MAX_SEARCHED_BYTES) return undefined;
    const buffer = await handle.readFile();
    return buffer.subarray(0, 8000).includes(0) ? undefined : buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Ripgrep when it is installed, else the walk. */
export async function searchFiles(
  real: string,
  op: Search,
  env: NodeJS.ProcessEnv,
  refused = refusedFolders(),
): Promise<RemoteFilesAnswer> {
  await stat(real);
  // Lines name the path as given, so what came from a refused folder is dropped by its prefix.
  const folders = [
    ...new Set([
      ...refused.map((path) => resolve(path)),
      ...(await Promise.all(refused.map(realLocation))),
    ]),
  ];
  const found = (await ripgrep(op, real, env)) ?? (await walk(op, real, folders));
  if ('problem' in found) throw new FilesProblem('failed', found.problem);
  const kept = found.lines.filter(
    (line) => !folders.some((folder) => line.startsWith(`${folder}${sep}`)),
  );
  const matches: string[] = [];
  let chars = 0;
  for (const line of kept.slice(0, op.limit)) {
    if (chars + line.length > MAX_SEARCH_CHARS) break;
    chars += line.length;
    matches.push(line);
  }
  return { ok: true, op: 'search', matches, truncated: kept.length > matches.length };
}
