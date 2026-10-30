import type { RemoteTask } from '@jian/contracts';

/** A task as the log tells it: what kind, and what it does, never what was typed. */
export type TaskSummary =
  | { kind: 'computer'; action?: string; at?: string; key?: string; chars?: number }
  | { kind: 'shell'; command: string; cwd?: string }
  | { kind: 'update'; version: string };

/** What a task is, in a few words for the log: the command, or the screen action. */
export function describeTask(task: RemoteTask): TaskSummary {
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
