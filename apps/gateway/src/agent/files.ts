import { execFile } from 'node:child_process';
import { glob, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { fileDiff } from './diff.js';
import { confine, confined, jianData, openToRead, writeInWorkspace } from './workspace.js';
import { workspaceHome } from './workspace-home.js';

/**
 * Reading, searching and changing files, shaped for working on code: reads come back numbered by
 * line, and an edit replaces an exact passage instead of rewriting the file, so a one-line change
 * costs one line of context and cannot drop the rest.
 *
 * Two rules protect the owner's files from an agent working from memory. A file that exists is
 * changed only after this run has read it, and only if nobody changed it since: otherwise the
 * edit would be computed against text that is no longer there. Both are checked where the write
 * happens, rather than asked of the model.
 *
 * The tools are the same wherever the files are; a `FileBackend` does the reading and writing.
 * The local one (below) works on the machine the gateway runs on, inside the gateway rather than
 * in a confined command, so each path is checked here (see workspace.ts). On a server: writes only
 * in the directory the agents share, reads there or in the system's directories. On a desktop:
 * anything but Jian's own data. The machine one (machine-files.ts) works on the machine a
 * conversation targets, through its worker.
 */

/** Lines a read returns when it names no limit: a whole source file, rarely a whole log. */
const READ_LINES = 2000;
/** A minified bundle is one enormous line; past this a line is cut, not the file. */
const LINE_CHARS = 2000;
/** Larger than any source file, small enough that reading it cannot exhaust the worker. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_WRITE = 400_000;
export const MAX_ENTRIES = 300;
const MAX_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 60_000;
/** Never what someone searching a codebase means, and large enough to drown the answer. */
const SKIPPED = ['.git', 'node_modules'];

/** What an edit is refused with when the run has not read the file it would change. */
export const READ_FIRST = 'Read the file with read_file before changing it';
/** What a change is refused with when the file is no longer what the run read. */
export const CHANGED = 'The file changed since you read it; read it again before changing it';

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), 'Use an absolute path');

export type FileEntry = { name: string; kind: 'directory' | 'file' | 'other' };
export type SearchInput = {
  pattern: string;
  glob?: string | undefined;
  ignoreCase: boolean;
  contextLines: number;
  output: 'content' | 'files' | 'count';
  limit: number;
};

/**
 * Where the file tools' reading and writing happen. Every method takes the path `confine`
 * returned. `seen` is the modification time this run's last read or write of the file saw, or
 * undefined when it has not touched it: a backend refuses a change to an existing file it does
 * not match, with `READ_FIRST` or `CHANGED`. Failures are thrown, worded for the agent.
 */
