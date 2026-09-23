import { execFile } from 'node:child_process';
import { glob, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';

/**
 * Reading, searching and changing files on the machine the gateway runs on, shaped for working
 * on code: reads come back numbered by line, and an edit replaces an exact passage instead of
 * rewriting the file, so a one-line change costs one line of context and cannot drop the rest.
 *
 * Two rules protect the owner's files from an agent working from memory. A file that exists is
 * changed only after this run has read it, and only if nobody changed it since: otherwise the
 * edit would be computed against text that is no longer there. Both are checked here, where the
 * write happens, rather than asked of the model.
 */

/** Lines a read returns when it names no limit: a whole source file, rarely a whole log. */
const READ_LINES = 2000;
/** A minified bundle is one enormous line; past this a line is cut, not the file. */
const LINE_CHARS = 2000;
/** Larger than any source file, small enough that reading it cannot exhaust the worker. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_WRITE = 400_000;
const MAX_ENTRIES = 300;
const MAX_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 60_000;
/** Never what someone searching a codebase means, and large enough to drown the answer. */
const SKIPPED = ['.git', 'node_modules'];

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), 'Use an absolute path');

const numbered = (lines: string[], first: number) =>
  lines
    .map((line, index) => {
      const cut = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} … (line cut)` : line;

      return `${first + index}\t${cut}`;
    })
    .join('\n');

const count = (text: string, part: string) => text.split(part).length - 1;

const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… output cut` : text;

/** The file as it is now, refused when it is not text this tool can safely rewrite. */
async function textOf(file: string) {
  const info = await stat(file);

  if (!info.isFile()) {
    throw new Error('That path is not a file');
  }

  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`The file has ${info.size} bytes; use run_command with head, tail or sed`);
  }

  const buffer = await readFile(file);

  if (buffer.subarray(0, 8000).includes(0)) {
    throw new Error('The file is binary; inspect it with run_command instead');
  }

  return { text: buffer.toString('utf8'), mtime: info.mtimeMs };
}

function run(command: string, args: string[]) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((done) => {
    execFile(
      command,
      args,
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT * 8, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as { code?: number | string } | null)?.code ?? 0;

        done({ code, stdout, stderr });
      },
    );
  });
}

export function fileTools(): ToolSet {
  // What this run read, and the modification time it saw: the proof an edit needs.
  const seen = new Map<string, number>();

  /** An existing file may be replaced only as it was read. A new one needs nothing. */
  const assertCurrent = async (file: string) => {
    const info = await stat(file).catch(() => undefined);

    if (!info) {
      return;
    }

    const read = seen.get(file);

    if (read === undefined) {
      throw new Error('Read the file with read_file before changing it');
    }

    if (info.mtimeMs !== read) {
      throw new Error('The file changed since you read it; read it again before changing it');
    }
  };

  const remember = async (file: string) => {
    seen.set(file, (await stat(file)).mtimeMs);
  };

  return {
    read_file: tool({
      description:
        'Read a text file, numbered by line (the number, a tab, then the line). Reads the first 2000 lines unless told where to start and how many. Read a file before editing it.',
      inputSchema: z.object({
        path: absolute,
        offset: z.number().int().min(1).default(1).describe('First line to read, from 1.'),
        limit: z.number().int().min(1).max(10_000).default(READ_LINES),
      }),
      execute: async ({ path, offset, limit }) => {
        const file = resolve(path);
        const { text, mtime } = await textOf(file);
        const lines = text.split('\n');

        // A final newline is how files end, not an extra empty line to show.
        if (lines.at(-1) === '') {
          lines.pop();
        }

        seen.set(file, mtime);

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
        path: absolute,
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
      execute: async ({ path, edits }) => {
        const file = resolve(path);

        await assertCurrent(file);

        const { text } = await textOf(file);
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

        await writeFile(file, next, 'utf8');
        await remember(file);

        // A few numbered lines around the first change, so the result can be checked in place.
        const line = next.slice(0, firstChange).split('\n').length;
        const lines = next.split('\n');
        const from = Math.max(1, line - 3);

        return {
          path: file,
          replacements,
          around: numbered(lines.slice(from - 1, line + 6), from),
        };
      },
    }),

    write_file: tool({
      description:
        'Create a file, or replace one completely; missing folders are created. To change part of a file use edit_file instead. An existing file must have been read in this run.',
      inputSchema: z.object({ path: absolute, content: z.string().max(MAX_WRITE) }),
      execute: async ({ path, content }) => {
        const file = resolve(path);

        await assertCurrent(file);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        await remember(file);

        return { path: file, bytes: Buffer.byteLength(content) };
      },
    }),

    find_files: tool({
      description:
        'Find files by name with a glob such as **/*.ts or src/**/test_*.py, newest first. Skips .git and node_modules.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(500),
        path: absolute.describe('The folder to search from.'),
        limit: z.number().int().min(1).max(1000).default(MAX_MATCHES),
      }),
      execute: async ({ pattern, path, limit }) => {
        const root = resolve(path);
        const found: Array<{ path: string; mtime: number }> = [];

        for await (const entry of glob(pattern, {
          cwd: root,
          exclude: (name: string) => SKIPPED.includes(basename(name)),
        })) {
          const file = resolve(root, entry);
          const info = await stat(file).catch(() => undefined);

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
          ...(found.length > limit ? { truncated: true } : {}),
        };
      },
    }),

    search_files: tool({
      description:
        'Search file contents with a regular expression, the way ripgrep does, respecting .gitignore. Returns path:line:text, or only the paths, or a count per file.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(1000),
        path: absolute.describe('A folder or a single file.'),
        glob: z.string().max(200).optional().describe('Only files matching this, such as *.ts.'),
        ignoreCase: z.boolean().default(false),
        contextLines: z.number().int().min(0).max(10).default(0),
        output: z.enum(['content', 'files', 'count']).default('content'),
        limit: z.number().int().min(1).max(2000).default(MAX_MATCHES),
      }),
      execute: async ({ pattern, path, glob: only, ignoreCase, contextLines, output, limit }) => {
        const target = resolve(path);
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
        if (result.code === 'ENOENT') {
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

        const lines = result.stdout.split('\n').filter(Boolean);

        return {
          matches: clip(lines.slice(0, limit).join('\n')),
          ...(lines.length > limit ? { truncated: `${lines.length - limit} more lines` } : {}),
        };
      },
    }),

    list_directory: tool({
      description: 'List what is in a directory on the machine this gateway runs on.',
      inputSchema: z.object({ path: absolute }),
      execute: async ({ path }) => {
        const directory = resolve(path);
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
    }),
  };
}
