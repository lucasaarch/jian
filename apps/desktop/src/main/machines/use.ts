import type { RemoteTask } from '@jian/contracts';

/** File operations only the panel asks for, to show a conversation's changes. */
const PANEL_READS = new Set(['git-status', 'git-file', 'merge-base']);

/**
 * How the window says a task uses this computer, or undefined when it says nothing. The panel's
 * own reads of a checkout come every few seconds while the Changes tab is open: an indicator
 * for them would claim an agent is at work when nobody is.
 */
export function shownUse(
  task: Pick<RemoteTask, 'kind' | 'files'>,
): 'shell' | 'computer' | 'files' | undefined {
  if (task.kind === 'computer') return 'computer';
  if (task.kind !== 'files') return 'shell';
  return task.files && PANEL_READS.has(task.files.op) ? undefined : 'files';
}