export type FileBackend = {
  /** Where the files are, as the tools' descriptions say it. */
  place: string;
  /** A limit on reading that the local tools lack, said in read_file's description. */
  readLimit?: string;
  /** How search_files respects .gitignore there, after "respecting .gitignore". */
  ignores?: string;
  /** What a path must look like to be one on that machine. */
  path: z.ZodType<string>;
  /** The path to work on, refused when it is out of reach for this access. */
  confine(path: string, access: 'read' | 'write'): Promise<string>;
  /** The path as the owner reads it in a diff. */
  shown(file: string): Promise<string>;
  /** The file's text as it is now, for reading it. */
  read(file: string, signal?: AbortSignal): Promise<{ text: string; mtimeMs: number }>;
  /** The text an edit starts from: only an existing file, only as this run saw it. */
  current(file: string, seen: number | undefined, signal?: AbortSignal): Promise<string>;
  /**
   * What a whole write replaces: undefined when nothing is there, null when it is not text this
   * can read. `expected` is what the write must find: the time seen, or null for no file at all.
   */
  prior(
    file: string,
    seen: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ before: string | null | undefined; expected: number | null }>;
  /** Replaces the whole file and returns its new modification time. */
  write(
    file: string,
    content: string,
    expected: number | null,
    signal?: AbortSignal,
  ): Promise<number>;
  list(
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }>;
  find(
    root: string,
    pattern: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; truncated?: true }>;
  search(
    target: string,
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<{ matches: string; truncated?: string }>;
};

const numbered = (lines: string[], first: number) =>
  lines
    .map((line, index) => {
      const cut = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} … (line cut)` : line;

      return `${first + index}\t${cut}`;
    })
    .join('\n');

const count = (text: string, part: string) => text.split(part).length - 1;

export const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… output cut` : text;

/** The file as it is now, refused when it is not text this tool can safely rewrite. */
async function textOf(file: string) {
  const handle = await openToRead(file);

  try {
    const info = await handle.stat();

    if (!info.isFile()) {
      throw new Error('That path is not a file');
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`The file has ${info.size} bytes; use run_command with head, tail or sed`);
    }

    const buffer = await handle.readFile();

    if (buffer.subarray(0, 8000).includes(0)) {
      throw new Error('The file is binary; inspect it with run_command instead');
    }

    return { text: buffer.toString('utf8'), mtime: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

/** A search runs confined like a command, so a link inside the tree cannot lead it out. */
async function run(command: string, args: string[]) {
  const home = await workspaceHome();
  const search = await confined(home, command, args);

  return new Promise<{ code: number | string; stdout: string; stderr: string }>((done) => {
    execFile(
      search.file,
      search.args,
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 8, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as { code?: number | string } | null)?.code ?? 0;

        done({ code, stdout, stderr });
      },
    );
  });
}

/**
 * A search of a folder holding Jian's own data would walk into it, since nothing confines a search
 * on a desktop. Its lines all begin with the path they came from, because the target is absolute,
 * so what came from there leaves here, whichever of the two programs answered. Neither follows a
 * link it meets on the way, so a real path prefix is enough.
 */
async function withoutJianData(lines: string[]): Promise<string[]> {
  const data = await jianData();
  if (!data) return lines;

  return lines.filter((line) => {
    const path = line.startsWith('Binary file ') ? line.slice('Binary file '.length) : line;

    return (
      path.startsWith(`${data.open}${sep}`) ||
      !data.closed.some((root) => path.startsWith(`${root}${sep}`))
    );
  });
}

/** The machine the gateway runs on, through workspace.ts's checks. */
export function localBackend(): FileBackend {
  /** An existing file may be replaced only as it was read. A new one needs nothing. */
  const assertCurrent = async (file: string, seen: number | undefined) => {
    const info = await stat(file).catch(() => undefined);

    if (!info) {
      return;
    }

    if (seen === undefined) {
      throw new Error(READ_FIRST);
    }

    if (info.mtimeMs !== seen) {
      throw new Error(CHANGED);
    }
  };

  return {
    place: 'the machine this gateway runs on',
    path: absolute,
    confine,

    /** The path as the owner knows it: inside `HOME`, from there. */
    shown: async (file) => {
      const home = await workspaceHome();
      const inside = relative(home, file);

      return inside && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? inside : file;
    },

    read: async (file) => {
      const { text, mtime } = await textOf(file);

      return { text, mtimeMs: mtime };
    },

    current: async (file, seen) => {
      await assertCurrent(file, seen);

      return (await textOf(file)).text;
    },

    prior: async (file, seen) => {
      await assertCurrent(file, seen);
      // What was there, so the owner sees the change and not only the new file. One that
      // existed but is not text this can read (binary, huge) gets no diff rather than a
      // false "created".
      const existed = await stat(file).then(
        () => true,
        () => false,
      );
      const before = existed
        ? await textOf(file).then(
            (current) => current.text,
            () => null,
          )
        : undefined;

      // The check above is the guarantee here: a local write has nothing to compare and swap.
      return { before, expected: null };
    },

    write: async (file, content) => {
      await writeInWorkspace(file, content);

      return (await stat(file)).mtimeMs;
    },

    list: async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });

      return {
        path: directory,
        entries: entries.slice(0, MAX_ENTRIES).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: entries.length > MAX_ENTRIES,
      };
    },

    find: async (root, pattern, limit) => {
      const found: Array<{ path: string; mtime: number }> = [];

      for await (const entry of glob(pattern, {
        cwd: root,
        exclude: (name: string) => SKIPPED.includes(basename(name)),
      })) {
        const file = resolve(root, entry);
        // A link in the tree may point out of reach; it is left out rather than listed.
        const reachable = await confine(file, 'read').then(
          () => true,
          () => false,
        );
        const info = reachable ? await stat(file).catch(() => undefined) : undefined;

        if (info?.isFile()) {
          found.push({ path: file, mtime: info.mtimeMs });
        }

        // Enough to sort meaningfully without walking a whole disk for a careless pattern.
        if (found.length >= limit * 10) {
          break;
        }
      }

      found.sort((a, b) => b.mtime - a.mtime);

      return {
        files: found.slice(0, limit).map((item) => item.path),
        ...(found.length > limit ? { truncated: true as const } : {}),
      };
    },

    search: async (target, { pattern, glob: only, ignoreCase, contextLines, output, limit }) => {
      const mode = output === 'files' ? ['-l'] : output === 'count' ? ['-c'] : ['-n'];

      let result = await run('rg', [
        '--no-heading',
        '--color',
        'never',
        ...mode,
        ...(ignoreCase ? ['-i'] : []),
        ...(contextLines && output === 'content' ? ['-C', String(contextLines)] : []),
        ...(only ? ['--glob', only] : []),
        ...SKIPPED.flatMap((name) => ['--glob', `!${name}`]),
        '--',
        pattern,
        target,
      ]);

      // Without ripgrep, grep answers the same question, minus .gitignore.
      // Confined, a missing program is the helper's exit 127 rather than ENOENT.
      if (result.code === 'ENOENT' || result.code === 127) {
        result = await run('grep', [
          '-rE',
          ...mode,
          ...(ignoreCase ? ['-i'] : []),
          ...(contextLines && output === 'content' ? ['-C', String(contextLines)] : []),
          ...(only ? [`--include=${only}`] : []),
          ...SKIPPED.map((name) => `--exclude-dir=${name}`),
          '--',
          pattern,
          target,
        ]);
      }

      // Both tools exit 1 when nothing matched, which is an answer, not a failure.
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(result.stderr.trim() || `Search failed (${result.code})`);
      }

      const lines = await withoutJianData(result.stdout.split('\n').filter(Boolean));

      return {
        matches: clip(lines.slice(0, limit).join('\n')),
        ...(lines.length > limit ? { truncated: `${lines.length - limit} more lines` } : {}),
      };
    },
  };
}

