import type { RemoteTask } from '@jian/contracts';

/** A task as the log tells it: what kind, and what it does, never what was typed. */
export type TaskSummary =
  | { kind: 'computer'; action?: string; at?: string; key?: string; chars?: number }
  | { kind: 'shell'; command: string; cwd?: string }
  | { kind: 'update'; version: string }
  | { kind: 'browser'; operation?: string }
  | { kind: 'files'; operation: string };

/** What a task is, in a few words for the log: the command, or the screen action. */
export function describeTask(task: RemoteTask): TaskSummary {
  if (task.kind === 'browser') return { kind: 'browser', operation: task.browser?.operation };
  // The operation alone: the path and the content of a file stay out of the log.
  if (task.kind === 'files') return { kind: 'files', operation: filesOperation(task.files?.op) };
  if (task.kind === 'update') return { kind: 'update', version: task.update?.version ?? 'latest' };
  if (task.kind === 'computer') {
    const { action, coordinate, key, text } = task.computer ?? {};
    return {
      kind: 'computer',
      ...(action ? { action } : {}),
      ...(coordinate ? { at: coordinate.join(',') } : {}),
      ...(key ? { key } : {}),
      // What is typed can be a password: only its length is kept.
      ...(text ? { chars: text.length } : {}),
    };
  }
  const command = String(task.command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    kind: 'shell',
    command: command.length > 200 ? `${command.slice(0, 199)}…` : command,
    ...(task.cwd ? { cwd: task.cwd } : {}),
  };
}

const FILES_WORDING: Record<string, string> = {
  read: 'Reading a file',
  'read-bytes': 'Reading a file',
  write: 'Editing a file',
  'write-bytes': 'Editing a file',
  list: 'Listing a folder',
  find: 'Finding files',
  search: 'Searching files',
  'git-status': 'Reading changes',
  'git-file': 'Reading changes',
  'merge-base': 'Reading changes',
};

/** A files operation as the log tells it. */
const filesOperation = (op: string | undefined) => FILES_WORDING[op ?? ''] ?? 'Working with files';
