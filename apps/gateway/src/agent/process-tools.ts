import { stripVTControlCharacters } from 'node:util';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { ProcessStart, Terminals } from '../terminals/service.js';
import { clip, MAX_OUTPUT } from './clip.js';

/**
 * The agent's commands in the background, on the machine the gateway runs on. They run in the
 * gateway's terminals (see terminals/service.ts), where the owner watches them from the panel and
 * stops them too; the agent reads their output and stops them here. A process belongs to the
 * conversation that started it and ends when the gateway does.
 */
export type ProcessAccess = {
  processes: Pick<
    Terminals,
    'startProcess' | 'processes' | 'processOutput' | 'stopProcess' | 'watch'
  >;
  profileId: string;
  sessionId: string;
};

/** How long a new command is given to say something, or to fail at once, in ms. */
const FIRST_OUTPUT_MS = 2000;

/** What a person would read on the screen: no colors or cursor moves, a redrawn line only once. */
export function plain(output: string): string {
  return stripVTControlCharacters(output.replaceAll('\r\n', '\n'))
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

const shown = (output: string) => clip(plain(output), MAX_OUTPUT);

/** Starts the command and answers with what it said in its first moments. */
export async function startBackground(access: ProcessAccess, start: ProcessStart) {
  const { processes, profileId, sessionId } = access;
  const started = await processes.startProcess(profileId, sessionId, start);

  await new Promise<void>((resolve) => {
    const wait = setTimeout(finish, FIRST_OUTPUT_MS);
    const watching = processes.watch(profileId, started.id, (event) => {
      if (event.type !== 'output') finish();
    });

    function finish() {
      clearTimeout(wait);
      watching.stop();
      resolve();
    }

    // It may have ended before the first look.
    if (watching.exitCode !== undefined) finish();
  });

  const { process: now, output } = processes.processOutput(profileId, started.id);

  return {
    processId: now.id,
    status: now.status,
    ...(now.exitCode === undefined ? {} : { exitCode: now.exitCode }),
    output: shown(output),
    note:
      now.status === 'running'
        ? 'Still running. Read more of its output with process_output, or end it with stop_process.'
        : 'It already ended.',
  };
}

export function processTools(access: ProcessAccess): ToolSet {
  const { processes, profileId, sessionId } = access;

  return {
    process_output: tool({
      description:
        "List this conversation's background commands, or read one: its status, exit code and the end of what it printed. Give processId for one; ask for the list to find it.",
      inputSchema: z.object({ processId: z.uuid().optional() }),
      execute: async ({ processId }) => {
        if (!processId) return { processes: processes.processes(profileId, sessionId) };
        const { process, output } = processes.processOutput(profileId, processId);

        return { process, output: shown(output) };
      },
    }),

    stop_process: tool({
      description:
        'Stop a background command and everything it started. It keeps its record and output, readable with process_output.',
      inputSchema: z.object({ processId: z.uuid() }),
      execute: async ({ processId }) => processes.stopProcess(profileId, processId),
    }),
  };
}