export function fileTools(backend: FileBackend = localBackend()): ToolSet {
  // What this run read, and the modification time it saw: the proof an edit needs.
  const seen = new Map<string, number>();
  const path = backend.path;

  return {
    read_file: tool({
      description: `Read a text file, numbered by line (the number, a tab, then the line). Reads the first 2000 lines unless told where to start and how many. Read a file before editing it.${backend.readLimit ? ` ${backend.readLimit}` : ''}`,
      inputSchema: z.object({
        path,
        offset: z.number().int().min(1).default(1).describe('First line to read, from 1.'),
        limit: z.number().int().min(1).max(10_000).default(READ_LINES),
      }),
      execute: async ({ path, offset, limit }, { abortSignal }) => {
        const file = await backend.confine(path, 'read');
        const { text, mtimeMs } = await backend.read(file, abortSignal);
        const lines = text.split('\n');

        // A final newline is how files end, not an extra empty line to show.
        if (lines.at(-1) === '') {
          lines.pop();
        }

        seen.set(file, mtimeMs);

        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const last = offset - 1 + slice.length;

        return {
          path: file,
          totalLines: lines.length,
          content: numbered(slice, offset),
          ...(last < lines.length ? { more: `Lines ${last + 1}–${lines.length} not shown` } : {}),
        };
      },
    }),

    edit_file: tool({
      description:
        'Change a file by replacing exact passages, in order, all or nothing. Each oldString must match the file exactly — indentation included, line numbers excluded — and only once unless replaceAll is set; include surrounding lines to make it unique. The file must have been read in this run.',
      inputSchema: z.object({
        path,
        edits: z
          .array(
            z.object({
              oldString: z.string().min(1),
              newString: z.string(),
              replaceAll: z.boolean().default(false),
            }),
          )
          .min(1)
          .max(50),
      }),
      execute: async ({ path, edits }, { abortSignal }) => {
        const file = await backend.confine(path, 'write');
        const expected = seen.get(file);
        const text = await backend.current(file, expected, abortSignal);
        const crlf = text.includes('\r\n');
        let next = text;
        let replacements = 0;
        let firstChange: number | undefined;

        for (const [index, edit] of edits.entries()) {
          // A model writes \n; a Windows file holds \r\n. Match what the file actually uses.
          const windows = crlf && !next.includes(edit.oldString);
          const oldString = windows ? edit.oldString.replace(/\r?\n/g, '\r\n') : edit.oldString;
          const newString = windows ? edit.newString.replace(/\r?\n/g, '\r\n') : edit.newString;

          if (oldString === newString) {
            throw new Error(`Edit ${index + 1} changes nothing`);
          }

          const found = count(next, oldString);

          if (found === 0) {
            throw new Error(
              `Edit ${index + 1}: the passage is not in the file. Read the file again and copy it exactly, indentation included`,
            );
          }

          if (found > 1 && !edit.replaceAll) {
            throw new Error(
              `Edit ${index + 1}: the passage appears ${found} times. Include more surrounding lines, or set replaceAll`,
            );
          }

          firstChange ??= next.indexOf(oldString);
          next = edit.replaceAll
            ? next.split(oldString).join(newString)
            : next.replace(oldString, () => newString);
          replacements += edit.replaceAll ? found : 1;
        }

        seen.set(file, await backend.write(file, next, expected ?? null, abortSignal));

        // A few numbered lines around the first change, so the result can be checked in place.
        const line = next.slice(0, firstChange).split('\n').length;
        const lines = next.split('\n');
        const from = Math.max(1, line - 3);

        // The whole change, for the owner's timeline; the runtime keeps it from the agent.
        const diff = fileDiff(await backend.shown(file), text, next);

        return {
          path: file,
          replacements,
          around: numbered(lines.slice(from - 1, line + 6), from),
          ...(diff ? { diff } : {}),
        };
      },
    }),

    write_file: tool({
      description:
        'Create a file, or replace one completely; missing folders are created. To change part of a file use edit_file instead. An existing file must have been read in this run.',
      inputSchema: z.object({ path, content: z.string().max(MAX_WRITE) }),
      execute: async ({ path, content }, { abortSignal }) => {
        const file = await backend.confine(path, 'write');
        const { before, expected } = await backend.prior(file, seen.get(file), abortSignal);

        seen.set(file, await backend.write(file, content, expected, abortSignal));
        const diff =
          before === null ? undefined : fileDiff(await backend.shown(file), before, content);

        return { path: file, bytes: Buffer.byteLength(content), ...(diff ? { diff } : {}) };
      },
    }),

    find_files: tool({
      description:
        'Find files by name with a glob such as **/*.ts or src/**/test_*.py, newest first. Skips .git and node_modules.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(500),
        path: path.describe('The folder to search from.'),
        limit: z.number().int().min(1).max(1000).default(MAX_MATCHES),
      }),
      execute: async ({ pattern, path, limit }, { abortSignal }) =>
        backend.find(await backend.confine(path, 'read'), pattern, limit, abortSignal),
    }),

    search_files: tool({
      description: `Search file contents with a regular expression, the way ripgrep does, respecting .gitignore${backend.ignores ?? ''}. Returns path:line:text, or only the paths, or a count per file.`,
      inputSchema: z.object({
        pattern: z.string().min(1).max(1000),
        path: path.describe('A folder or a single file.'),
        glob: z.string().max(200).optional().describe('Only files matching this, such as *.ts.'),
        ignoreCase: z.boolean().default(false),
        contextLines: z.number().int().min(0).max(10).default(0),
        output: z.enum(['content', 'files', 'count']).default('content'),
        limit: z.number().int().min(1).max(2000).default(MAX_MATCHES),
      }),
      execute: async ({ path, ...input }, { abortSignal }) =>
        backend.search(await backend.confine(path, 'read'), input, abortSignal),
    }),

    list_directory: tool({
      description: `List what is in a directory on ${backend.place}.`,
      inputSchema: z.object({ path }),
      execute: async ({ path }, { abortSignal }) =>
        backend.list(await backend.confine(path, 'read'), abortSignal),
    }),
  };
}
