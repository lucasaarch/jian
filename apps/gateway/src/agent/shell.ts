import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';

/**
 * Reading, writing and running commands on the machine the gateway runs on.
 *
 * There is no sandbox and no allow-list of directories: the owner asked for the whole machine,
 * and these tools run with the privileges of whoever started the gateway. What bounds them is
 * the profile switch that hands them out at all — everything here is off unless `allowShell`
 * is on for that profile.
 *
 * Read this as what it is: anyone who can make this agent act — including an approved contact
 * on a chat channel — can make it run a command. The limits below are about keeping a run
 * alive and its results readable, not about containment.
 */

/** Long enough for a build, short enough that a run does not die waiting on a hung command. */
const TIMEOUT_MS = 120_000;
/** Output past this is cut; a command that prints a megabyte would cost the run its context. */
const MAX_OUTPUT = 60_000;
const MAX_FILE = 400_000;
const MAX_ENTRIES = 300;

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), 'Use an absolute path');

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… ${text.length - limit} caracteres omitidos`
    : text;
}

export function shellTools(): ToolSet {
  return {
    run_command: tool({
      description:
        'Run a command on the machine this gateway runs on and read what it printed. Prefer a single command over a shell pipeline you cannot inspect. Anything destructive needs the owner to have asked for it in this conversation.',
      inputSchema: z.object({
        command: z.string().trim().min(1).max(4000),
        cwd: absolute.optional(),
        timeoutMs: z.number().int().min(1000).max(TIMEOUT_MS).default(30_000),
      }),
      execute: async ({ command, cwd, timeoutMs }) =>
        new Promise((resolvePromise) => {
          execFile(
            '/bin/sh',
            ['-c', command],
            { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 4, encoding: 'utf8' },
            (error, stdout, stderr) => {
              const status = (error as { code?: unknown } | null)?.code;

              resolvePromise({
                // Zero is success; a string here is a signal, such as a command that timed out.
                exitCode: typeof status === 'number' ? status : status ? String(status) : 0,
                stdout: clip(stdout, MAX_OUTPUT),
                stderr: clip(stderr, MAX_OUTPUT),
              });
            },
          );
        }),
    }),

    read_file: tool({
      description: 'Read a file from the machine this gateway runs on.',
      inputSchema: z.object({
        path: absolute,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(MAX_FILE).default(MAX_FILE),
      }),
      execute: async ({ path, offset, limit }) => {
        const file = resolve(path);
        const info = await stat(file);

        if (!info.isFile()) {
          throw new Error('That path is not a file');
        }

        const content = await readFile(file, 'utf8');

        return {
          path: file,
          bytes: info.size,
          content: clip(content.slice(offset, offset + limit), MAX_FILE),
        };
      },
    }),

    write_file: tool({
      description:
        'Write a file on the machine this gateway runs on, replacing whatever was there. Read it first unless you are creating it.',
      inputSchema: z.object({ path: absolute, content: z.string().max(MAX_FILE) }),
      execute: async ({ path, content }) => {
        const file = resolve(path);

        await writeFile(file, content, 'utf8');

        return { path: file, bytes: Buffer.byteLength(content) };
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
